import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ContractError,
  localKnowledge,
  localScope,
  reviewExitCode,
  sourcePath,
  type LocalScope,
} from '@gcr/client-contract';
import {
  captureLocalSource,
  defaultLocalDataDirectory,
  discoverLocalIdentity,
  LocalHistoryStore,
  LocalKnowledgeStore,
  LocalRecordStore,
  LocalStoreError,
  resolveLocalContext,
  resolveLocalExecutionPolicy,
  resolveReviewMode,
  runLocalReview,
  SourceCaptureError,
  type LocalKeyStore,
  type LocalKnowledgeDraft,
  type LocalKnowledgeEdit,
  type LocalReviewExecutor,
  type LocalSourceSnapshot,
} from '@gcr/client-core';
import { ExecutorError, prepareCodexAccountExecutor } from '@gcr/client-executors';
import { argumentsFor, CliError, help } from './arguments.js';

interface CliDependencies {
  cwd?: string;
  signal?: AbortSignal;
  keys?: LocalKeyStore;
  prepareExecutor?:
    | typeof prepareCodexAccountExecutor
    | ((
        options: Parameters<typeof prepareCodexAccountExecutor>[0],
      ) => Promise<LocalReviewExecutor>);
  readStdin?: () => Promise<string>;
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
  const opened: LocalRecordStore[] = [];
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
    if (!mode.supported) return { value: { status: 'unavailable', ...mode }, exitCode: 2 };
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
    if (positionals.length !== (command === 'result' ? 1 : 0))
      throw new CliError('usage', 'Unexpected positional arguments.');
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
          triggers: 'manual-only',
        },
        exitCode: 0,
      };
    const history = new LocalHistoryStore(await records(repositoryScope!));
    if (command === 'result') {
      const report = await history.getReview(positionals[0]!);
      if (!report)
        throw new CliError('not-found', 'Review was not found in this profile and worktree.');
      return { value: report, exitCode: reviewExitCode(report) };
    }
    if (command === 'history')
      return {
        value: (await history.listReviews()).map((report) => ({
          runId: report.runId,
          status: report.status,
          finishedAt: report.finishedAt,
          summary: report.summary,
          sourceHash: report.identity.source.hash,
          findings: report.findings.length,
          questions: report.questions.length,
          exitCode: reviewExitCode(report),
        })),
        exitCode: 0,
      };
    const kind = string('source', 'index');
    if (kind !== 'index' && kind !== 'working-tree')
      throw new CliError('usage', 'Source must be index or working-tree.');
    snapshot = captureLocalSource({
      cwd,
      kind,
      ...(string('base') ? { baseRef: string('base')! } : {}),
      ...(many('path').length ? { paths: many('path') } : {}),
      includeUntracked: many('include-untracked'),
      excludePatterns: many('exclude'),
    });
    const context = await resolveLocalContext({
      client: client!,
      snapshot,
      stores: [
        new LocalKnowledgeStore(await records(repositoryScope!)),
        new LocalKnowledgeStore(await records({ kind: 'profile', profileId })),
      ],
      requiredKnowledgeIds: many('require-knowledge'),
      requiredSources: many('require-source').map((value) => {
        const index = value.indexOf(':');
        const side = value.slice(0, index);
        if (index < 0 || (side !== 'source' && side !== 'base'))
          throw new CliError('usage', 'Required source must use source:path or base:path.');
        return { side, path: sourcePath(value.slice(index + 1)) };
      }),
    });
    if (command === 'context')
      return {
        value: {
          status: context.status,
          problems: context.problems,
          client,
          source: snapshot.identity,
          selected: snapshot.selected,
          sourceFiles: snapshot.sourceFiles,
          limitations: snapshot.limitations,
          ...(context.context
            ? {
                context: context.context.identity,
                omissions: context.context.omissions,
                knowledgeBytes: context.context.bytes,
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
        client: client!,
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
    const report = await runLocalReview({
      snapshot,
      context: context.context,
      policy: resolution.policy,
      executor,
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    });
    try {
      const saved = await history.saveReview(report);
      return {
        value: report,
        exitCode: reviewExitCode(report),
        ...(saved.retentionPending
          ? {
              diagnostics: [
                {
                  code: 'retention-pending',
                  message: 'Review was saved; retention cleanup remains pending.',
                },
              ],
            }
          : {}),
      };
    } catch {
      return {
        value: report,
        exitCode: 2,
        diagnostics: [
          {
            code: 'history-save-failed',
            message:
              'The displayed report could not be confirmed in encrypted history. Keep stdout if needed; run result to check before retrying.',
          },
        ],
      };
    }
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
      error instanceof LocalStoreError ||
      error instanceof ExecutorError ||
      error instanceof SourceCaptureError;
    return {
      value: {
        status: error instanceof ExecutorError ? 'unavailable' : 'failed',
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
