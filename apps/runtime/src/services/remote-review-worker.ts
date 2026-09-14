import type { Database } from '@gcr/db';
import type { FilesystemArtifactStore } from '@gcr/artifact-store';
import {
  restoreRemoteReviewSource,
  restoreRemoteReviewContext,
  resolveLocalExecutionPolicy,
  runLocalReview,
  type LocalReviewContext,
  type LocalReviewExecutor,
} from '@gcr/client-core';
import type { AppConfig } from '../config.js';
import { ClientCredentialError } from '../auth/client-credentials.js';
import type { AuthorizationService } from './authorization.js';
import { resolveChatAccountSelection } from './account-registry.js';
import {
  CentralReviewExecutorError,
  createCentralReviewExecutor,
} from './central-review-executor.js';
import { remoteReviewContextAuthority } from './remote-review-context.js';
import { ModelCapacityError, withModelBudget, type ModelBudget } from './model-admission.js';
import { RemoteReviewJobError } from './remote-review-jobs.js';
import {
  loadRemoteReviewPayload,
  heartbeatRemoteReviewJob,
  fenceRemoteReviewInvocation,
  completeRemoteReviewJob,
  deferRemoteReviewJob,
  settleRemoteReviewJob,
  type RemoteReviewClaim,
} from './remote-review-execution.js';

type Result = 'completed' | 'failed' | 'cancelled' | 'uncertain' | 'lost' | 'deferred';

/** Execute one claimed upload. All model requests use the registered account's admitted transport. */
export async function executeRemoteReviewJob(
  database: Database,
  config: AppConfig,
  authorization: AuthorizationService,
  artifacts: FilesystemArtifactStore,
  claim: RemoteReviewClaim,
  options: {
    signal?: AbortSignal;
    /** Application/test dependency, never a client-supplied executor. */
    resolveAccount?: typeof resolveChatAccountSelection;
  } = {},
): Promise<Result> {
  const started = performance.now();
  const controller = new AbortController();
  const stop = () => controller.abort('worker-stopping');
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  let source: ReturnType<typeof restoreRemoteReviewSource> | undefined;
  let context: LocalReviewContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTask: Promise<void> | undefined;
  let heartbeatError: unknown;
  let executorError: unknown;
  let modelTask: Promise<unknown> | undefined;
  let modelSettled = true;
  let closed = false;
  const heartbeat = async () => {
    await heartbeatRemoteReviewJob(database, config, authorization, claim);
    if (context?.validUntil && context.validUntil <= new Date().toISOString())
      throw Error('context-expired');
    if (context?.central && (await context.observeCentralSnapshot()) !== 'current')
      throw Error('context-changed');
  };
  const interval = setInterval(() => {
    if (closed || heartbeatTask) return;
    heartbeatTask = heartbeat()
      .catch((error: unknown) => {
        heartbeatError = error;
        controller.abort('ownership-or-authorization-lost');
      })
      .finally(() => {
        heartbeatTask = undefined;
      });
  }, 2000);
  const drain = async () => {
    if (!modelTask || modelSettled) return true;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        modelTask.catch(() => undefined),
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, 5000);
        }),
      ]);
      return modelSettled;
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  };
  try {
    controller.signal.throwIfAborted();
    const payload = await loadRemoteReviewPayload(database, config, authorization, claim);
    const remaining = Math.max(1, payload.budget.durationMs - (performance.now() - started));
    timer = setTimeout(() => controller.abort('timeout'), remaining);
    source = restoreRemoteReviewSource(payload);
    const resolution = await restoreRemoteReviewContext(payload, {
      authority: remoteReviewContextAuthority(database, artifacts, config.KNOWLEDGE_SERVER_ID!),
    });
    if (resolution.status !== 'ready')
      throw new RemoteReviewJobError(422, 'REMOTE_REVIEW_CONTEXT_UNAVAILABLE');
    context = resolution.context;
    await heartbeat();
    controller.signal.throwIfAborted();
    const selection = await (options.resolveAccount ?? resolveChatAccountSelection)(
      database,
      config,
      payload.audience.userId,
      payload.model.accountId,
      payload.model.name,
      payload.model.reasoningEffort,
      Math.max(1, Math.floor(payload.budget.durationMs - (performance.now() - started))),
    );
    if (
      !selection ||
      selection.accountId !== payload.model.accountId ||
      selection.modelName !== payload.model.name ||
      selection.reasoningEffort !== payload.model.reasoningEffort
    )
      throw new RemoteReviewJobError(403, 'REMOTE_REVIEW_ACCOUNT_DENIED');
    controller.signal.throwIfAborted();
    const delegate = createCentralReviewExecutor(selection, {
      version: '1',
      modelCalls: payload.budget.modelCalls,
      ...(payload.budget.outputTokensPerCall === undefined
        ? {}
        : { outputTokensPerCall: payload.budget.outputTokensPerCall }),
    });
    const executor: LocalReviewExecutor = {
      descriptor: delegate.descriptor,
      review(input) {
        modelSettled = false;
        const task = delegate
          .review(input)
          .catch((error: unknown) => {
            executorError = error;
            throw error;
          })
          .finally(() => {
            modelSettled = true;
          });
        modelTask = task;
        let abort: (() => void) | undefined;
        const interrupted = new Promise<never>((_, reject) => {
          abort = () => reject(Error('remote_review_aborted'));
          input.signal!.addEventListener('abort', abort, { once: true });
          if (input.signal!.aborted) abort();
        });
        return Promise.race([task, interrupted]).finally(() => {
          if (abort) input.signal!.removeEventListener('abort', abort);
        });
      },
    };
    const policy = resolveLocalExecutionPolicy({
      snapshot: source,
      context: resolution,
      executor: executor.descriptor,
      workspaceTrusted: true,
      approval: {
        client: payload.client,
        sourceHash: source.identity.hash,
        executor: executor.descriptor,
        paths: ['**'],
        allowRelated: true,
        allowBase: true,
        allowKnowledge: true,
      },
      budget: {
        ...payload.budget,
        durationMs: Math.max(
          1,
          Math.floor(payload.budget.durationMs - (performance.now() - started)),
        ),
      },
    });
    if (policy.status !== 'ready')
      throw new RemoteReviewJobError(422, 'REMOTE_REVIEW_CONTEXT_UNAVAILABLE');
    const budget: ModelBudget = {
      runKey: `remote-review:${claim.id}`,
      maxCalls: payload.budget.modelCalls,
      wait: false,
      lane: 'interactive',
      beforeSend: async () => {
        controller.signal.throwIfAborted();
        if (context!.validUntil && context!.validUntil <= new Date().toISOString())
          throw Error('context-expired');
        if (context!.central && (await context!.observeCentralSnapshot()) !== 'current')
          throw Error('context-changed');
        await fenceRemoteReviewInvocation(database, config, authorization, claim);
        budget.wait = true; // Further turns may wait within this execution; never replay its prior turns.
      },
    };
    const report = await withModelBudget(budget, () =>
      runLocalReview({
        snapshot: source!,
        context: context!,
        policy: policy.policy,
        executor,
        signal: controller.signal,
      }),
    );
    if (
      executorError ||
      heartbeatError ||
      controller.signal.aborted ||
      ['failed', 'cancelled', 'unavailable', 'superseded'].includes(report.status)
    )
      throw (
        heartbeatError ??
        executorError ??
        new RemoteReviewJobError(
          422,
          report.problems.some((problem) => problem.code === 'invalid-output')
            ? 'REMOTE_REVIEW_INVALID_OUTPUT'
            : 'REMOTE_REVIEW_EXECUTION_FAILED',
        )
      );
    if (!(await drain())) throw Error('model-cleanup-unconfirmed');
    await heartbeat();
    controller.signal.throwIfAborted();
    await completeRemoteReviewJob(database, config, authorization, claim, report);
    return 'completed';
  } catch (error) {
    controller.abort('execution-ended');
    const drained = await drain();
    if (
      drained &&
      (error instanceof ModelCapacityError || options.signal?.aborted) &&
      (await deferRemoteReviewJob(
        database,
        claim,
        error instanceof ModelCapacityError ? error.resumeAfter : new Date(Date.now() + 1000),
      ))
    )
      return 'deferred';
    const code = error instanceof RemoteReviewJobError ? error.code : '';
    const knownBudget =
      error instanceof ModelCapacityError ||
      (error instanceof CentralReviewExecutorError && error.code === 'model-call-limit') ||
      (error instanceof Error &&
        ['model_call_budget_exhausted', 'model_input_budget_exhausted'].includes(error.message));
    const reason =
      error instanceof ClientCredentialError
        ? 'authorization-revoked'
        : code === 'REMOTE_REVIEW_ACCOUNT_DENIED'
          ? 'account-unavailable'
          : knownBudget
            ? 'budget-exhausted'
            : code === 'REMOTE_REVIEW_CONTEXT_UNAVAILABLE'
              ? 'context-unavailable'
              : code === 'REMOTE_REVIEW_INVALID_OUTPUT' ||
                  error instanceof CentralReviewExecutorError
                ? 'invalid-output'
                : 'model-failed';
    return await settleRemoteReviewJob(database, claim, {
      reason,
      drained,
      uncertain:
        !knownBudget &&
        !(error instanceof ClientCredentialError) &&
        !(error instanceof CentralReviewExecutorError) &&
        ![
          'REMOTE_REVIEW_ACCOUNT_DENIED',
          'REMOTE_REVIEW_INVALID_OUTPUT',
          'REMOTE_REVIEW_CONTEXT_UNAVAILABLE',
        ].includes(code),
    });
  } finally {
    closed = true;
    clearInterval(interval);
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', stop);
    source?.close();
  }
}
