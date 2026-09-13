import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalKnowledgeJson,
  centralCacheIndex,
  encodeKnowledgeBundle,
  KNOWLEDGE_SIGNATURE_CONTEXT,
  type CentralKnowledgeBundle,
  type KnowledgeManifestPayload,
  type LocalScope,
} from '@gcr/client-contract';
import { CentralKnowledgeCache, type KnowledgeTransport } from './central-cache.js';
import {
  KnowledgeSyncError,
  TrustedCentralBinding,
  normalizeCentralServerUrl,
} from './central-binding.js';
import { LocalRecordStore } from './local-records.js';
import type { LocalKeyStore } from './local-credentials.js';
import * as privateFiles from './private-files.js';
import { LocalStoreError } from './local-errors.js';

const pair = generateKeyPairSync('ed25519');
const start = Date.parse('2026-09-14T00:00:00Z');
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const audience = { serverId: 'server', tenantId: 'tenant', repositoryId: 'repo', userId: 'alice' };
const parts = ['policy', 'collective', 'personal'] as const;
const scope: LocalScope = {
  kind: 'repository',
  profileId: 'fixture',
  repositoryKey: hash('repo'),
  worktreeKey: hash('worktree'),
};
const binding = () =>
  new TrustedCentralBinding({
    serverUrl: 'https://central.test/base',
    audience,
    trustedKeys: new Map([['key', pair.publicKey]]),
  });
class Keys implements LocalKeyStore {
  values = new Map<string, Buffer>();
  async read(id: string) {
    const v = this.values.get(id);
    return v && Buffer.from(v);
  }
  async write(id: string, value: Uint8Array) {
    this.values.set(id, Buffer.from(value));
  }
  async remove(id: string) {
    this.values.delete(id);
  }
}
const resources: { root: string; stores: { close(): void }[] }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of resources.splice(0)) {
    f.stores.forEach((s) => s.close());
    await rm(f.root, { recursive: true, force: true });
  }
});
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'gcr-central-cache-'));
  const stores: { close(): void }[] = [];
  resources.push({ root, stores });
  const keys = new Keys();
  let now = start;
  const open = async (b = binding(), s = scope) => {
    const cache = await CentralKnowledgeCache.open({
      dataDirectory: root,
      keys,
      scope: s,
      binding: b,
      now: () => now,
    });
    stores.push(cache);
    return cache;
  };
  return {
    root,
    stores,
    keys,
    open,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
function fixture(version = 1, now = start, revoke = false) {
  const common = { schemaVersion: 1 as const, tenantId: 'tenant', repositoryId: 'repo' };
  const bundles: Record<(typeof parts)[number], CentralKnowledgeBundle> = {
    policy: {
      ...common,
      component: 'policy',
      ownerUserId: null,
      criteria: [],
      skills: {
        schemaVersion: 1,
        hash: hash('skills'),
        skills: Array.from({ length: 4 }, (_, i) => ({
          name: `skill-${i}`,
          title: 'Review',
          kind: 'perspective',
          unit: 'file',
          version: 1,
          enabled: true,
          instructions: 'PRIVATE_CENTRAL_POLICY',
          markdown: '# Review',
          contentHash: hash('skill'),
        })),
      },
    },
    collective: { ...common, component: 'collective', ownerUserId: null, memories: [] },
    personal: {
      ...common,
      component: 'personal',
      ownerUserId: 'alice',
      memories:
        version === 1
          ? []
          : [
              {
                id: 'memory',
                revision: version,
                contentHash: hash('projection'),
                sourceRevision: version,
                sourceContentHash: hash('source'),
                kind: 'decision',
                content: {
                  summary: `PRIVATE_PERSONAL_${version}`,
                  detail: '',
                  recommendation: '',
                  categories: [],
                  appliesTo: {
                    languages: [],
                    filePaths: [],
                    symbols: [],
                    contracts: [],
                    branches: [],
                  },
                  counterEvidence: [],
                  expiresAt: null,
                },
                sources: [{ kind: 'memory', id: 'source', contentHash: hash('source') }],
                sourceBaseSha: null,
                sourceHeadSha: null,
                supersedesId: null,
              },
            ],
    },
  };
  const bytes = Object.fromEntries(
    parts.map((p) => [p, Buffer.from(encodeKnowledgeBundle(bundles[p]))]),
  ) as Record<(typeof parts)[number], Buffer>;
  const payload: KnowledgeManifestPayload = {
    schemaVersion: 1,
    audience,
    snapshotId: `snapshot-${version}`,
    authorizationRevision: 1,
    components: Object.fromEntries(
      parts.map((p) => [
        p,
        {
          bundleId: `${p}-${version}`,
          releaseSequence: p === 'personal' ? version : 1,
          contentHash: hash(bytes[p]),
          sizeBytes: bytes[p].length,
        },
      ]),
    ) as KnowledgeManifestPayload['components'],
    revocations: {
      policyMinimumSequence: 1,
      collectiveMinimumSequence: 1,
      personalMinimumSequence: revoke ? version : 1,
    },
    compatibleClientContracts: { minimum: 2, maximum: 2 },
    issuedAt: new Date(now).toISOString(),
    refreshAfter: new Date(now + 300000).toISOString(),
    offlineValidUntil: new Date(now + 86400000).toISOString(),
    signingKeyId: 'key',
  };
  const signed = () => {
    const canonical = canonicalKnowledgeJson(payload);
    return {
      payload,
      manifestHash: hash(canonical),
      signature: sign(
        null,
        Buffer.from(KNOWLEDGE_SIGNATURE_CONTEXT + canonical),
        pair.privateKey,
      ).toString('base64url'),
    };
  };
  const calls: string[] = [];
  const transport: KnowledgeTransport = {
    async manifest() {
      return { status: 200, manifest: signed() };
    },
    async bundle({ component }) {
      calls.push(component);
      return {
        status: 200,
        body: (async function* () {
          yield bytes[component];
        })(),
      };
    },
  };
  return { payload, signed, bytes, bundles, calls, transport };
}
async function files(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    out.push(...(e.isDirectory() ? await files(p) : [p]));
  }
  return out;
}
function gate<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('trusted central binding', () => {
  it('preserves a canonical base path and isolates explicit audiences while pins can rotate', () => {
    expect(normalizeCentralServerUrl('https://CENTRAL.test:443/base/path')).toBe(
      'https://central.test/base/path/',
    );
    expect(normalizeCentralServerUrl('http://localhost:8080/base', true)).toBe(
      'http://localhost:8080/base/',
    );
    const pins = new Map([['key', pair.publicKey]]);
    const original = new TrustedCentralBinding({
      serverUrl: 'https://central.test/base/',
      audience,
      trustedKeys: pins,
    });
    pins.clear();
    expect(original.verificationKeys().size).toBe(1);
    const rotated = new TrustedCentralBinding({
      serverUrl: original.serverUrl,
      audience,
      trustedKeys: new Map([['next', generateKeyPairSync('ed25519').publicKey]]),
    });
    expect(rotated.id).toBe(original.id);
    for (const field of Object.keys(audience))
      expect(
        new TrustedCentralBinding({
          serverUrl: original.serverUrl,
          audience: { ...audience, [field]: 'other' },
          trustedKeys: original.verificationKeys(),
        }).id,
      ).not.toBe(original.id);
  });
  it.each([
    'https://u:password@central.test',
    'https://central.test/a/../b',
    'https://central.test/%2e%2e/b',
    'https://central.test/a%2fb',
    'https://central.test/a%252fb',
    'https://central.test//base',
    'https://central.test/base?token=secret',
    'https://central.test/#x',
    'http://central.test',
    'http://localhost',
  ])('rejects unsafe configured URL %s', (url) => {
    expect(() => normalizeCentralServerUrl(url)).toThrow('Explicit trusted server');
  });
});

describe('encrypted central snapshot synchronization', () => {
  it('uses independent Node processes to enforce claim ownership and fence a stale process', async () => {
    const f = await setup();
    const cache = await f.open();
    const children: ChildProcess[] = [];
    const launch = (data: ReturnType<typeof fixture>, now: number, pause: boolean) => {
      const child = fork(
        new URL('../test-fixtures/central-cache-process.mjs', import.meta.url),
        [],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
      );
      children.push(child);
      const entered = gate<void>();
      const completed = gate<{ code?: string; snapshotId?: string }>();
      child.on('message', (message: { event: string; code?: string; snapshotId?: string }) => {
        if (message.event === 'manifest') entered.resolve();
        if (message.event === 'result') completed.resolve(message);
      });
      child.send({
        action: 'start',
        root: f.root,
        scope,
        serverUrl: binding().serverUrl,
        manifest: data.signed(),
        bytes: Object.fromEntries(parts.map((p) => [p, data.bytes[p].toString('base64')])),
        keys: [...f.keys.values].map(([id, key]) => [id, key.toString('base64')]),
        publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }),
        now,
        pause,
      });
      return {
        entered: entered.promise,
        completed: completed.promise,
        release: () => child.send({ action: 'release', now: start + 120001 }),
      };
    };
    try {
      const old = launch(fixture(), start, true);
      await old.entered;
      const contender = launch(fixture(), start, false);
      expect(await contender.completed).toMatchObject({ code: 'busy' });
      const successor = launch(fixture(2, start + 120001), start + 120001, false);
      expect(await successor.completed).toMatchObject({ snapshotId: 'snapshot-2' });
      old.release();
      expect(await old.completed).toMatchObject({ code: 'superseded' });
      f.advance(120001);
      expect((await cache.read()).manifest.payload.snapshotId).toBe('snapshot-2');
    } finally {
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) return resolve();
              child.once('exit', () => resolve());
              child.kill('SIGKILL');
            }),
        ),
      );
    }
  }, 15000);

  it('rechecks the offline lease after disk reads finish', async () => {
    const f = await setup();
    const cache = await f.open();
    await cache.synchronize(fixture().transport);
    const original = LocalRecordStore.prototype.read;
    vi.spyOn(LocalRecordStore.prototype, 'read').mockImplementation(async function (kind, id) {
      const value = await original.call(this, kind, id);
      if (kind === 'knowledge') f.advance(30000000);
      return value;
    });
    await expect(cache.read()).rejects.toMatchObject({ code: 'invalid-manifest' });
  });

  it('keeps account, profile and worktree cache namespaces distinct', async () => {
    const f = await setup();
    await (await f.open()).synchronize(fixture().transport);
    const otherUser = new TrustedCentralBinding({
      serverUrl: binding().serverUrl,
      audience: { ...audience, userId: 'bob' },
      trustedKeys: binding().verificationKeys(),
    });
    await expect((await f.open(otherUser)).read()).rejects.toMatchObject({
      code: 'cache-unavailable',
    });
    await expect(
      (await f.open(binding(), { ...scope, profileId: 'other' })).read(),
    ).rejects.toMatchObject({ code: 'cache-unavailable' });
    await expect(
      (await f.open(binding(), { ...scope, worktreeKey: hash('other') })).read(),
    ).rejects.toMatchObject({ code: 'cache-unavailable' });
  });

  it('retains a complete new snapshot after an ambiguous activation commit instead of rolling back', async () => {
    const f = await setup();
    const cache = await f.open();
    await cache.synchronize(fixture().transport);
    const original = LocalRecordStore.prototype.write;
    let injected = false;
    vi.spyOn(LocalRecordStore.prototype, 'write').mockImplementation(
      async function (kind, id, value, revision) {
        const result = await original.call(this, kind, id, value, revision);
        if (
          !injected &&
          kind === 'settings' &&
          (value as { active?: { manifest: { payload: { snapshotId: string } } } }).active?.manifest
            .payload.snapshotId === 'snapshot-2'
        ) {
          injected = true;
          throw new LocalStoreError(
            'commit-unknown',
            'Synthetic activation durability uncertainty',
          );
        }
        return result;
      },
    );
    await expect(cache.synchronize(fixture(2).transport)).rejects.toMatchObject({
      code: 'commit-unknown',
    });
    expect(injected).toBe(true);
    expect((await (await f.open()).read()).manifest.payload.snapshotId).toBe('snapshot-2');
  });

  it('activates all components atomically, reopens encrypted data, and preserves isolated local records', async () => {
    const f = await setup();
    const cache = await f.open();
    const data = fixture();
    const local = await LocalRecordStore.open({ dataDirectory: f.root, keys: f.keys, scope });
    f.stores.push(local);
    await local.write('knowledge', 'local', { body: 'LOCAL_PRIVATE' }, 0);
    const result = await cache.synchronize(data.transport);
    expect(result.bundles).toEqual(data.bundles);
    expect(data.calls).toEqual([...parts]);
    cache.close();
    expect((await (await f.open()).read()).manifest).toEqual(data.signed());
    expect((await local.read('knowledge', 'local'))?.value).toEqual({ body: 'LOCAL_PRIVATE' });
    expect(f.keys.values.size).toBe(2);
    for (const file of await files(f.root)) {
      const bytes = await readFile(file);
      expect(bytes.includes('PRIVATE_CENTRAL_POLICY')).toBe(false);
      expect(bytes.includes('LOCAL_PRIVATE')).toBe(false);
      for (const key of f.keys.values.values()) expect(bytes.includes(key)).toBe(false);
    }
  });
  it('downloads only changed personal bytes and does not extend leases on 304', async () => {
    const f = await setup();
    const cache = await f.open();
    await cache.synchronize(fixture().transport);
    const next = fixture(2);
    await cache.synchronize(next.transport);
    expect(next.calls).toEqual(['personal']);
    const manifest = vi.fn(async () => ({ status: 304 as const }));
    const transport = { ...next.transport, manifest };
    expect((await cache.synchronize(transport)).manifest.payload.offlineValidUntil).toBe(
      next.payload.offlineValidUntil,
    );
    expect(manifest.mock.calls[0]?.[0]).toMatchObject({ etag: `"${next.signed().manifestHash}"` });
    f.advance(300000);
    await expect(cache.synchronize(transport)).rejects.toMatchObject({ code: 'invalid-manifest' });
    expect((await cache.read()).manifest.payload.snapshotId).toBe('snapshot-2');
    f.advance(86400000);
    await expect(cache.read()).rejects.toMatchObject({ code: 'invalid-manifest' });
  });
  it.each([false, true])(
    'keeps the previous pointer on personal failure; explicit revocation=%s controls fallback',
    async (revoke) => {
      const f = await setup();
      const cache = await f.open();
      await cache.synchronize(fixture().transport);
      const next = fixture(2, start, revoke);
      next.transport.bundle = async () => ({ status: 503 });
      await expect(cache.synchronize(next.transport)).rejects.toMatchObject({
        code: 'unavailable',
      });
      const reopened = await f.open();
      if (revoke) await expect(reopened.read()).rejects.toMatchObject({ code: 'invalid-manifest' });
      else expect((await reopened.read()).manifest.payload.snapshotId).toBe('snapshot-1');
    },
  );
  it('persists authorization revocation before a failed download and rejects sequence replay after activation', async () => {
    const f = await setup();
    const cache = await f.open();
    await cache.synchronize(fixture(2).transport);
    await expect(cache.synchronize(fixture().transport)).rejects.toMatchObject({
      code: 'invalid-manifest',
    });
    const next = fixture(3);
    next.payload.authorizationRevision = 2;
    next.transport.bundle = async () => ({ status: 503 });
    await expect(cache.synchronize(next.transport)).rejects.toMatchObject({ code: 'unavailable' });
    await expect((await f.open()).read()).rejects.toMatchObject({ code: 'invalid-manifest' });
  });
  it.each(['hash', 'size', 'schema', 'audience', 'utf8', 'owner'])(
    'rejects %s corruption without activating a first snapshot',
    async (kind) => {
      const f = await setup();
      const cache = await f.open();
      const data = fixture();
      if (kind === 'audience') data.payload.audience = { ...audience, userId: 'bob' };
      else if (['schema', 'utf8', 'owner'].includes(kind)) {
        data.bytes.personal =
          kind === 'schema'
            ? Buffer.from('{"unexpected":"data"}')
            : kind === 'utf8'
              ? Buffer.from([0xff])
              : Buffer.from(
                  encodeKnowledgeBundle({ ...data.bundles.personal, ownerUserId: 'bob' }),
                );
        data.payload.components.personal.contentHash = hash(data.bytes.personal);
        data.payload.components.personal.sizeBytes = data.bytes.personal.length;
      } else
        data.bytes.personal =
          kind === 'size'
            ? Buffer.alloc(data.bytes.personal.length + 1)
            : Buffer.alloc(data.bytes.personal.length);
      await expect(cache.synchronize(data.transport)).rejects.toMatchObject({
        code: kind === 'audience' ? 'invalid-manifest' : 'invalid-bundle',
      });
      await expect(cache.read()).rejects.toMatchObject({ code: 'cache-unavailable' });
    },
  );
  it.each(['manifest', 'bundle'] as const)(
    'persists identity failure from %s and requires authenticated recovery',
    async (stage) => {
      const f = await setup();
      const cache = await f.open();
      const first = fixture();
      const pinned = await cache.synchronize(first.transport);
      const next = fixture(2);
      const failed = {
        ...next.transport,
        [stage]: async () => {
          throw new KnowledgeSyncError('identity-unavailable', 'Identity unavailable');
        },
      };
      await expect(cache.synchronize(failed)).rejects.toMatchObject({
        code: 'identity-unavailable',
      });
      const reopened = await f.open();
      for (const instance of [cache, reopened]) {
        for (const mode of ['online', 'offline'] as const)
          await expect(instance.read(mode)).rejects.toMatchObject({ code: 'identity-unavailable' });
        await expect(instance.observeSnapshot(pinned.manifest, 'online')).rejects.toMatchObject({
          code: 'identity-unavailable',
        });
      }
      await expect(
        reopened.synchronize({ ...first.transport, manifest: async () => ({ status: 503 }) }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      await expect(reopened.read()).rejects.toMatchObject({ code: 'identity-unavailable' });
      // Another process can recover this scope without deleting or re-entering credentials.
      await reopened.synchronize(first.transport);
      expect((await cache.read()).manifest).toEqual(first.signed());
    },
  );
  it('clears an identity barrier on authenticated 304 without extending the lease', async () => {
    const f = await setup();
    const cache = await f.open();
    const data = fixture();
    const before = await cache.synchronize(data.transport);
    await expect(
      cache.synchronize({
        ...data.transport,
        manifest: async () => {
          throw new KnowledgeSyncError('identity-unavailable', 'Identity unavailable');
        },
      }),
    ).rejects.toMatchObject({ code: 'identity-unavailable' });
    f.advance(1000);
    const after = await cache.synchronize({
      ...data.transport,
      manifest: async () => ({ status: 304 }),
    });
    expect(after.lastSynchronizedAt).toBe(start + 1000);
    expect(after.manifest).toEqual(before.manifest);
    expect((await (await f.open()).read()).manifest).toEqual(before.manifest);
  });
  it('keeps the claim barrier when persisting identity failure runs out of disk space', async () => {
    const f = await setup();
    const cache = await f.open();
    const data = fixture();
    const pinned = await cache.synchronize(data.transport);
    await expect(
      cache.synchronize({
        ...data.transport,
        manifest: async () => {
          vi.spyOn(privateFiles, 'publishImmutable').mockRejectedValue(
            Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' }),
          );
          throw new KnowledgeSyncError('identity-unavailable', 'Identity unavailable');
        },
      }),
    ).rejects.toMatchObject({ code: 'identity-unavailable' });
    await expect(cache.observeSnapshot(pinned.manifest, 'online')).rejects.toMatchObject({
      code: 'identity-unavailable',
    });
    vi.restoreAllMocks();
    const reopened = await f.open();
    f.advance(120001);
    await expect(reopened.read()).rejects.toMatchObject({ code: 'busy' });
    await reopened.synchronize(fixture(2, start + 120001).transport);
    expect((await cache.read()).manifest.payload.snapshotId).toBe('snapshot-2');
  });
  it.each([401, 403, 503] as const)(
    'distinguishes HTTP %s and persists denial across reopen',
    async (status) => {
      const f = await setup();
      const cache = await f.open();
      const data = fixture();
      await cache.synchronize(data.transport);
      await expect(
        cache.synchronize({ ...data.transport, manifest: async () => ({ status }) }),
      ).rejects.toMatchObject({
        code:
          status === 401 ? 'authentication-required' : status === 403 ? 'revoked' : 'unavailable',
      });
      if (status === 503) expect((await (await f.open()).read()).manifest).toEqual(data.signed());
      else
        await expect((await f.open()).read()).rejects.toMatchObject({
          code: status === 401 ? 'authentication-required' : 'revoked',
        });
    },
  );
  it('disconnects and resumes explicitly without deleting local knowledge or reusing an old snapshot', async () => {
    const f = await setup();
    const cache = await f.open();
    const data = fixture();
    await cache.synchronize(data.transport);
    const local = await LocalRecordStore.open({ dataDirectory: f.root, keys: f.keys, scope });
    f.stores.push(local);
    await local.write('knowledge', 'local', { keep: true }, 0);
    const disabled = await cache.disable();
    expect(disabled.cleanupPending).toBe(false);
    await expect(cache.read()).rejects.toMatchObject({ code: 'disabled' });
    await expect(cache.resume(disabled.generation - 1)).rejects.toMatchObject({
      code: 'superseded',
    });
    await cache.resume(disabled.generation);
    await expect(cache.read()).rejects.toMatchObject({ code: 'cache-unavailable' });
    const next = fixture();
    await cache.synchronize(next.transport);
    expect(next.calls).toEqual([...parts]);
    expect((await local.read('knowledge', 'local'))?.value).toEqual({ keep: true });
  });
  it('fences an expired owner and ignores its delayed denial after a newer snapshot commits', async () => {
    const f = await setup();
    const old = await f.open();
    const newer = await f.open();
    const started = gate<void>();
    const response = gate<{ status: 403 }>();
    const stale = old.synchronize({
      ...fixture().transport,
      manifest: async () => {
        started.resolve();
        return response.promise;
      },
    });
    const staleResult = expect(stale).rejects.toMatchObject({ code: 'revoked' });
    await started.promise;
    await expect(newer.synchronize(fixture().transport)).rejects.toMatchObject({ code: 'busy' });
    f.advance(120001);
    const next = fixture(2, start + 120001);
    await newer.synchronize(next.transport);
    response.resolve({ status: 403 });
    await staleResult;
    expect((await old.read()).manifest.payload.snapshotId).toBe('snapshot-2');
  });
  it('honors a delayed denial after lease expiry when no newer owner exists', async () => {
    const f = await setup();
    const cache = await f.open();
    await cache.synchronize(fixture().transport);
    const data = fixture();
    data.transport.manifest = async () => {
      f.advance(120001);
      return { status: 403 };
    };
    await expect(cache.synchronize(data.transport)).rejects.toMatchObject({ code: 'revoked' });
    await expect((await f.open()).read()).rejects.toMatchObject({ code: 'revoked' });
  });
  it.each(['cancel', 'timeout'])(
    'interrupts a non-cooperative transport on %s without activating data',
    async (mode) => {
      const f = await setup();
      const cache = await f.open();
      const started = gate<void>();
      const controller = new AbortController();
      const pending = cache.synchronize(
        {
          ...fixture().transport,
          manifest: () => {
            started.resolve();
            return new Promise(() => {});
          },
        },
        { signal: controller.signal, timeoutMs: mode === 'timeout' ? 100 : 1000 },
      );
      const assertion = expect(pending).rejects.toMatchObject({
        code: mode === 'timeout' ? 'timeout' : 'cancelled',
      });
      await started.promise;
      if (mode === 'cancel') controller.abort();
      await assertion;
      await expect(cache.read()).rejects.toMatchObject({ code: 'cache-unavailable' });
    },
  );
  it('preserves the complete active snapshot when encrypted staging fails with ENOSPC', async () => {
    const f = await setup();
    const cache = await f.open();
    await cache.synchronize(fixture().transport);
    const original = privateFiles.publishImmutable;
    vi.spyOn(privateFiles, 'publishImmutable').mockImplementation((file, bytes) => {
      if (file.includes('/knowledge/'))
        throw Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' });
      return original(file, bytes);
    });
    await expect(cache.synchronize(fixture(2).transport)).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect((await (await f.open()).read()).manifest.payload.snapshotId).toBe('snapshot-1');
  });
  it('preserves the previous pointer when disk failure occurs at the activation write', async () => {
    const f = await setup();
    const cache = await f.open();
    await cache.synchronize(fixture().transport);
    const original = LocalRecordStore.prototype.write;
    vi.spyOn(LocalRecordStore.prototype, 'write').mockImplementation(
      function (kind, id, value, revision) {
        if (
          kind === 'settings' &&
          (value as { active?: { manifest: { payload: { snapshotId: string } } } }).active?.manifest
            .payload.snapshotId === 'snapshot-2'
        )
          throw Object.assign(new Error('Synthetic index ENOSPC'), { code: 'ENOSPC' });
        return original.call(this, kind, id, value, revision);
      },
    );
    await expect(cache.synchronize(fixture(2).transport)).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect((await (await f.open()).read()).manifest.payload.snapshotId).toBe('snapshot-1');
  });
  it('does not fall back to an older snapshot when an active encrypted body is corrupt', async () => {
    const f = await setup();
    const cache = await f.open();
    await cache.synchronize(fixture().transport);
    await cache.synchronize(fixture(2).transport);
    const records = await LocalRecordStore.open({
      dataDirectory: path.join(f.root, 'central-cache', binding().id),
      keys: f.keys,
      scope,
    });
    f.stores.push(records);
    const index = await records.read('settings', 'snapshot');
    if (!index || index.deleted) throw Error('Expected an active cache index');
    const activePolicy = centralCacheIndex(index.value).active!.records.policy;
    const target = (await files(f.root)).find(
      (file) => file.includes(`/knowledge/${activePolicy}/blobs/`) && file.endsWith('.enc'),
    )!;
    const bytes = await readFile(target);
    bytes[Math.floor(bytes.length / 2)]! ^= 1;
    await writeFile(target, bytes);
    await expect((await f.open()).read()).rejects.toMatchObject({ code: 'corrupt-storage' });
  });
  it('cancels a stalled personal stream and preserves the former complete snapshot', async () => {
    const f = await setup();
    const cache = await f.open();
    await cache.synchronize(fixture().transport);
    const next = fixture(2);
    const started = gate<void>();
    const released = gate<void>();
    const controller = new AbortController();
    next.transport.bundle = async () => ({
      status: 200,
      body: (async function* () {
        started.resolve();
        await released.promise;
        yield next.bytes.personal;
      })(),
    });
    const pending = cache.synchronize(next.transport, { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await started.promise;
    controller.abort();
    await assertion;
    released.resolve();
    expect((await (await f.open()).read()).manifest.payload.snapshotId).toBe('snapshot-1');
  });
  it('fails closed in the receiving instance if a known denial cannot be persisted', async () => {
    const f = await setup();
    const cache = await f.open();
    const data = fixture();
    await cache.synchronize(data.transport);
    data.transport.manifest = async () => {
      vi.spyOn(privateFiles, 'publishImmutable').mockRejectedValue(
        Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' }),
      );
      return { status: 403 };
    };
    await expect(cache.synchronize(data.transport)).rejects.toMatchObject({ code: 'revoked' });
    await expect(cache.read()).rejects.toMatchObject({ code: 'revoked' });
    await expect(cache.synchronize(fixture().transport)).rejects.toMatchObject({ code: 'revoked' });
    vi.restoreAllMocks();
    const reopened = await f.open();
    await expect(reopened.read()).rejects.toMatchObject({ code: 'busy' });
    f.advance(120001);
    await expect(reopened.read()).rejects.toMatchObject({ code: 'busy' });
    const refreshed = fixture(2, start + 120001);
    await reopened.synchronize(refreshed.transport);
    expect((await reopened.read()).manifest.payload.snapshotId).toBe('snapshot-2');
  });
  it('requires a new synchronization if a verified revocation floor cannot be persisted', async () => {
    const f = await setup();
    const cache = await f.open();
    await cache.synchronize(fixture().transport);
    const next = fixture(2, start, true);
    next.transport.manifest = async () => {
      vi.spyOn(privateFiles, 'publishImmutable').mockRejectedValueOnce(
        Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' }),
      );
      return { status: 200, manifest: next.signed() };
    };
    await expect(cache.synchronize(next.transport)).rejects.toMatchObject({ code: 'unavailable' });
    await expect((await f.open()).read()).rejects.toMatchObject({ code: 'busy' });
  });
});
