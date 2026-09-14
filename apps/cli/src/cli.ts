import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ContractError,
  reviewSubmission,
  offlineBehavior,
  localKnowledge,
  localScope,
  reviewExitCode,
  reviewTrigger,
  sourcePath,
  type LocalScope,
} from '@gcr/client-contract';
import {
  captureLocalSource,
  contentHash,
  ReviewSubmissionQueue,
  ReviewSubmissionQueueError,
  prepareReviewSubmission,
  restoreLocalSource,
  LocalServiceError,
  type FrozenLocalSource,
  resolvePrePush,
  defaultLocalDataDirectory,
  discoverLocalIdentity,
  LocalHistoryStore,
  ReviewConversationStore,
  ReviewConversationError,
  LocalKnowledgeStore,
  LocalRecordStore,
  LocalStoreError,
  ReviewRequests,
  ReviewRequestError,
  executeReviewRequest,
  resolveLocalContext,
  resolveCentralContext,
  CentralConnections,
  CentralConnectionSetupError,
  resolveReviewExecution,
  KnowledgeSyncError,
  type CentralCredentialStore,
  resolveLocalExecutionPolicy,
  resolveReviewMode,
  runLocalReview,
  SourceCaptureError,
  type LocalKeyStore,
  type LocalContextQuery,
  type LocalKnowledgeDraft,
  type LocalKnowledgeEdit,
  type LocalReviewExecutor,
  type LocalSourceSnapshot,
} from '@gcr/client-core';
import { ExecutorError, prepareCodexAccountExecutor } from '@gcr/client-executors';
import { argumentsFor, CliError, help } from './arguments.js';
import { PreparedReviews, type PreparedReview } from './prepared.js';
import { executeServiceCommand } from './service.js';
import { executeChat } from './chat.js';

export interface CliDependencies {
  cwd?: string;
  signal?: AbortSignal;
  keys?: LocalKeyStore;
  credentials?: CentralCredentialStore;
  prepareExecutor?:
    | typeof prepareCodexAccountExecutor
    | ((
        options: Parameters<typeof prepareCodexAccountExecutor>[0],
      ) => Promise<LocalReviewExecutor>);
  readStdin?: () => Promise<string>;
  /** Trusted service assembly ports; never selectable through CLI arguments. */
  frozenSource?: FrozenLocalSource;
  entrypoint?: string;
  serviceStartLimits?: { maximumReviewsPerHour: number };
}
export interface CliResult {
  value: unknown;
  exitCode: 0 | 1 | 2;
  diagnostics?: unknown[];
  text?: boolean;
}
async function jsonInput(file: string, readStdin?: () => Promise<string>): Promise<unknown> {
  let text: string;
  if (file === '-') {
    if (!readStdin) throw new CliError('usage', 'JSON input requires a file or piped stdin.');
    text = await readStdin();
  } else {
    const handle = await open(
      path.resolve(file),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 2_000_000)
        throw new CliError('invalid-input', 'Input must be a regular JSON file of at most 2 MB.');
      const buffer = Buffer.alloc(2_000_001);
      let offset = 0;
      while (offset < buffer.length) {
        const read = await handle.read(buffer, offset, buffer.length - offset, null);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      if (offset > 2_000_000) throw new CliError('invalid-input', 'JSON input exceeds 2 MB.');
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
    } finally {
      await handle.close();
    }
  }
  if (Buffer.byteLength(text) > 2_000_000)
    throw new CliError('invalid-input', 'JSON input exceeds 2 MB.');
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError('invalid-input', 'Input is not valid JSON.');
  }
}

/** Application assembly only; injected test ports are never selectable from argv or repository config. */
export async function executeCli(
  argv: string[],
  dependencies: CliDependencies = {},
): Promise<CliResult> {
  const opened: Array<{ close(): void }> = [];
  let snapshot: LocalSourceSnapshot | undefined;
  try {
    if (dependencies.signal?.aborted)
      return {
        value: {
          status: 'cancelled',
          error: { code: 'cancelled', message: 'Command was cancelled before execution.' },
        },
        exitCode: 2,
      };
    const { command, values, positionals } = argumentsFor(argv);
    if (command === 'help' || values.help) return { value: help, exitCode: 0, text: true };
    if (command === 'mcp')
      throw new CliError('stdio-required', 'Start MCP using the gcr executable.');
    if (['service', 'enqueue', 'enqueue-push'].includes(command))
      return await executeServiceCommand(
        { command, values, positionals },
        dependencies,
        executeCli,
      );
    const string = (name: string, fallback?: string): string | undefined => {
      const value = values[name];
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || !value)
        throw new CliError('usage', 'Option requires one nonempty string.');
      return value;
    };
    const many = (name: string): string[] => (values[name] as string[] | undefined) ?? [];
    const number = (name: string): number | undefined => {
      const value = string(name);
      if (value === undefined) return undefined;
      if (!/^[1-9][0-9]{0,11}$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new CliError('usage', 'Numeric options require a positive integer.');
      return Number(value);
    };
    const mode = resolveReviewMode({ mode: string('mode', 'standalone') });
    const behavior =
      values['offline-behavior'] === undefined
        ? undefined
        : offlineBehavior(string('offline-behavior'));
    const central = mode.mode === 'centralized';
    if (central && command !== 'central' && !string('connection'))
      return {
        value: {
          status: 'unavailable',
          ...mode,
          problems: [
            {
              code: 'policy-unavailable',
              message: 'Centralized review requires an explicit --connection ID.',
            },
          ],
        },
        exitCode: 2,
      };
    if (
      (!central &&
        (command === 'central' ||
          string('connection') ||
          values.offline ||
          values['offline-behavior'])) ||
      (central &&
        ![
          'central',
          'status',
          'context',
          'prepare',
          'read-source',
          'get-rule',
          'submit-review',
          'feedback',
          'review',
          'push-review',
          'history',
          'result',
          'chat',
        ].includes(command))
    )
      throw new CliError(
        'usage',
        'Central operations require --mode centralized and a supported central command.',
      );
    const cwd = path.resolve(string('cwd', dependencies.cwd ?? process.cwd())!);
    const profileId = string('profile', 'default')!;
    const dataDirectory = path.resolve(string('data-dir', defaultLocalDataDirectory())!);
    localScope({ kind: 'profile', profileId });
    const knowledgeCommand = command === 'memory' || command === 'skill';
    const scopeKind = string('scope', 'repository');
    if (!['profile', 'repository'].includes(scopeKind!))
      throw new CliError('usage', 'Scope must be profile or repository.');
    const client =
      knowledgeCommand && scopeKind === 'profile'
        ? undefined
        : discoverLocalIdentity(cwd, profileId);
    const repositoryScope: LocalScope | undefined = client
      ? {
          kind: 'repository',
          profileId,
          repositoryKey: client.repositoryKey,
          worktreeKey: client.worktreeKey,
        }
      : undefined;
    const stores = new Map<string, LocalRecordStore>();
    const records = async (scope: LocalScope) => {
      if (stores.has(scope.kind)) return stores.get(scope.kind)!;
      const value = await LocalRecordStore.open({
        scope,
        dataDirectory,
        ...(dependencies.keys ? { keys: dependencies.keys } : {}),
      });
      opened.push(value);
      stores.set(scope.kind, value);
      return value;
    };
    let connections: CentralConnections | undefined;
    const centralConnections = async () => {
      if (!connections) {
        connections = await CentralConnections.open({
          scope: repositoryScope!,
          dataDirectory,
          ...(dependencies.keys ? { keys: dependencies.keys } : {}),
          ...(dependencies.credentials ? { credentials: dependencies.credentials } : {}),
        });
        opened.push(connections);
      }
      return connections;
    };
    if (command === 'central') {
      const [action, ...extra] = positionals;
      if (
        extra.length ||
        !['connect', 'list', 'status', 'sync', 'disconnect'].includes(action ?? '')
      )
        throw new CliError('usage', 'Unknown central action.');
      if (action === 'connect') {
        const input = string('input');
        if (
          !input ||
          input === '-' ||
          !values['api-key-stdin'] ||
          string('connection') ||
          !dependencies.readStdin
        )
          throw new CliError(
            'usage',
            'Connect requires a public configuration file and --api-key-stdin.',
          );
        const config = await jsonInput(input);
        const secret = (await dependencies.readStdin()).trim();
        if (secret.length > 256) throw new CliError('invalid-input', 'Invalid API key input.');
        return {
          value: await (
            await centralConnections()
          ).connect(config, secret, 'gcr-cli', dependencies.signal, {
            offlineBehavior: behavior ?? 'cache-then-standalone',
          }),
          exitCode: 0,
        };
      }
      if (string('input') || values['api-key-stdin'] || values['offline-behavior'])
        throw new CliError('usage', 'Only connect accepts configuration and key input.');
      if (action === 'list') {
        if (string('connection'))
          throw new CliError('usage', 'List does not accept a connection ID.');
        return { value: await (await centralConnections()).list(), exitCode: 0 };
      }
      const id = string('connection');
      if (!id) throw new CliError('usage', 'Specify --connection for this action.');
      const manager = await centralConnections();
      if (action === 'disconnect') return { value: await manager.disconnect(id), exitCode: 0 };
      if (action === 'sync')
        return { value: await manager.synchronize(id, dependencies.signal), exitCode: 0 };
      const status = await manager.status(id);
      return { value: status, exitCode: status.cache.status === 'ready' ? 0 : 2 };
    }
    const prepare = () =>
      (dependencies.prepareExecutor ?? prepareCodexAccountExecutor)({
        ...(string('executor-path') ? { executablePath: string('executor-path')! } : {}),
        model: string('model', 'gpt-6-astra')!,
        reasoningEffort: string('reasoning-effort', 'xhigh')!,
      });
    if (knowledgeCommand) {
      const [action, id, ...extra] = positionals;
      const noId = ['list', 'create', 'import'].includes(action ?? '');
      if (
        !action ||
        extra.length ||
        (noId ? id !== undefined : !id) ||
        ![
          'list',
          'show',
          'create',
          'edit',
          'activate',
          'deactivate',
          'archive',
          'delete',
          'import',
          'export',
        ].includes(action)
      )
        throw new CliError('usage', 'Invalid knowledge command. Run gcr --help.');
      const needsInput = ['create', 'edit', 'import'].includes(action);
      const needsRevision = ['edit', 'activate', 'deactivate', 'archive', 'delete'].includes(
        action,
      );
      if (
        needsInput !== !!string('input') ||
        needsRevision !== !!number('revision') ||
        (action === 'export') !== !!string('output')
      )
        throw new CliError(
          'usage',
          'This action requires only its documented input, output and revision options.',
        );
      const scope =
        scopeKind === 'profile' ? { kind: 'profile' as const, profileId } : repositoryScope!;
      const store = new LocalKnowledgeStore(await records(scope));
      const current = id ? await store.get(id) : undefined;
      if (id && (!current || current.kind !== command))
        throw new CliError('not-found', 'Knowledge item was not found in this scope and kind.');
      let value: unknown;
      if (action === 'list') value = (await store.list()).filter((item) => item.kind === command);
      else if (action === 'show') value = current;
      else if (action === 'export') {
        await store.exportFile(id!, path.resolve(string('output')!));
        value = { status: 'exported', path: path.resolve(string('output')!) };
      } else if (action === 'delete') value = await store.remove(id!, number('revision')!);
      else if (['activate', 'deactivate', 'archive'].includes(action))
        value = await store.setState(
          id!,
          number('revision')!,
          ({ activate: 'active', deactivate: 'inactive', archive: 'archived' } as const)[
            action as 'activate'
          ],
        );
      else {
        const input = await jsonInput(string('input')!, dependencies.readStdin);
        if (action === 'import') {
          if (localKnowledge(input).kind !== command)
            throw new CliError(
              'invalid-input',
              'Exported knowledge kind does not match the command.',
            );
          value = await store.importKnowledge(input);
        } else if (action === 'edit')
          value = await store.edit(id!, number('revision')!, input as LocalKnowledgeEdit);
        else {
          if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new CliError('invalid-input', 'Create input must be a JSON object.');
          const fields = input as Record<string, unknown>;
          if (typeof fields.title !== 'string' || typeof fields.body !== 'string')
            throw new CliError('invalid-input', 'Create input requires title and body strings.');
          if (
            Object.keys(fields).some(
              (key) =>
                ![
                  'title',
                  'body',
                  'appliesTo',
                  'expiresAt',
                  ...(command === 'memory' ? ['rationale', 'counterEvidence'] : []),
                ].includes(key),
            )
          )
            throw new CliError('invalid-input', 'Create input contains unsupported fields.');
          const draft = {
            kind: command,
            appliesTo: { paths: [], languages: [], symbols: [], branches: [] },
            sources: [{ kind: 'user-note', id: randomUUID() }],
            ...(command === 'memory'
              ? { rationale: '', counterEvidence: [] }
              : { reviewOnly: true, origin: 'user-authored' }),
            ...fields,
            title: fields.title,
            body: fields.body,
          } as LocalKnowledgeDraft;
          value = await store.create(draft);
        }
      }
      return { value, exitCode: 0 };
    }
    if (
      !['submit-review', 'feedback', 'chat'].includes(command) &&
      positionals.length !== (command === 'result' ? 1 : 0)
    )
      throw new CliError('usage', 'Unexpected positional arguments.');
    if (command === 'status' && central) {
      const status = await (await centralConnections()).status(string('connection')!);
      return {
        value: {
          ...status,
          mode: 'centralized',
          executor: values['check-executor']
            ? (await prepare()).descriptor
            : { status: 'not-checked' },
        },
        exitCode: status.cache.status === 'ready' ? 0 : 2,
      };
    }
    if (command === 'status')
      return {
        value: {
          status: 'ready',
          ...mode,
          client,
          dataDirectory,
          executor: values['check-executor']
            ? (await prepare()).descriptor
            : { status: 'not-checked', model: 'gpt-6-astra', reasoningEffort: 'xhigh' },
          storage: 'not-opened',
          triggers: ['manual', 'work_completed', 'save', 'stage', 'commit', 'push'],
          execution: 'foreground-or-explicit-service',
          backgroundService: 'not-checked',
        },
        exitCode: 0,
      };
    const requestStorage = {
      scope: repositoryScope!,
      dataDirectory,
      ...(dependencies.keys ? { keys: dependencies.keys } : {}),
    };
    if (command === 'requests') {
      const requests = await ReviewRequests.open(requestStorage);
      try {
        return { value: await requests.list(), exitCode: 0 };
      } finally {
        requests.close();
      }
    }
    if (command === 'chat') {
      const [action, reportId, ...extra] = positionals;
      if (
        !action ||
        !reportId ||
        extra.length ||
        (action === 'read' ? !!string('input') : !string('input'))
      )
        throw new CliError(
          'usage',
          'Use chat ACTION RUN_ID; actions other than read require --input JSON.',
        );
      return await executeChat(
        {
          action,
          reportId,
          ...(string('input')
            ? { body: await jsonInput(string('input')!, dependencies.readStdin) }
            : {}),
          cwd,
          profileId,
          dataDirectory,
          mode: mode.mode,
          ...(string('connection') ? { connectionId: string('connection')! } : {}),
          offline: values.offline === true,
          ...(behavior ? { offlineBehavior: behavior } : {}),
          executorPath: string('executor-path', 'codex')!,
          model: string('model', 'gpt-6-astra')!,
          reasoningEffort: string('reasoning-effort', 'xhigh')!,
          allowPaths: many('allow-path'),
          ...(number('timeout-ms') ? { timeoutMs: number('timeout-ms')! } : {}),
        },
        dependencies,
      );
    }
    const conversations = new WeakMap<LocalHistoryStore, ReviewConversationStore>();
    const historyStore = async (isCentral: boolean): Promise<LocalHistoryStore> => {
      if (!isCentral) {
        const local = await records(repositoryScope!);
        const history = new LocalHistoryStore(local);
        conversations.set(history, new ReviewConversationStore(local));
        return history;
      }
      const identity = await (await centralConnections()).historyIdentity(string('connection')!);
      const centralRecords = await LocalRecordStore.open({
        scope: repositoryScope!,
        dataDirectory: path.join(dataDirectory, 'central-review-history', identity.id),
        ...(dependencies.keys ? { keys: dependencies.keys } : {}),
      });
      opened.push(centralRecords);
      const history = new LocalHistoryStore(centralRecords, undefined, identity.audience);
      conversations.set(
        history,
        new ReviewConversationStore(centralRecords, undefined, identity.audience),
      );
      return history;
    };
    if (command === 'submit-review' || command === 'feedback') {
      if (!central)
        throw new CliError('usage', 'Submission requires an explicit central connection.');
      const [action, id, ...extra] = positionals;
      const kind = command === 'feedback' ? 'feedback' : 'result';
      if (
        extra.length ||
        !['preview', 'queue', 'send', 'show', 'cancel', 'list'].includes(action ?? '') ||
        (['preview', 'send', 'show', 'cancel'].includes(action ?? '') ? !id : id !== undefined)
      )
        throw new CliError('usage', 'Invalid submission action.');
      if (
        (action === 'queue') !== !!string('confirm-hash') ||
        (values['retry-rejected'] && action !== 'send') ||
        (string('input') && !['queue', 'preview'].includes(action!))
      )
        throw new CliError('usage', 'Submission options do not match the action.');
      const manager = await centralConnections();
      if (action === 'preview') {
        const report =
          (await (await historyStore(true)).getReview(id!)) ??
          (await (await historyStore(false)).getReview(id!));
        if (!report) throw new CliError('not-found', 'Saved review was not found.');
        let selection: Parameters<typeof prepareReviewSubmission>[0]['selection'] = {
          kind: 'result',
        };
        if (kind === 'feedback') {
          if (!string('input'))
            throw new CliError('usage', 'Feedback preview requires an explicit selection JSON.');
          const input = (await jsonInput(string('input')!, dependencies.readStdin)) as Record<
            string,
            unknown
          >;
          if (
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            Object.keys(input).some(
              (k) =>
                !['feedbackKind', 'message', 'findingId', 'includeSourceReference'].includes(k),
            ) ||
            !['correction', 'exception', 'judgment'].includes(String(input.feedbackKind)) ||
            typeof input.message !== 'string' ||
            (input.findingId !== undefined && typeof input.findingId !== 'string') ||
            (input.includeSourceReference !== undefined &&
              typeof input.includeSourceReference !== 'boolean')
          )
            throw new CliError('invalid-input', 'Invalid explicit feedback selection.');
          selection = { kind: 'feedback', ...input } as Extract<
            Parameters<typeof prepareReviewSubmission>[0]['selection'],
            { kind: 'feedback' }
          >;
        } else if (string('input'))
          throw new CliError('usage', 'Result preview does not accept input.');
        const { submission: payload, payloadHash } = prepareReviewSubmission({
          report,
          selection,
          id: randomUUID(),
          audience: (await manager.historyIdentity(string('connection')!)).audience,
          clientId: 'gcr-cli',
          approvedAt: new Date().toISOString(),
        });
        return {
          value: {
            status: 'confirmation-required',
            payload,
            payloadHash,
            uploaded: false,
          },
          exitCode: 0,
        };
      }
      const queue = await ReviewSubmissionQueue.open({
        ...requestStorage,
        connectionId: string('connection')!,
        connections: manager,
      });
      opened.push(queue);
      if (action === 'list')
        return {
          value: (await queue.list()).filter((x) => x.value.payload.kind === kind),
          exitCode: 0,
        };
      if (action === 'queue') {
        if (!string('input')) throw new CliError('usage', 'Queue requires confirmed payload JSON.');
        const payload = reviewSubmission(await jsonInput(string('input')!, dependencies.readStdin));
        if (payload.kind !== kind)
          throw new CliError('invalid-input', 'Submission kind does not match this command.');
        return { value: await queue.enqueue(payload, string('confirm-hash')!), exitCode: 0 };
      }
      const row = await queue.get(id!);
      if (row.value.payload.kind !== kind)
        throw new CliError('invalid-input', 'Submission kind does not match this command.');
      if (action === 'show') return { value: row, exitCode: 0 };
      if (action === 'cancel') return { value: await queue.cancel(id!), exitCode: 0 };
      const sent = await queue.send(id!, dependencies.signal, values['retry-rejected'] === true);
      return { value: sent, exitCode: sent.value.status === 'submitted' ? 0 : 2 };
    }
    if (command === 'result' || command === 'history') {
      let history: LocalHistoryStore | undefined;
      let denied: unknown;
      try {
        history = await historyStore(central);
      } catch (cause) {
        if (
          !(cause instanceof KnowledgeSyncError) ||
          !['authentication-required', 'revoked', 'disabled'].includes(cause.code)
        )
          throw cause;
        denied = cause;
      }
      const fallbackHistory = central ? await historyStore(false) : undefined;
      const isFallback = (report: import('@gcr/client-contract').ClientReviewReport) =>
        report.identity.client.mode === 'standalone' &&
        report.identity.client.execution?.connectionId === string('connection');
      if (command === 'result') {
        let report = await history?.getReview(positionals[0]!);
        if (!report && fallbackHistory) {
          const local = await fallbackHistory.getReview(positionals[0]!);
          if (local && isFallback(local)) report = local;
        }
        if (!report) {
          if (denied) throw denied;
          throw new CliError('not-found', 'Review was not found in this profile and worktree.');
        }
        return { value: report, exitCode: reviewExitCode(report) };
      }
      const reports = [
        ...((await history?.listReviews()) ?? []),
        ...(fallbackHistory ? (await fallbackHistory.listReviews()).filter(isFallback) : []),
      ].sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
      if (!reports.length && denied) throw denied;
      return {
        value: reports.map((report) => ({
          runId: report.runId,
          status: report.status,
          finishedAt: report.finishedAt,
          summary: report.summary,
          sourceHash: report.identity.source.hash,
          findings: report.findings.length,
          questions: report.questions.length,
          execution: report.identity.client.execution ?? null,
          exitCode: reviewExitCode(report),
        })),
        exitCode: 0,
      };
    }
    if (command === 'push-review') {
      if (!dependencies.readStdin)
        throw new CliError('usage', 'push-review requires the complete pre-push stream on stdin.');
      const plan = resolvePrePush(cwd, await dependencies.readStdin(), many('exclude'));
      const inherited = Object.entries(values).flatMap(([key, value]) =>
        value === undefined || value === false
          ? []
          : value === true
            ? [`--${key}`]
            : (Array.isArray(value) ? value : [value]).flatMap((item) => [
                `--${key}`,
                String(item),
              ]),
      );
      const results = [];
      let exitCode: 0 | 1 | 2 = 0;
      for (const ref of plan.refs) {
        if (ref.status !== 'ready' || !ref.capture) {
          results.push(ref);
          if (ref.status === 'unsupported') exitCode = 2;
          continue;
        }
        const capture = ref.capture;
        const result = await executeCli(
          [
            'review',
            ...inherited,
            '--source',
            'commit-tree',
            '--source-commit',
            capture.sourceCommit!,
            '--base-commit',
            capture.baseCommit ?? 'empty',
            '--trigger',
            'push',
            ...(capture.targetBranch ? ['--target-branch', capture.targetBranch] : []),
          ],
          dependencies,
        );
        results.push({
          ...ref,
          review: result.value,
          exitCode: result.exitCode,
          diagnostics: result.diagnostics ?? [],
        });
        exitCode = Math.max(exitCode, result.exitCode) as 0 | 1 | 2;
      }
      return {
        value: {
          status: exitCode === 2 ? 'incomplete' : 'processed',
          objectFormat: plan.objectFormat,
          refs: results,
        },
        exitCode,
      };
    }
    let prepared: PreparedReview | undefined;
    let preparations: PreparedReviews | undefined;
    if (command === 'prepare' || string('prepared')) {
      preparations = await PreparedReviews.open(requestStorage);
      opened.push(preparations);
    }
    if (string('prepared')) {
      if (
        dependencies.frozenSource ||
        [
          'source',
          'base',
          'index-file',
          'source-commit',
          'base-commit',
          'target-branch',
          'path',
          'include-untracked',
          'exclude',
          'require-source',
          'require-knowledge',
        ].some((k) => values[k] !== undefined)
      )
        throw new CliError(
          'usage',
          'Prepared reviews cannot replace source or context selection options.',
        );
      prepared = await preparations!.get(string('prepared')!);
      if (prepared.mode !== mode.mode || prepared.connectionId !== (string('connection') ?? null))
        throw new CliError(
          'prepared-scope-mismatch',
          'Use the original mode and connection for this prepared review.',
        );
    }
    if (['read-source', 'get-rule'].includes(command) && !prepared)
      throw new CliError('usage', 'This command requires --prepared.');
    const kind = prepared?.source.identity.kind ?? string('source', 'index');
    if (kind !== 'index' && kind !== 'working-tree' && kind !== 'commit-tree')
      throw new CliError('usage', 'Source must be index, working-tree or commit-tree.');
    const trigger = reviewTrigger(string('trigger', 'manual'));
    if (string('index-file') && kind !== 'index')
      throw new CliError('usage', 'An alternate index requires index source.');
    if (
      (trigger === 'commit' && kind !== 'index') ||
      (trigger === 'push' && kind !== 'commit-tree') ||
      (trigger === 'stage' && kind !== 'index') ||
      (trigger === 'save' && kind !== 'working-tree')
    )
      throw new CliError(
        'usage',
        'Commit reviews require index source; push reviews require exact commit-tree source.',
      );
    snapshot = prepared
      ? restoreLocalSource(prepared.source)
      : dependencies.frozenSource
        ? restoreLocalSource(dependencies.frozenSource)
        : captureLocalSource({
            cwd,
            kind,
            ...(string('base') ? { baseRef: string('base')! } : {}),
            ...(string('source-commit') ? { sourceCommit: string('source-commit')! } : {}),
            ...(string('base-commit')
              ? { baseCommit: string('base-commit') === 'empty' ? null : string('base-commit')! }
              : {}),
            ...(string('target-branch') ? { targetBranch: string('target-branch')! } : {}),
            ...(string('index-file') ? { indexFile: string('index-file')! } : {}),
            ...(many('path').length ? { paths: many('path') } : {}),
            includeUntracked: many('include-untracked'),
            excludePatterns: many('exclude'),
          });
    if (
      snapshot.identity.kind !== kind ||
      snapshot.repository.repositoryKey !== client!.repositoryKey ||
      snapshot.repository.worktreeKey !== client!.worktreeKey
    )
      throw new CliError(
        'source-scope-mismatch',
        'The stored source does not match this repository and worktree.',
      );
    const contextInput: LocalContextQuery = {
      client: client!,
      snapshot,
      stores: [
        new LocalKnowledgeStore(await records(repositoryScope!)),
        new LocalKnowledgeStore(await records({ kind: 'profile', profileId })),
      ],
      requiredKnowledgeIds: prepared?.requiredKnowledge ?? many('require-knowledge'),
      requiredSources: (prepared?.requiredSource ?? many('require-source')).map((value) => {
        const index = value.indexOf(':');
        const side = value.slice(0, index);
        if (index < 0 || (side !== 'source' && side !== 'base'))
          throw new CliError('usage', 'Required source must use source:path or base:path.');
        return { side, path: sourcePath(value.slice(index + 1)) };
      }),
    };
    const connectionStatus = central
      ? await (await centralConnections()).status(string('connection')!)
      : undefined;
    if (connectionStatus && connectionStatus.clientId !== 'gcr-cli')
      throw new KnowledgeSyncError('invalid-binding', 'Choose a GCR CLI connection.');
    const execution = await resolveReviewExecution({
      client: client!,
      configuredMode: mode.mode,
      offlineBehavior: behavior ?? connectionStatus?.offlineBehavior ?? 'pause',
      ...(central
        ? {
            connectionId: string('connection')!,
            freshness: values.offline ? ('offline' as const) : ('online' as const),
            central: async (freshness) =>
              (await centralConnections()).review(
                string('connection')!,
                freshness,
                dependencies.signal,
              ),
          }
        : {}),
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    });
    const connection = execution.central;
    const context = connection
      ? await resolveCentralContext({ ...contextInput, ...connection })
      : await resolveLocalContext({ ...contextInput, client: execution.client });
    if (
      prepared &&
      (!context.context ||
        context.context.identity.hash !== prepared.contextHash ||
        contentHash(context.context.client) !== prepared.clientHash)
    )
      throw new CliError(
        'prepared-context-changed',
        'Applicable context or authority changed. Prepare and confirm a new review.',
      );
    if (context.context && (await context.context.observeCentralSnapshot()) !== 'current')
      throw new CliError(
        'prepared-context-changed',
        'Central context changed or is being synchronized.',
      );
    if (command === 'prepare') {
      if (context.status !== 'ready')
        return { value: { status: context.status, problems: context.problems }, exitCode: 2 };
      const saved = await preparations!.save({
        source: snapshot.freeze(),
        contextHash: context.context.identity.hash,
        clientHash: contentHash(context.context.client),
        mode: mode.mode,
        connectionId: string('connection') ?? null,
        requiredKnowledge: many('require-knowledge'),
        requiredSource: many('require-source'),
      });
      return {
        value: {
          status: 'prepared',
          preparedId: saved.id,
          expiresAt: saved.expiresAt,
          source: snapshot.identity,
          context: context.context.identity,
          selected: snapshot.selected,
          sourceFiles: snapshot.sourceFiles,
          limitations: snapshot.limitations,
          diff: snapshot.diff,
          modelExecuted: false,
        },
        exitCode: 0,
      };
    }
    if (command === 'read-source') {
      const file = string('file'),
        side = string('side', 'source');
      if (!file || !['source', 'base'].includes(side!))
        throw new CliError('usage', 'Specify a source path and source/base side.');
      const result = snapshot.readLines(
        file,
        side as 'source' | 'base',
        number('start-line') ?? 1,
        number('end-line'),
      );
      return { value: result, exitCode: result.status === 'available' ? 0 : 2 };
    }
    if (command === 'get-rule') {
      const id = string('id'),
        revision = number('revision');
      if (!id) throw new CliError('usage', 'Specify --id for the selected rule.');
      const matches = [
        ...(context.context?.central?.items ?? []),
        ...(context.context?.knowledge ?? []),
        ...(context.context?.builtin ? [context.context.builtin] : []),
      ].filter((x) => x.id === id && (revision === undefined || x.revision === revision));
      if (matches.length !== 1)
        throw new CliError('not-found', 'An unambiguous selected rule was not found.');
      return { value: matches[0], exitCode: 0 };
    }
    if (command === 'context')
      return {
        value: {
          status: context.status,
          problems: context.problems,
          client: context.context?.client ?? execution.client,
          ...(connection ? { freshness: connection.freshness } : {}),
          source: snapshot.identity,
          selected: snapshot.selected,
          sourceFiles: snapshot.sourceFiles,
          limitations: snapshot.limitations,
          ...(context.context
            ? {
                context: context.context.identity,
                omissions: context.context.omissions,
                knowledgeBytes: context.context.bytes,
                ...(values['include-knowledge']
                  ? {
                      knowledge: {
                        local: context.context.knowledge,
                        builtin: context.context.builtin,
                        central: context.context.central,
                      },
                    }
                  : {}),
              }
            : {}),
        },
        exitCode: context.status === 'ready' ? 0 : 2,
      };
    if (context.status !== 'ready')
      return {
        value: { status: context.status, problems: context.problems, source: snapshot.identity },
        exitCode: 2,
      };
    const history = await historyStore(execution.client.mode === 'centralized');
    const executor = await prepare();
    const budget = Object.fromEntries(
      [
        ['durationMs', number('timeout-ms')],
        ['sourceBytes', number('source-bytes')],
        ['toolCalls', number('tool-calls')],
      ].filter(([, value]) => value !== undefined),
    );
    const resolution = resolveLocalExecutionPolicy({
      context,
      snapshot,
      executor: executor.descriptor,
      workspaceTrusted: true,
      approval: {
        client: context.context.client,
        executor: executor.descriptor,
        sourceHash: snapshot.identity.hash,
        paths: many('allow-path').length ? many('allow-path') : ['**'],
        allowBase: true,
        allowRelated: true,
        allowKnowledge: true,
      },
      budget,
    });
    if (resolution.status !== 'ready')
      return {
        value: {
          status: resolution.status,
          problems: resolution.problems,
          source: snapshot.identity,
        },
        exitCode: 2,
      };
    let retentionPending = false;
    const result = await executeReviewRequest({
      storage: requestStorage,
      identity: resolution.policy.identity,
      reason: trigger,
      ...(dependencies.serviceStartLimits ? { limits: dependencies.serviceStartLimits } : {}),
      retryFinished: values['retry-finished'] === true,
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
      assertValid: async () => {
        if ((await context.context.observeCentralSnapshot()) !== 'current')
          throw new ReviewRequestError('request-invalid');
      },
      loadReport: (id) => history.getReview(id),
      saveReport: async (report) => {
        const saved = await history.saveReview(report);
        retentionPending = saved.retentionPending;
      },
      run: (signal) =>
        runLocalReview({
          snapshot: snapshot!,
          context: context.context,
          policy: resolution.policy,
          executor,
          trigger,
          signal,
        }),
    });
    const diagnostics = [];
    if (['completed', 'partial', 'needs-context'].includes(result.report.status)) {
      try {
        const store = conversations.get(history)!;
        try {
          await store.get(result.report.runId);
        } catch (error) {
          if (!(error instanceof ReviewConversationError) || error.code !== 'missing') throw error;
          await store.create({
            id: result.report.runId,
            review: result.report,
            snapshot,
            policy: resolution.policy,
          });
        }
        await store.prune();
      } catch {
        diagnostics.push({
          code: 'conversation-save-failed',
          message: 'The review is available, but its conversation snapshot could not be saved.',
        });
      }
    }
    if (!result.persisted)
      diagnostics.push({
        code: 'history-save-failed',
        message:
          'The displayed report could not be confirmed in encrypted history. Keep stdout if needed; run result to check before retrying.',
      });
    else if (!result.recorded)
      diagnostics.push({
        code: 'request-completion-unconfirmed',
        message:
          'The report was saved, but request completion could not be confirmed. Inspect requests and result before retrying.',
      });
    if (retentionPending)
      diagnostics.push({
        code: 'retention-pending',
        message: 'Review was saved; retention cleanup remains pending.',
      });
    if (result.reused)
      diagnostics.push({
        code: 'review-reused',
        message:
          'Reused the saved review for identical source, context and executor settings. No model review was started.',
      });
    return {
      value: result.report,
      exitCode: result.persisted && result.recorded ? reviewExitCode(result.report) : 2,
      ...(diagnostics.length ? { diagnostics } : {}),
    };
  } catch (error) {
    if (dependencies.signal?.aborted)
      return {
        value: {
          status: 'cancelled',
          error: {
            code: 'cancelled',
            message: 'Command was cancelled before a terminal review was available.',
          },
        },
        exitCode: 2,
      };
    const known =
      error instanceof CliError ||
      error instanceof ReviewSubmissionQueueError ||
      error instanceof ReviewConversationError ||
      error instanceof LocalServiceError ||
      error instanceof LocalStoreError ||
      error instanceof ReviewRequestError ||
      error instanceof ExecutorError ||
      error instanceof SourceCaptureError ||
      error instanceof KnowledgeSyncError;
    return {
      value: {
        status:
          error instanceof ReviewRequestError && error.code === 'request-deferred'
            ? 'deferred'
            : error instanceof ExecutorError
              ? 'unavailable'
              : 'failed',
        ...(error instanceof ReviewRequestError && error.retryAt ? { retryAt: error.retryAt } : {}),
        ...(error instanceof CentralConnectionSetupError
          ? { connectionId: error.connectionId }
          : {}),
        error: {
          code: known
            ? error.code
            : error instanceof ContractError
              ? 'invalid-input'
              : 'command-failed',
          message:
            error instanceof CliError
              ? error.message
              : 'Command could not complete. Check the error code; private input and process diagnostics are omitted.',
        },
      },
      exitCode: 2,
    };
  } finally {
    snapshot?.close();
    for (const store of opened) store.close();
  }
}
