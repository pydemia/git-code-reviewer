import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { localScope, reviewTrigger, type ReviewTrigger } from '@gcr/client-contract';
import {
  captureLocalSource,
  contentHash,
  defaultLocalDataDirectory,
  callLocalService,
  startLocalService,
  resolvePrePush,
  LocalServiceError,
  type ServiceJob,
  type ServiceRegistration,
  type ServiceReviewOptions,
  type CaptureSourceOptions,
} from '@gcr/client-core';
import { CliError } from './arguments.js';
import type { CliDependencies, CliResult, executeCli } from './cli.js';
type Parsed = { command: string; positionals: string[]; values: Record<string, unknown> };
export async function executeServiceCommand(
  parsed: Parsed,
  dependencies: CliDependencies,
  review: typeof executeCli,
): Promise<CliResult> {
  const { command, positionals, values } = parsed;
  const text = (key: string, fallback?: string) => {
    const value = values[key] ?? fallback;
    if (value !== undefined && (typeof value !== 'string' || !value))
      throw new CliError('usage', 'Expected one nonempty option value.');
    return value as string | undefined;
  };
  const many = (key: string) => {
    const value = values[key] ?? [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
      throw new CliError('usage', 'Expected repeatable string options.');
    return value as string[];
  };
  const number = (key: string, fallback: number) => {
    const raw = text(key);
    if (raw === undefined) return fallback;
    if (!/^[1-9][0-9]{0,8}$/.test(raw)) throw new CliError('usage', 'Expected a positive integer.');
    return Number(raw);
  };
  const profileId = text('profile', 'default')!,
    dataDirectory = path.resolve(text('data-dir', defaultLocalDataDirectory())!);
  localScope({ kind: 'profile', profileId });
  const location = { profileId, dataDirectory };
  const root = path.resolve(text('cwd', dependencies.cwd ?? process.cwd())!);
  const common = ['--profile', profileId, '--data-dir', dataDirectory];
  const registration = async () => {
    const row = (await callLocalService(location, {
      action: 'registration',
      root,
    })) as ServiceRegistration | null;
    if (!row) throw new LocalServiceError('service-denied');
    return row;
  };
  if (command === 'service') {
    if (positionals.length !== 1)
      throw new CliError(
        'usage',
        'Choose service start, run, status, stop, allow, revoke, registrations, job or cancel.',
      );
    const action = positionals[0];
    if (
      action !== 'allow' &&
      [
        'trigger',
        'executor-path',
        'model',
        'reasoning-effort',
        'exclude',
        'allow-path',
        'timeout-ms',
        'source-bytes',
        'tool-calls',
        'mode',
        'connection',
      ].some((k) => values[k] !== undefined)
    )
      throw new CliError('usage', 'Review settings are accepted only by service allow.');
    if (action === 'start') {
      try {
        return { value: await callLocalService(location, { action: 'status' }, 1000), exitCode: 0 };
      } catch (error) {
        if (!(error instanceof LocalServiceError) || error.code !== 'service-unavailable')
          throw error;
      }
      if (!dependencies.entrypoint || !path.isAbsolute(dependencies.entrypoint))
        throw new CliError('usage', 'Service start requires the installed CLI entrypoint.');
      const environment = { ...process.env };
      for (const key of Object.keys(environment))
        if (key.startsWith('GIT_')) delete environment[key];
      const child = spawn(
        process.execPath,
        [dependencies.entrypoint, 'service', 'run', ...common],
        { cwd: os.homedir(), env: environment, detached: true, stdio: 'ignore' },
      );
      let failed = false;
      child.on('error', () => {
        failed = true;
      });
      child.unref();
      for (let attempt = 0; attempt < 50 && !failed; attempt++) {
        await delay(200);
        try {
          return {
            value: await callLocalService(location, { action: 'status' }, 1000),
            exitCode: 0,
          };
        } catch (error) {
          if (!(error instanceof LocalServiceError) || error.code !== 'service-unavailable')
            throw error;
        }
      }
      throw new LocalServiceError('service-unavailable');
    }
    if (action === 'run') {
      const service = await startLocalService({
        ...location,
        ...(dependencies.keys ? { keys: dependencies.keys } : {}),
        run: async (input) => {
          const options = input.registration.options;
          const args = [
            'review',
            '--cwd',
            input.registration.root,
            ...common,
            '--mode',
            options.mode,
            '--source',
            input.source.identity.kind,
            '--trigger',
            input.job.trigger,
            '--model',
            options.model,
            '--reasoning-effort',
            options.reasoningEffort,
            '--timeout-ms',
            String(options.durationMs),
            '--source-bytes',
            String(options.sourceBytes),
            '--tool-calls',
            String(options.toolCalls),
            ...(options.connectionId ? ['--connection', options.connectionId] : []),
            ...(options.executorPath ? ['--executor-path', options.executorPath] : []),
            ...options.allowPaths.flatMap((p) => ['--allow-path', p]),
          ];
          const result = await review(args, {
            ...dependencies,
            frozenSource: input.source,
            signal: input.signal,
          });
          const value = result.value as { runId?: string; status?: string };
          return {
            exitCode: result.exitCode,
            status: typeof value?.status === 'string' ? value.status : 'unavailable',
            ...(typeof value?.runId === 'string' ? { runId: value.runId } : {}),
          };
        },
      });
      const stop = () => {
        void service.close();
      };
      dependencies.signal?.addEventListener('abort', stop, { once: true });
      if (dependencies.signal?.aborted) stop();
      try {
        const stopped = await service.closed;
        return {
          value: { status: 'stopped', ...stopped },
          exitCode: stopped.problem ? 2 : 0,
        };
      } finally {
        dependencies.signal?.removeEventListener('abort', stop);
      }
    }
    if (action === 'allow') {
      const triggers = many('trigger').map((t) => reviewTrigger(t));
      if (!triggers.length)
        throw new CliError('usage', 'Allow requires explicit --trigger values.');
      const options: ServiceReviewOptions = {
        mode: text('mode', 'standalone') as ServiceReviewOptions['mode'],
        model: text('model', 'gpt-6-astra') as 'gpt-6-astra',
        reasoningEffort: text('reasoning-effort', 'xhigh') as 'xhigh',
        excludePatterns: many('exclude'),
        allowPaths: many('allow-path').length ? many('allow-path') : ['**'],
        durationMs: number('timeout-ms', 120000),
        sourceBytes: number('source-bytes', 1048576),
        toolCalls: number('tool-calls', 100),
        ...(text('executor-path') ? { executorPath: text('executor-path')! } : {}),
        ...(text('connection') ? { connectionId: text('connection')! } : {}),
      };
      return {
        value: await callLocalService(location, { action: 'register', root, triggers, options }),
        exitCode: 0,
      };
    }
    if (action === 'revoke') {
      const old = await registration();
      return {
        value: await callLocalService(location, {
          action: 'register',
          root,
          triggers: [],
          options: old.options,
        }),
        exitCode: 0,
      };
    }
    if (['status', 'stop', 'registrations', 'job', 'cancel'].includes(action!)) {
      const id = text('id');
      if (['job', 'cancel'].includes(action!) && !id)
        throw new CliError('usage', 'A job ID is required.');
      return {
        value: await callLocalService(location, { action, ...(id ? { id } : {}) }),
        exitCode: 0,
      };
    }
    throw new CliError('usage', 'Unknown service action.');
  }
  if (positionals.length) throw new CliError('usage', 'Unexpected positional arguments.');
  if (values.mode !== undefined || values.connection !== undefined)
    throw new CliError(
      'usage',
      'Enqueue uses the service registration, not caller-supplied execution settings.',
    );
  const reg = await registration();
  const id = text('request-id', randomUUID())!;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
    throw new CliError('usage', 'Request ID must be a UUID.');
  const submit = async (
    requestId: string,
    trigger: ReviewTrigger,
    capture: CaptureSourceOptions,
  ) => {
    if (!reg.triggers.includes(trigger)) throw new LocalServiceError('service-denied');
    const snapshot = captureLocalSource({
      ...capture,
      cwd: reg.root,
      excludePatterns: reg.options.excludePatterns,
    });
    try {
      const job = (await callLocalService(location, {
        action: 'submit',
        input: {
          id: requestId,
          repository: reg.key,
          registrationRevision: reg.revision,
          trigger,
          source: snapshot.freeze(),
        },
      })) as ServiceJob;
      return { id: job.id, state: job.state, sourceHash: job.sourceHash, trigger: job.trigger };
    } finally {
      snapshot.close();
    }
  };
  if (command === 'enqueue-push') {
    if (!dependencies.readStdin)
      throw new CliError('usage', 'enqueue-push requires pre-push stdin.');
    if (!reg.triggers.includes('push')) throw new LocalServiceError('service-denied');
    const plan = resolvePrePush(root, await dependencies.readStdin(), reg.options.excludePatterns);
    const refs = [];
    let incomplete = false;
    for (const ref of plan.refs) {
      if (ref.status !== 'ready' || !ref.capture) {
        refs.push(ref);
        if (ref.status === 'unsupported') incomplete = true;
        continue;
      }
      const digest = contentHash({ id, ref: ref.remoteRef });
      const requestId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
      try {
        refs.push({ ...ref, receipt: await submit(requestId, 'push', ref.capture) });
      } catch (error) {
        refs.push({
          ...ref,
          enqueueStatus: 'failed',
          error: error instanceof LocalServiceError ? error.code : 'source-unavailable',
        });
        incomplete = true;
      }
    }
    return {
      value: {
        status: incomplete ? 'incomplete' : 'accepted',
        requestId: id,
        reviewCompletion: 'not-awaited',
        refs,
      },
      exitCode: incomplete ? 2 : 0,
    };
  }
  const trigger = reviewTrigger(text('trigger', 'manual')),
    kind = text('source', trigger === 'save' ? 'working-tree' : 'index');
  if (!['index', 'working-tree', 'commit-tree'].includes(kind!))
    throw new CliError('usage', 'Unsupported source.');
  if (text('index-file') && kind !== 'index')
    throw new CliError('usage', 'An index file requires index source.');
  const capture: CaptureSourceOptions = {
    cwd: root,
    kind: kind as CaptureSourceOptions['kind'],
    ...(text('index-file') ? { indexFile: text('index-file')! } : {}),
    ...(text('source-commit') ? { sourceCommit: text('source-commit')! } : {}),
    ...(text('base-commit')
      ? { baseCommit: text('base-commit') === 'empty' ? null : text('base-commit')! }
      : {}),
    ...(text('target-branch') ? { targetBranch: text('target-branch')! } : {}),
    ...(many('path').length ? { paths: many('path') } : {}),
    includeUntracked: many('include-untracked'),
  };
  return {
    value: {
      status: 'accepted',
      reviewCompletion: 'not-awaited',
      receipt: await submit(id, trigger, capture),
    },
    exitCode: 0,
  };
}
