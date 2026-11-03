import {
  clientIdentity,
  clientMode,
  offlineBehavior,
  fallbackReason,
  reviewExecution,
  type ClientIdentity,
  type ClientMode,
  type OfflineBehavior,
  type ReviewExecution,
} from '@gcr/client-contract';
import { KnowledgeSyncError } from './central-binding.js';
import type { CentralConnections } from './central-connection.js';

type CentralAccess = Awaited<ReturnType<CentralConnections['review']>>;
export type ReviewExecutionResolution = {
  client: ClientIdentity;
  execution: ReviewExecution;
  central?: CentralAccess;
};
/** Decide once before context/model preparation. Never retry a running model or
 * switch providers; only the host's previously confirmed offline policy applies. */
export async function resolveReviewExecution(input: {
  client: ClientIdentity;
  configuredMode: ClientMode;
  connectionId?: string;
  freshness?: 'online' | 'offline';
  offlineBehavior?: OfflineBehavior;
  central?(freshness: 'online' | 'offline'): Promise<CentralAccess>;
  signal?: AbortSignal;
}): Promise<ReviewExecutionResolution> {
  const mode = clientMode(input.configuredMode);
  const local = clientIdentity(input.client);
  if (local.mode !== 'standalone')
    throw new KnowledgeSyncError('invalid-binding', 'Expected local client identity.');
  const behavior = offlineBehavior(input.offlineBehavior ?? 'pause');
  const check = () => {
    if (input.signal?.aborted)
      throw new KnowledgeSyncError('cancelled', 'Review preparation was cancelled.');
  };
  const result = (
    identity: ClientIdentity,
    execution: ReviewExecution,
    central?: CentralAccess,
  ): ReviewExecutionResolution => {
    check();
    const client = clientIdentity({ ...identity, execution: reviewExecution(execution) });
    return {
      client,
      execution,
      ...(central ? { central: { ...central, client: client as CentralAccess['client'] } } : {}),
    };
  };
  check();
  if (mode === 'standalone')
    return result(local, {
      configuredMode: 'standalone',
      effectiveMode: 'standalone',
      knowledgeSource: 'local',
      fallbackReason: null,
    });
  if (!input.connectionId || !input.central)
    throw new KnowledgeSyncError(
      'invalid-binding',
      'An explicitly confirmed central connection is required.',
    );
  const connectionId = input.connectionId;
  const base = { configuredMode: 'centralized' as const, connectionId };
  const access = async (
    freshness: 'online' | 'offline',
    reason: ReviewExecution['fallbackReason'],
  ) => {
    check();
    const central = await input.central!(freshness);
    if (
      central.freshness !== freshness ||
      central.client.mode !== 'centralized' ||
      Object.entries(central.cache.binding.audience).some(
        ([key, value]) =>
          central.client.audience[key as keyof typeof central.client.audience] !== value,
      ) ||
      central.cache.binding.id !== connectionId ||
      central.client.profileId !== local.profileId ||
      central.client.repositoryKey !== local.repositoryKey ||
      central.client.worktreeKey !== local.worktreeKey
    )
      throw new KnowledgeSyncError(
        'invalid-binding',
        'The central connection does not match this worktree and profile.',
      );
    await central.assertConnection();
    const snapshot = await central.cache.read(freshness);
    return result(
      central.client,
      {
        ...base,
        effectiveMode: 'centralized',
        knowledgeSource: freshness === 'online' ? 'central-online' : 'central-cache',
        fallbackReason: reason,
        lastSynchronizedAt:
          snapshot.lastSynchronizedAt === null
            ? null
            : new Date(snapshot.lastSynchronizedAt).toISOString(),
      },
      central,
    );
  };
  const eligible = (cause: unknown) => {
    check();
    if (!(cause instanceof KnowledgeSyncError)) throw cause;
    try {
      return fallbackReason(cause.code);
    } catch {
      throw cause;
    }
  };
  try {
    return await access(input.freshness ?? 'online', null);
  } catch (cause) {
    let reason = eligible(cause);
    if (behavior === 'pause') throw cause;
    // Only ordinary transport failure permits trying an older signed cache.
    // Identity failure, revocation or invalid content must not be relabeled offline.
    if (
      input.freshness !== 'offline' &&
      behavior !== 'standalone' &&
      (reason === 'unavailable' || reason === 'timeout')
    ) {
      try {
        return await access('offline', reason);
      } catch (cacheError) {
        reason = eligible(cacheError);
        if (behavior === 'cache-only') throw cacheError;
      }
    }
    if (behavior === 'cache-only') throw cause;
    return result(local, {
      ...base,
      effectiveMode: 'standalone',
      knowledgeSource: 'local',
      fallbackReason: reason,
    });
  }
}
