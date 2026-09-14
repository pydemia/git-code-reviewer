import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import {
  centralCacheIndex,
  centralKnowledgeBundle,
  encodeKnowledgeBundle,
  KNOWLEDGE_BUNDLE_MAX_BYTES,
  type CentralCacheIndex,
  type SignedKnowledgeManifest,
} from '@gcr/client-contract';
import { LocalRecordStore, type LocalRecordOptions } from './local-records.js';
import { defaultLocalDataDirectory } from './local-identity.js';
import { KnowledgeSyncError, TrustedCentralBinding } from './central-binding.js';
import { verifyKnowledgeManifest } from './knowledge-signature.js';
import { LocalStoreError } from './local-errors.js';
type Part = 'policy' | 'collective' | 'personal';
const parts: Part[] = ['policy', 'collective', 'personal'];
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export interface KnowledgeTransport {
  manifest(request: {
    etag?: string;
    signal: AbortSignal;
  }): Promise<
    | { status: 200; manifest: unknown }
    | { status: 304 }
    | { status: 401 | 403 | 404 | 409 | 426 | 429 | 500 | 502 | 503 | 504 }
  >;
  bundle(request: {
    snapshotId: string;
    bundleId: string;
    component: Part;
    signal: AbortSignal;
  }): Promise<
    | { status: 200; body: AsyncIterable<Uint8Array> }
    | { status: 401 | 403 | 404 | 409 | 426 | 429 | 500 | 502 | 503 | 504 }
  >;
}
export type CentralKnowledgeSnapshot = {
  generation: number;
  lastSynchronizedAt: number | null;
  manifest: SignedKnowledgeManifest;
  bundles: Record<Part, ReturnType<typeof centralKnowledgeBundle>>;
};
type State = { revision: number; value: CentralCacheIndex };
const error = (code: KnowledgeSyncError['code']) =>
  new KnowledgeSyncError(
    code,
    {
      'invalid-binding': 'Invalid central binding.',
      busy: 'Another process owns the current synchronization.',
      disabled: 'Central connection is disabled.',
      'authentication-required': 'Central authentication is required.',
      revoked: 'Central access has been revoked.',
      unavailable: 'Central synchronization is unavailable.',
      'identity-unavailable': 'Central identity must be verified before using cached knowledge.',
      incompatible: 'The central contract requires a client upgrade.',
      'invalid-manifest': 'Central manifest verification failed.',
      'invalid-bundle': 'Central bundle verification failed.',
      'cache-unavailable': 'A complete authorized central cache is unavailable.',
      superseded: 'A newer synchronization or connection change superseded this operation.',
      cancelled: 'Central synchronization was cancelled.',
      timeout: 'Central synchronization exceeded its deadline.',
    }[code],
  );
/** Reads/writes are fenced by encrypted index revisions; central bodies never enter local knowledge/export namespaces. */
export class CentralKnowledgeCache {
  private identityUnavailableGeneration: number | undefined;
  private denied: 'disconnected' | 'authentication-required' | 'revoked' | undefined;
  private constructor(
    private readonly records: LocalRecordStore,
    readonly binding: TrustedCentralBinding,
    private readonly now: () => number,
  ) {}
  static async open(
    options: LocalRecordOptions & { binding: TrustedCentralBinding; now?: () => number },
  ) {
    if (options.scope.kind !== 'repository' || !(options.binding instanceof TrustedCentralBinding))
      throw error('invalid-binding');
    const records = await LocalRecordStore.open({
      ...options,
      dataDirectory: path.join(
        options.dataDirectory ?? defaultLocalDataDirectory(),
        'central-cache',
        options.binding.id,
      ),
    });
    return new CentralKnowledgeCache(records, options.binding, options.now ?? Date.now);
  }
  get scope() {
    return structuredClone(this.records.scope);
  }
  close() {
    this.records.close();
  }
  private time() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw error('cache-unavailable');
    return value;
  }
  private async state(): Promise<State> {
    const record = await this.records.read('settings', 'snapshot');
    if (record?.deleted) throw error('cache-unavailable');
    const value = record
      ? centralCacheIndex(record.value)
      : centralCacheIndex({
          formatVersion: 1,
          bindingHash: this.binding.id,
          generation: 0,
          observedAt: 0,
          status: 'enabled',
          minimumAuthorizationRevision: 0,
          minimumSequences: { policy: 0, collective: 0, personal: 0 },
          revocationMinimumSequences: { policy: 0, collective: 0, personal: 0 },
          claim: null,
          active: null,
        });
    if (value.bindingHash !== this.binding.id || value.observedAt > this.time() + 30000)
      throw error('cache-unavailable');
    return { revision: record?.revision ?? 0, value };
  }
  private async put(state: State, value: CentralCacheIndex): Promise<State> {
    const result = await this.records.write(
      'settings',
      'snapshot',
      centralCacheIndex(value),
      state.revision,
    );
    if (result.deleted) throw error('cache-unavailable');
    return { revision: result.revision, value: centralCacheIndex(result.value) };
  }
  private verify(value: unknown, state: CentralCacheIndex, mode: 'online' | 'offline') {
    try {
      return verifyKnowledgeManifest(value, {
        audience: this.binding.audience,
        trustedKeys: this.binding.verificationKeys(),
        now: this.time(),
        mode,
        minimumAuthorizationRevision: state.minimumAuthorizationRevision,
        minimumSequences: state.minimumSequences,
      });
    } catch {
      throw error('invalid-manifest');
    }
  }
  private bundle(value: unknown, part: Part, manifest: SignedKnowledgeManifest) {
    try {
      const decoded = centralKnowledgeBundle(value),
        descriptor = manifest.payload.components[part];
      const bytes = encodeKnowledgeBundle(decoded);
      if (
        decoded.component !== part ||
        decoded.tenantId !== this.binding.audience.tenantId ||
        decoded.repositoryId !== this.binding.audience.repositoryId ||
        decoded.ownerUserId !== (part === 'personal' ? this.binding.audience.userId : null) ||
        Buffer.byteLength(bytes) !== descriptor.sizeBytes ||
        hash(bytes) !== descriptor.contentHash
      )
        throw error('invalid-bundle');
      return decoded;
    } catch {
      throw error('invalid-bundle');
    }
  }
  private async readActive(
    state: State,
    mode: 'online' | 'offline',
    identityConfirmed = false,
  ): Promise<CentralKnowledgeSnapshot> {
    this.checkEnabled();
    if (state.value.status !== 'enabled')
      throw error(state.value.status === 'disconnected' ? 'disabled' : state.value.status);
    if (
      !identityConfirmed &&
      (this.identityUnavailableGeneration === state.value.generation ||
        state.value.identityUnavailable)
    )
      throw error('identity-unavailable');
    if (mode === 'online' && !identityConfirmed && state.value.lastSyncFailure)
      throw error(state.value.lastSyncFailure);
    const active = state.value.active;
    if (!active) throw error('cache-unavailable');
    const manifest = this.verify(active.manifest, state.value, mode);
    const bundles = {} as CentralKnowledgeSnapshot['bundles'];
    for (const part of parts) {
      const record = await this.records.read('knowledge', active.records[part]);
      if (!record || record.deleted) throw error('cache-unavailable');
      bundles[part] = this.bundle(record.value, part, manifest);
    }
    const current = await this.state();
    if (current.revision !== state.revision) throw error('superseded');
    this.checkEnabled();
    this.verify(manifest, current.value, mode);
    return {
      generation: state.value.generation,
      lastSynchronizedAt: state.value.lastSynchronizedAt ?? null,
      manifest,
      bundles,
    };
  }
  private checkEnabled() {
    if (this.denied) throw error(this.denied === 'disconnected' ? 'disabled' : this.denied);
  }
  async read(mode: 'online' | 'offline' = 'offline') {
    this.checkEnabled();
    const state = await this.state();
    // A persisted claim is also an authorization barrier. If disk failure or a
    // crash prevents persisting a received denial/revocation, another process
    // must resynchronize before consuming the former snapshot. Expiring the
    // execution lease permits takeover, never offline authorization by itself.
    if (state.value.claim) throw error('busy');
    return this.readActive(state, mode);
  }
  /** Checks a pinned running review without replacing its bodies with a newer snapshot. */
  async observeSnapshot(manifest: SignedKnowledgeManifest, mode: 'online' | 'offline') {
    this.checkEnabled();
    const state = await this.state();
    this.checkEnabled();
    if (state.value.status !== 'enabled')
      throw error(state.value.status === 'disconnected' ? 'disabled' : state.value.status);
    if (
      this.identityUnavailableGeneration === state.value.generation ||
      state.value.identityUnavailable
    )
      throw error('identity-unavailable');
    // Legacy indexes had one high-water mark; retain their conservative floor.
    this.verify(
      manifest,
      {
        ...state.value,
        minimumSequences: state.value.revocationMinimumSequences ?? state.value.minimumSequences,
      },
      mode,
    );
    if (state.value.claim) {
      if (state.value.claim.deadline <= this.time()) throw error('cache-unavailable');
      return 'pending' as const;
    }
    if (!state.value.active) throw error('cache-unavailable');
    const latest = this.verify(state.value.active.manifest, state.value, mode);
    return parts.some(
      (part) =>
        latest.payload.components[part].contentHash !==
        manifest.payload.components[part].contentHash,
    )
      ? ('updated' as const)
      : ('current' as const);
  }
  async connectionState() {
    const state = await this.state();
    return { generation: state.value.generation, status: state.value.status };
  }
  private async owned(token: string, generation: number): Promise<State> {
    const state = await this.state();
    if (
      state.value.status !== 'enabled' ||
      state.value.generation !== generation ||
      state.value.claim?.id !== token ||
      state.value.claim.deadline <= this.time()
    )
      throw error('superseded');
    return state;
  }
  private check(signal: AbortSignal) {
    if (signal.aborted) throw error(signal.reason === 'timeout' ? 'timeout' : 'cancelled');
  }
  private async request<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    this.check(signal);
    let abort!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(error(signal.reason === 'timeout' ? 'timeout' : 'cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      return await Promise.race([work(), interrupted]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  private response(status: number): never {
    throw error(
      status === 401
        ? 'authentication-required'
        : status === 403
          ? 'revoked'
          : status === 426
            ? 'incompatible'
            : 'unavailable',
    );
  }
  async synchronize(
    transport: KnowledgeTransport,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<CentralKnowledgeSnapshot> {
    const timeout = options.timeoutMs ?? 120000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000)
      throw error('invalid-binding');
    const controller = new AbortController();
    const cancel = () => controller.abort('cancelled');
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const timer = setTimeout(() => controller.abort('timeout'), timeout);
    const token = randomUUID();
    let generation: number | undefined;
    let authorizationUncertain = false;
    try {
      this.checkEnabled();
      this.check(controller.signal);
      let state = await this.state();
      if (state.value.status !== 'enabled')
        throw error(state.value.status === 'disconnected' ? 'disabled' : state.value.status);
      if (state.value.claim && state.value.claim.deadline > this.time()) throw error('busy');
      state = await this.put(state, {
        ...state.value,
        generation: state.value.generation + 1,
        observedAt: this.time(),
        claim: { id: token, deadline: this.time() + timeout },
      });
      generation = state.value.generation;
      const inventory = await this.records.listIds('knowledge');
      const response = await this.request(
        () =>
          transport.manifest({
            ...(state.value.active
              ? { etag: `"${state.value.active.manifest.manifestHash}"` }
              : {}),
            signal: controller.signal,
          }),
        controller.signal,
      );
      this.check(controller.signal);
      if (response.status !== 200 && response.status !== 304) this.response(response.status);
      state = await this.owned(token, generation);
      if (response.status === 304) {
        await this.readActive(state, 'online', true);
        this.check(controller.signal);
        state = await this.put(state, {
          ...state.value,
          identityUnavailable: false,
          lastSyncFailure: null,
          lastSynchronizedAt: this.time(),
          observedAt: this.time(),
          claim: null,
        });
        this.identityUnavailableGeneration = undefined;
        return this.readActive(state, 'online');
      }
      const manifest = this.verify(response.manifest, state.value, 'online');
      // Persist explicit revocation floors before any downloads. A failed download
      // must not make a now-revoked previous snapshot usable as offline fallback.
      const floors = { ...state.value.minimumSequences };
      const revocationFloors = {
        ...(state.value.revocationMinimumSequences ?? state.value.minimumSequences),
      };
      for (const part of parts)
        floors[part] = Math.max(
          floors[part],
          manifest.payload.revocations[`${part}MinimumSequence`],
        );
      for (const part of parts)
        revocationFloors[part] = Math.max(
          revocationFloors[part],
          manifest.payload.revocations[`${part}MinimumSequence`],
        );
      authorizationUncertain = true;
      state = await this.put(state, {
        ...state.value,
        observedAt: this.time(),
        minimumAuthorizationRevision: manifest.payload.authorizationRevision,
        minimumSequences: floors,
        revocationMinimumSequences: revocationFloors,
      });
      authorizationUncertain = false;
      const refs = {} as Record<Part, string>;
      for (const part of parts) {
        this.check(controller.signal);
        const previous = state.value.active;
        if (
          previous?.manifest.payload.components[part].contentHash ===
          manifest.payload.components[part].contentHash
        ) {
          const cached = await this.records.read('knowledge', previous.records[part]);
          if (!cached || cached.deleted) throw error('cache-unavailable');
          this.bundle(cached.value, part, manifest);
          refs[part] = previous.records[part];
          continue;
        }
        const downloaded = await this.request(
          () =>
            transport.bundle({
              snapshotId: manifest.payload.snapshotId,
              bundleId: manifest.payload.components[part].bundleId,
              component: part,
              signal: controller.signal,
            }),
          controller.signal,
        );
        if (downloaded.status !== 200) this.response(downloaded.status);
        const chunks: Buffer[] = [];
        let size = 0;
        const iterator = downloaded.body[Symbol.asyncIterator]();
        try {
          for (;;) {
            const next = await this.request(() => iterator.next(), controller.signal);
            if (next.done) break;
            this.check(controller.signal);
            if (!(next.value instanceof Uint8Array)) throw error('invalid-bundle');
            size += next.value.byteLength;
            if (
              size > manifest.payload.components[part].sizeBytes ||
              size > KNOWLEDGE_BUNDLE_MAX_BYTES
            )
              throw error('invalid-bundle');
            chunks.push(Buffer.from(next.value));
          }
        } finally {
          void iterator.return?.().catch(() => undefined);
        }
        const bytes = Buffer.concat(chunks),
          text = bytes.toString('utf8');
        if (
          size !== manifest.payload.components[part].sizeBytes ||
          hash(bytes) !== manifest.payload.components[part].contentHash ||
          !Buffer.from(text).equals(bytes)
        )
          throw error('invalid-bundle');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw error('invalid-bundle');
        }
        const bundle = this.bundle(parsed, part, manifest);
        this.check(controller.signal);
        await this.owned(token, generation);
        const id = randomUUID();
        await this.records.write('knowledge', id, bundle, 0);
        refs[part] = id;
      }
      this.check(controller.signal);
      state = await this.owned(token, generation);
      this.verify(manifest, state.value, 'online');
      const minimumSequences = { ...state.value.minimumSequences };
      for (const part of parts)
        minimumSequences[part] = Math.max(
          minimumSequences[part],
          manifest.payload.components[part].releaseSequence,
        );
      this.check(controller.signal);
      // This single CAS publishes the complete snapshot and releases its read
      // barrier. Cancellation observed before this point never activates it;
      // once committed, cleanup failure cannot roll it back.
      state = await this.put(state, {
        ...state.value,
        observedAt: this.time(),
        minimumSequences,
        identityUnavailable: false,
        lastSyncFailure: null,
        lastSynchronizedAt: this.time(),
        active: { manifest, records: refs },
        claim: null,
      });
      this.identityUnavailableGeneration = undefined;
      // Inventory predates this claim's downloads. Only superseded immutable bodies
      // are reclaimed; a later owner's newly staged records cannot be in this list.
      await this.purge(inventory.filter((id) => !Object.values(refs).includes(id)));
      return this.readActive(state, 'online');
    } catch (cause) {
      if (generation !== undefined) {
        try {
          const state = await this.state();
          if (state.value.generation !== generation || state.value.claim?.id !== token)
            throw error('superseded');
          if (
            cause instanceof KnowledgeSyncError &&
            ['revoked', 'authentication-required'].includes(cause.code)
          ) {
            // Fail closed in this instance even if persisting the denial fails.
            // A single CAS fences this response; it cannot disable a newer login.
            this.denied = cause.code as 'revoked' | 'authentication-required';
            let inventory: string[] | undefined;
            try {
              inventory = await this.records.listIds('knowledge');
            } catch {
              /* Persist denial regardless. */
            }
            await this.put(state, {
              ...state.value,
              generation: state.value.generation + 1,
              status: this.denied,
              observedAt: this.time(),
              claim: null,
              active: null,
            });
            if (inventory) await this.purge(inventory);
          } else if (cause instanceof KnowledgeSyncError && cause.code === 'identity-unavailable') {
            this.identityUnavailableGeneration = generation;
            // Retain the credential and immutable bodies for a later authenticated
            // retry, but persist a read barrier across processes and restarts.
            // If this write fails, the existing claim remains a read barrier.
            await this.put(state, {
              ...state.value,
              identityUnavailable: true,
              observedAt: this.time(),
              claim: null,
            });
          } else if (!authorizationUncertain)
            await this.put(state, {
              ...state.value,
              ...(cause instanceof KnowledgeSyncError &&
              (cause.code === 'unavailable' || cause.code === 'timeout')
                ? { lastSyncFailure: cause.code }
                : {}),
              claim: null,
            });
        } catch {
          /* A newer generation owns the index; never overwrite its decision. */
        }
      }
      if (cause instanceof KnowledgeSyncError || cause instanceof LocalStoreError) throw cause;
      throw error('unavailable');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
    }
  }
  private async purge(ids: string[]) {
    let pending = false;
    for (const id of ids) {
      try {
        const record = await this.records.read('knowledge', id);
        if (!record) continue;
        if (record.deleted) {
          if (!(await this.records.purgeDeleted('knowledge', id))) pending = true;
        } else if ((await this.records.remove('knowledge', id, record.revision)).cleanupPending)
          pending = true;
      } catch {
        pending = true;
      }
    }
    return pending;
  }
  /** A negative response from another authenticated API is scoped to the cache
   * generation that sent it. It cannot revoke a replacement connection. */
  async rejectAuthority(
    generation: number,
    reason: 'revoked' | 'authentication-required' | 'identity-unavailable',
  ) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const state = await this.state();
      if (state.value.generation !== generation) throw error('superseded');
      try {
        if (reason === 'identity-unavailable') {
          this.identityUnavailableGeneration = generation;
          await this.put(state, {
            ...state.value,
            identityUnavailable: true,
            observedAt: this.time(),
            claim: null,
          });
        } else {
          this.denied = reason;
          let inventory: string[] | undefined;
          try {
            inventory = await this.records.listIds('knowledge');
          } catch {
            /* Persist the barrier even if cleanup inventory fails. */
          }
          await this.put(state, {
            ...state.value,
            generation: generation + 1,
            status: reason,
            observedAt: this.time(),
            claim: null,
            active: null,
          });
          if (inventory) await this.purge(inventory);
        }
        return;
      } catch (cause) {
        if (!(cause instanceof LocalStoreError) || cause.code !== 'revision-conflict') throw cause;
        // A newer synchronization or explicit login owns its own generation.
        const current = await this.state();
        if (current.value.generation !== generation) {
          if (current.value.status === 'enabled') this.denied = undefined;
          throw error('superseded');
        }
      }
    }
    throw error('superseded');
  }
  async disable(reason: 'disconnected' | 'authentication-required' | 'revoked' = 'disconnected') {
    this.denied = reason;
    // Capture only pre-disconnect bodies, so cleanup cannot delete a resumed
    // generation's downloads. Listing failure must not prevent disabling access.
    let inventory: string[] | undefined;
    try {
      inventory = await this.records.listIds('knowledge');
    } catch {
      /* Report pending cleanup. */
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const state = await this.state();
      try {
        const next = await this.put(state, {
          ...state.value,
          generation: state.value.generation + 1,
          status: reason,
          observedAt: this.time(),
          claim: null,
          active: null,
        });
        const cleanupPending = inventory ? await this.purge(inventory) : true;
        return { generation: next.value.generation, cleanupPending };
      } catch (cause) {
        if (!(cause instanceof LocalStoreError) || cause.code !== 'revision-conflict') throw cause;
      }
    }
    throw error('superseded');
  }
  /** Host calls only after a new explicit authorization for the same server/audience. Floors survive reconnection. */
  async resume(expectedGeneration: number) {
    const state = await this.state();
    if (state.value.generation !== expectedGeneration || state.value.status === 'enabled')
      throw error('superseded');
    const next = await this.put(state, {
      ...state.value,
      generation: state.value.generation + 1,
      status: 'enabled',
      observedAt: this.time(),
      claim: null,
      active: null,
    });
    this.denied = undefined;
    return next.value.generation;
  }
}
