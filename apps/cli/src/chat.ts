import path from 'node:path';
import type { CentralAudience, ClientIdentity, OfflineBehavior } from '@gcr/client-contract';
import {
  CentralConnections,
  LocalRecordStore,
  LocalKnowledgeStore,
  ReviewConversationStore,
  ReviewConversationError,
  restoreLocalSource,
  discoverLocalIdentity,
  resolveReviewExecution,
  resolveLocalContext,
  resolveCentralContext,
  resolveLocalExecutionPolicy,
  runReviewConversation,
  contentHash,
  KnowledgeSyncError,
  type LocalReviewChatExecutor,
  type StoredReviewConversation,
} from '@gcr/client-core';
import { prepareCodexAccountExecutor } from '@gcr/client-executors';
import { CliError } from './arguments.js';
import type { CliDependencies, CliResult } from './cli.js';

export type ChatAction = 'read' | 'send' | 'answer' | 'resume' | 'cancel' | 'source';
export async function executeChat(
  input: {
    action: string;
    reportId: string;
    body?: unknown;
    cwd: string;
    profileId: string;
    dataDirectory: string;
    mode: 'standalone' | 'centralized';
    connectionId?: string;
    offline: boolean;
    offlineBehavior?: OfflineBehavior;
    executorPath: string;
    model: string;
    reasoningEffort: string;
    timeoutMs?: number;
    allowPaths?: string[];
  },
  dependencies: CliDependencies,
): Promise<CliResult> {
  const fields: Record<string, string[]> = {
    read: [],
    send: ['turnId', 'content'],
    answer: ['turnId', 'questionId', 'content'],
    resume: ['turnId'],
    cancel: ['turnId'],
    source: ['turnId', 'citation'],
  };
  const invalid = () =>
    new CliError(
      'usage',
      'Use chat read|send|answer|resume|cancel|source RUN_ID with the exact action JSON.',
    );
  if (!Object.hasOwn(fields, input.action)) throw invalid();
  const body = input.body ?? {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
  const a = body as Record<string, unknown>,
    expected = fields[input.action]!;
  if (Object.keys(a).length !== expected.length || expected.some((k) => !(k in a))) throw invalid();
  if (
    ['turnId', 'questionId'].some(
      (k) =>
        k in a && (typeof a[k] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(a[k])),
    )
  )
    throw invalid();
  if (
    'content' in a &&
    (typeof a.content !== 'string' || !a.content.trim() || a.content.length > 4000)
  )
    throw invalid();
  if ('citation' in a && (!Number.isSafeInteger(a.citation) || Number(a.citation) < 0))
    throw invalid();
  if (
    input.timeoutMs !== undefined &&
    (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 600000)
  )
    throw invalid();
  const opened: LocalRecordStore[] = [];
  let connections: CentralConnections | undefined,
    snapshot: ReturnType<typeof restoreLocalSource> | undefined;
  const signal = dependencies.signal;
  const active = () => {
    if (signal?.aborted) throw new CliError('cancelled', 'Conversation operation cancelled.');
  };
  try {
    active();
    const client = discoverLocalIdentity(input.cwd, input.profileId);
    const scope = {
      kind: 'repository' as const,
      profileId: input.profileId,
      repositoryKey: client.repositoryKey,
      worktreeKey: client.worktreeKey,
    };
    const local = async (directory = input.dataDirectory, profile = false) => {
      const records = await LocalRecordStore.open({
        scope: profile ? { kind: 'profile', profileId: input.profileId } : scope,
        dataDirectory: directory,
        ...(dependencies.keys ? { keys: dependencies.keys } : {}),
      });
      opened.push(records);
      return records;
    };
    let audience: CentralAudience | undefined,
      historyDirectory = input.dataDirectory;
    let behavior = input.offlineBehavior;
    if (input.mode === 'centralized') {
      connections = await CentralConnections.open({
        scope,
        dataDirectory: input.dataDirectory,
        ...(dependencies.keys ? { keys: dependencies.keys } : {}),
        ...(dependencies.credentials ? { credentials: dependencies.credentials } : {}),
      });
      const connectionStatus = await connections.status(input.connectionId!);
      behavior ??= connectionStatus.offlineBehavior;
      if (connectionStatus.clientId !== 'gcr-cli')
        throw new CliError('selection-changed', 'Select the original CLI connection.');
      try {
        const identity = await connections.historyIdentity(input.connectionId!);
        audience = identity.audience;
        historyDirectory = path.join(input.dataDirectory, 'central-review-history', identity.id);
      } catch (error) {
        // A confirmed revocation closes central history. A report produced by
        // this connection's local fallback still belongs to the local profile.
        if (!(error instanceof KnowledgeSyncError) || error.code !== 'authentication-required')
          throw error;
      }
    }
    let store = new ReviewConversationStore(await local(historyDirectory), undefined, audience);
    let stored: StoredReviewConversation;
    try {
      stored = await store.get(input.reportId);
    } catch (error) {
      if (!(error instanceof ReviewConversationError) || error.code !== 'missing' || !connections)
        throw error;
      store = new ReviewConversationStore(await local());
      stored = await store.get(input.reportId);
    }
    const selected = (value: StoredReviewConversation) => {
      active();
      const saved = value.conversation.identity.client;
      if (
        input.mode === 'centralized'
          ? saved.execution?.connectionId !== input.connectionId
          : saved.mode !== 'standalone' || saved.execution?.configuredMode === 'centralized'
      )
        throw new CliError(
          'selection-changed',
          'Use the original conversation profile, mode and connection.',
        );
    };
    selected(stored);
    await store.prune();
    stored = await store.get(input.reportId);
    const state = (value: StoredReviewConversation): CliResult => {
      const turn = value.conversation.turns.at(-1);
      return {
        value: { conversation: value.conversation, review: value.review },
        exitCode:
          turn && ['failed', 'cancelled', 'interrupted', 'partial'].includes(turn.status)
            ? 2
            : turn && ['awaiting_input', 'queued', 'running'].includes(turn.status)
              ? 1
              : 0,
      };
    };
    if (input.action === 'read') return state(stored);
    if (input.action === 'cancel')
      return { ...state(await store.cancel(input.reportId, String(a.turnId))), exitCode: 0 };
    snapshot = restoreLocalSource(stored.source);
    if (input.action === 'source') {
      const citation = stored.conversation.turns.find((t) => t.id === a.turnId)?.response
        ?.citations[Number(a.citation)];
      if (!citation) throw invalid();
      const read = snapshot.readFile(citation.location.path, citation.location.side);
      if (read.status !== 'available' || read.source.hash !== citation.location.hash)
        throw new CliError('stale-identity', 'The saved citation does not match its source.');
      const text = read.text
        .split('\n')
        .slice(
          citation.location.startLine - 1,
          Math.min(citation.location.endLine, citation.location.startLine + 199),
        )
        .join('\n')
        .slice(0, 24000);
      return { value: { location: citation.location, text }, exitCode: 0 };
    }
    if (input.timeoutMs !== undefined && input.timeoutMs < stored.conversation.limits.durationMs)
      throw new CliError(
        'stale-identity',
        'The configured timeout cannot authorize the saved conversation budget.',
      );
    const execution = await resolveReviewExecution({
      client,
      configuredMode: input.mode,
      offlineBehavior: behavior ?? 'pause',
      ...(connections
        ? {
            connectionId: input.connectionId!,
            freshness: input.offline ? ('offline' as const) : ('online' as const),
            central: (freshness: 'online' | 'offline') =>
              connections!.review(input.connectionId!, freshness, signal),
          }
        : {}),
      ...(signal ? { signal } : {}),
    });
    const pinned = stored.conversation.identity.client;
    const admission = (value: ClientIdentity) => {
      const copy = structuredClone(value);
      if (copy.execution) delete copy.execution.lastSynchronizedAt;
      return copy;
    };
    if (contentHash(admission(execution.client)) !== contentHash(admission(pinned)))
      throw new CliError('stale-identity', 'The conversation execution mode or authority changed.');
    const query = {
      client: pinned,
      snapshot,
      stores: [
        new LocalKnowledgeStore(await local()),
        new LocalKnowledgeStore(await local(input.dataDirectory, true)),
      ],
    };
    const context =
      execution.central && pinned.mode === 'centralized'
        ? await resolveCentralContext({ ...query, ...execution.central, client: pinned })
        : await resolveLocalContext(query);
    if (context.status !== 'ready')
      throw new CliError('policy-unavailable', 'Current conversation context is unavailable.');
    const executor = await (dependencies.prepareExecutor ?? prepareCodexAccountExecutor)({
      executablePath: input.executorPath,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    });
    if (
      !('conversationCapability' in executor) ||
      executor.conversationCapability !== 'checkpoint-tool-v1' ||
      !('converse' in executor) ||
      typeof executor.converse !== 'function'
    )
      throw new CliError(
        'policy-unavailable',
        'This executor does not support durable conversation questions.',
      );
    const policy = resolveLocalExecutionPolicy({
      context,
      snapshot,
      executor: executor.descriptor,
      workspaceTrusted: true,
      approval: {
        client: pinned,
        executor: executor.descriptor,
        sourceHash: snapshot.identity.hash,
        paths: input.allowPaths?.length ? input.allowPaths : ['**'],
        allowBase: true,
        allowRelated: true,
        allowKnowledge: true,
      },
      budget: stored.conversation.limits,
    });
    if (
      policy.status !== 'ready' ||
      contentHash(policy.policy.identity) !== contentHash(stored.conversation.identity)
    )
      throw new CliError(
        'stale-identity',
        'Source, context, executor or approval changed. Start a new review.',
      );
    active();
    const previous = stored.conversation.turns.find((t) => t.id === a.turnId);
    if (input.action === 'send' && previous) {
      if (previous.content !== a.content) throw invalid();
      return state(stored);
    }
    if (
      input.action === 'answer' &&
      previous?.questions.some((q) => q.id === a.questionId && q.answer === a.content) &&
      previous.status !== 'awaiting_input'
    )
      return state(stored);
    if (input.action === 'send')
      stored = await store.append(input.reportId, String(a.turnId), String(a.content));
    if (input.action === 'answer')
      stored = await store.answer(
        input.reportId,
        String(a.turnId),
        String(a.questionId),
        String(a.content),
      );
    const result = await runReviewConversation({
      store,
      conversationId: input.reportId,
      turnId: String(a.turnId),
      context: context.context,
      policy: policy.policy,
      executor: executor as LocalReviewChatExecutor,
      ...(signal ? { signal } : {}),
      async assertAuthorized() {
        selected(await store.get(input.reportId));
      },
    });
    await store.prune();
    return state(result);
  } finally {
    snapshot?.close();
    connections?.close();
    for (const records of opened) records.close();
  }
}
