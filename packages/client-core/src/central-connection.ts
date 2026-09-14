import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  centralConnectionInput,
  reviewSubmission,
  fallbackReason,
  offlineBehavior,
  type OfflineBehavior,
  centralConnectionRecord,
  centralConnectionReference,
  type CentralConnectionRecord,
} from '@gcr/client-contract';
import { LocalRecordStore, type LocalRecordOptions } from './local-records.js';
import { defaultLocalDataDirectory } from './local-identity.js';
import {
  PlatformCentralCredentialStore,
  validateCentralApiKey,
  type CentralCredentialStore,
} from './local-credentials.js';
import { KnowledgeSyncError, TrustedCentralBinding } from './central-binding.js';
import { CentralKnowledgeCache } from './central-cache.js';
import { KnowledgeHttpTransport } from './knowledge-http.js';
const denied = () =>
  new KnowledgeSyncError(
    'authentication-required',
    'The selected central connection requires authentication.',
  );
export class CentralConnectionSetupError extends KnowledgeSyncError {
  constructor(
    code: KnowledgeSyncError['code'],
    readonly connectionId: string,
  ) {
    super(code, 'The authenticated connection could not activate its first knowledge snapshot.');
  }
}
type State = { revision: number; value: CentralConnectionRecord };
/** Explicit repository/profile connections. Tokens live only in the OS credential port. */
export class CentralConnections {
  private readonly caches = new Map<string, CentralKnowledgeCache>();
  private readonly invalid = new Set<string>();
  private constructor(
    private readonly records: LocalRecordStore,
    private readonly options: LocalRecordOptions,
    private readonly credentials: CentralCredentialStore,
  ) {}
  static async open(options: LocalRecordOptions & { credentials?: CentralCredentialStore }) {
    if (options.scope.kind !== 'repository') throw denied();
    const records = await LocalRecordStore.open({
      ...options,
      dataDirectory: path.join(
        options.dataDirectory ?? defaultLocalDataDirectory(),
        'central-connections',
      ),
    });
    return new CentralConnections(
      records,
      options,
      options.credentials ?? new PlatformCentralCredentialStore(),
    );
  }
  close() {
    for (const cache of this.caches.values()) cache.close();
    this.records.close();
  }
  private binding(value: CentralConnectionRecord) {
    const binding = new TrustedCentralBinding({
      serverUrl: value.serverUrl,
      audience: value.audience,
      trustedKeys: new Map(value.trustedKeys.map((k) => [k.id, k.pem])),
    });
    if (binding.id !== value.id) throw denied();
    return binding;
  }
  private async state(id: string): Promise<State> {
    centralConnectionReference(id);
    const row = await this.records.read('settings', id);
    if (!row || row.deleted) throw denied();
    const value = centralConnectionRecord(row.value);
    if (value.id !== id) throw denied();
    return { revision: row.revision, value };
  }
  private async assert(state: State, pending = false) {
    if (
      this.invalid.has(state.value.credentialReference) ||
      Date.parse(state.value.expiresAt) <= Date.now()
    )
      throw denied();
    const current = await this.state(state.value.id);
    if (
      current.revision !== state.revision ||
      current.value.status !== (pending ? 'pending' : 'connected')
    )
      throw denied();
  }
  private async cache(value: CentralConnectionRecord) {
    if (!this.caches.has(value.id))
      this.caches.set(
        value.id,
        await CentralKnowledgeCache.open({ ...this.options, binding: this.binding(value) }),
      );
    return this.caches.get(value.id)!;
  }
  private transport(state: State, pending = false) {
    const binding = this.binding(state.value);
    return new KnowledgeHttpTransport(
      binding,
      {
        bindingId: binding.id,
        readToken: async () => {
          await this.assert(state, pending);
          const token = await this.credentials.read(state.value.credentialReference);
          await this.assert(state, pending);
          return token;
        },
      },
      state.value.ca ?? undefined,
    );
  }
  private async timed<T>(
    signal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, 15000);
    let rejectAbort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () =>
        reject(
          new KnowledgeSyncError('cancelled', 'Central authentication was cancelled or timed out.'),
        );
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
      if (controller.signal.aborted) rejectAbort();
    });
    try {
      return await Promise.race([work(controller.signal), cancelled]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', rejectAbort);
    }
  }
  async connect(
    input: unknown,
    apiKey: string,
    clientId: 'gcr-cli' | 'commit-defender',
    signal?: AbortSignal,
    options: { offlineBehavior?: OfflineBehavior } = {},
  ) {
    const behavior = offlineBehavior(options.offlineBehavior ?? 'pause');
    const config = centralConnectionInput(input);
    validateCentralApiKey(apiKey);
    if (
      new Set(config.trustedKeys.map((k) => k.id)).size !== config.trustedKeys.length ||
      [...config.trustedKeys.map((k) => k.pem), config.ca ?? ''].some((s) =>
        s.includes('PRIVATE KEY'),
      )
    )
      throw denied();
    const bootstrap = new TrustedCentralBinding({
      serverUrl: config.serverUrl,
      audience: {
        serverId: config.serverId,
        tenantId: config.tenantId,
        repositoryId: config.repositoryId,
        userId: 'pending',
      },
      trustedKeys: new Map(config.trustedKeys.map((k) => [k.id, k.pem])),
    });
    const identity = await this.timed(signal, (s) =>
      new KnowledgeHttpTransport(
        bootstrap,
        { bindingId: bootstrap.id, readToken: async () => apiKey },
        config.ca ?? undefined,
      ).identity(s),
    );
    if (
      identity.serverId !== config.serverId ||
      identity.tenantId !== config.tenantId ||
      !identity.repositoryIds.includes(config.repositoryId) ||
      identity.clientId !== clientId ||
      Date.parse(identity.expiresAt) <= Date.now()
    )
      throw denied();
    const binding = new TrustedCentralBinding({
      serverUrl: config.serverUrl,
      audience: { ...bootstrap.audience, userId: identity.userId },
      trustedKeys: bootstrap.verificationKeys(),
    });
    const previous = await this.records.read('settings', binding.id);
    if (
      previous &&
      (previous.deleted || centralConnectionRecord(previous.value).status !== 'disconnected')
    )
      throw new KnowledgeSyncError(
        'busy',
        'Disconnect the existing connection before registering another key.',
      );
    if (previous && !previous.deleted)
      await this.credentials.remove(centralConnectionRecord(previous.value).credentialReference);
    const value = centralConnectionRecord({
      formatVersion: 1,
      id: binding.id,
      status: 'pending',
      serverUrl: binding.serverUrl,
      audience: binding.audience,
      trustedKeys: [...binding.verificationKeys()].map(([id, key]) => ({
        id,
        pem: key.export({ type: 'spki', format: 'pem' }).toString(),
      })),
      ca: config.ca,
      offlineBehavior: behavior,
      credentialReference: 'gcr-' + randomUUID(),
      keyId: identity.keyId,
      clientId,
      expiresAt: identity.expiresAt,
    });
    const row = await this.records.write('settings', binding.id, value, previous?.revision ?? 0);
    const state = { revision: row.revision, value };
    try {
      await this.credentials.write(value.credentialReference, apiKey);
      await this.assert(state, true);
      const cache = await this.cache(value);
      const current = await cache.connectionState();
      if (current.status !== 'enabled') await cache.resume(current.generation);
      await cache.synchronize(this.transport(state, true).initialPublication(), {
        ...(signal ? { signal } : {}),
        timeoutMs: 60000,
      });
      await this.assert(state, true);
      await this.records.write(
        'settings',
        value.id,
        { ...value, status: 'connected' },
        state.revision,
      );
      return this.status(value.id);
    } catch (error) {
      this.invalid.add(value.credentialReference);
      try {
        await this.records.write(
          'settings',
          value.id,
          { ...value, status: 'disconnected' },
          state.revision,
        );
      } catch {
        /* A later disconnect owns the record. */
      }
      try {
        await this.credentials.remove(value.credentialReference);
      } catch {
        /* A secret can remain without an active connection. */
      }
      if (error instanceof KnowledgeSyncError && !signal?.aborted) {
        try {
          fallbackReason(error.code);
        } catch {
          throw error;
        }
        throw new CentralConnectionSetupError(error.code, value.id);
      }
      throw error;
    }
  }
  private summary(state: State) {
    const { value } = state;
    return {
      id: value.id,
      revision: state.revision,
      status: value.status,
      serverUrl: value.serverUrl,
      audience: value.audience,
      offlineBehavior: value.offlineBehavior ?? 'pause',
      keyId: value.keyId,
      clientId: value.clientId,
      expiresAt: value.expiresAt,
    };
  }
  async submitReview(id: string, value: unknown, signal?: AbortSignal) {
    const input = reviewSubmission(value);
    const state = await this.state(id);
    await this.assert(state);
    if (input.clientId !== state.value.clientId) throw denied();
    const result = await this.timed(signal, (s) => this.transport(state).submitReview(input, s));
    await this.assert(state);
    return result;
  }
  async historyIdentity(id: string) {
    const state = await this.state(id);
    await this.assert(state);
    return { id: state.value.id, audience: state.value.audience };
  }
  async status(id: string) {
    const state = await this.state(id);
    const summary = this.summary(state);
    if (state.value.status !== 'connected')
      return { ...summary, cache: { status: 'unavailable' as const } };
    try {
      await this.assert(state);
      const snapshot = await (await this.cache(state.value)).read('offline');
      return {
        ...summary,
        cache: {
          status: 'ready' as const,
          snapshotId: snapshot.manifest.payload.snapshotId,
          components: snapshot.manifest.payload.components,
          lastSynchronizedAt: snapshot.lastSynchronizedAt,
          refreshAfter: snapshot.manifest.payload.refreshAfter,
          offlineValidUntil: snapshot.manifest.payload.offlineValidUntil,
        },
      };
    } catch (cause) {
      return {
        ...summary,
        cache: {
          status: 'unavailable' as const,
          reason: cause instanceof KnowledgeSyncError ? cause.code : 'local-storage',
        },
      };
    }
  }
  async list() {
    const values = [];
    for (const id of await this.records.listIds('settings'))
      values.push(this.summary(await this.state(id)));
    return values;
  }
  async disconnect(id: string) {
    const state = await this.state(id);
    this.invalid.add(state.value.credentialReference);
    const cache = await this.cache(state.value);
    const cleanup = await cache.disable();
    let current = state;
    for (let attempt = 0; current.value.status !== 'disconnected'; attempt++) {
      if (attempt >= 3 || current.value.credentialReference !== state.value.credentialReference)
        throw new KnowledgeSyncError('superseded', 'Connection changed during disconnect.');
      try {
        await this.records.write(
          'settings',
          id,
          { ...current.value, status: 'disconnected' },
          current.revision,
        );
        break;
      } catch {
        current = await this.state(id);
      }
    }
    let credentialCleanupPending = false;
    try {
      await this.credentials.remove(state.value.credentialReference);
    } catch {
      credentialCleanupPending = true;
    }
    return {
      id,
      status: 'disconnected',
      cacheCleanupPending: cleanup.cleanupPending,
      credentialCleanupPending,
    };
  }
  async synchronize(id: string, signal?: AbortSignal) {
    const state = await this.state(id);
    await this.assert(state);
    const cache = await this.cache(state.value);
    try {
      await cache.synchronize(this.transport(state), signal ? { signal } : {});
      await this.assert(state);
      return this.status(id);
    } catch (error) {
      if (
        error instanceof KnowledgeSyncError &&
        ['authentication-required', 'revoked'].includes(error.code)
      ) {
        this.invalid.add(state.value.credentialReference);
        try {
          await this.records.write(
            'settings',
            id,
            { ...state.value, status: 'disconnected' },
            state.revision,
          );
        } catch {
          /* Cache persists the authorization barrier even if this record cannot be written. */
        }
        try {
          await this.credentials.remove(state.value.credentialReference);
        } catch {
          /* Report disconnect cleanup on explicit retry. */
        }
      }
      throw error;
    }
  }
  async review(id: string, freshness: 'online' | 'offline', signal?: AbortSignal) {
    let state = await this.state(id);
    await this.assert(state);
    const cache = await this.cache(state.value);
    if (freshness === 'online') {
      try {
        await cache.read('online');
      } catch {
        await this.synchronize(id, signal);
      }
    }
    state = await this.state(id);
    await this.assert(state);
    return {
      client: {
        mode: 'centralized' as const,
        profileId: this.options.scope.profileId,
        repositoryKey: (
          this.options.scope as Extract<LocalRecordOptions['scope'], { kind: 'repository' }>
        ).repositoryKey,
        worktreeKey: (
          this.options.scope as Extract<LocalRecordOptions['scope'], { kind: 'repository' }>
        ).worktreeKey,
        audience: state.value.audience,
      },
      cache,
      freshness,
      assertConnection: () => this.assert(state),
    };
  }
}
