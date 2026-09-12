import { createHash } from 'node:crypto';
import {
  mkdtemp,
  rm,
  unlink,
  readdir,
  readFile,
  realpath,
  writeFile,
  cp,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type LocalScope } from '@gcr/client-contract';
import { type LocalKeyStore } from './local-credentials.js';
import { LocalRecordStore } from './local-records.js';
import { LocalKnowledgeStore, type LocalKnowledgeDraft } from './local-knowledge.js';
import { LocalStoreError } from './local-errors.js';
import * as privateFiles from './private-files.js';

class TestKeys implements LocalKeyStore {
  values = new Map<string, Buffer>();
  unavailable = false;
  writes = 0;
  async read(reference: string) {
    if (this.unavailable)
      throw new LocalStoreError('credential-unavailable', 'Synthetic locked key store.');
    const value = this.values.get(reference);
    return value ? Buffer.from(value) : undefined;
  }
  async write(reference: string, key: Uint8Array) {
    if (this.unavailable)
      throw new LocalStoreError('credential-unavailable', 'Synthetic locked key store.');
    this.writes++;
    this.values.set(reference, Buffer.from(key));
  }
  async remove(reference: string) {
    this.values.delete(reference);
  }
}
const profile: LocalScope = { kind: 'profile', profileId: 'profile-fixture' };
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const memory: LocalKnowledgeDraft = {
  kind: 'memory',
  title: 'Return contract',
  body: 'NEVER_PLAINTEXT_PRIVATE_MEMORY',
  rationale: 'Caller compatibility',
  counterEvidence: [],
  appliesTo: { paths: ['src/**'], languages: ['typescript'], symbols: [], branches: [] },
  sources: [{ kind: 'user-note', id: 'note-fixture' }],
};
const resources: Array<{ root: string; stores: LocalRecordStore[] }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of resources.splice(0)) {
    for (const store of f.stores) store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'gcr-local-records-'));
  const stores: LocalRecordStore[] = [];
  resources.push({ root, stores });
  const keys = new TestKeys();
  const open = async (scope: LocalScope = profile) => {
    const store = await LocalRecordStore.open({ dataDirectory: root, scope, keys });
    stores.push(store);
    return store;
  };
  return { root, keys, open };
}
async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await files(target)));
    else result.push(target);
  }
  return result;
}
const recordDir = (root: string, id: string) =>
  path.join(root, 'profiles', profile.profileId, 'local', 'profile', 'knowledge', id);

describe('encrypted local revisions', () => {
  it('restores after reopen, stores no plaintext/key bytes, and does not serialize its master key', async () => {
    const f = await setup();
    const first = await f.open();
    const value = { message: 'NEVER_PLAINTEXT_PRIVATE_MEMORY' };
    await first.write('knowledge', 'item', value, 0);
    const master = [...f.keys.values.values()][0]!;
    expect(JSON.stringify(first)).not.toContain(JSON.stringify([...master]));
    expect(Reflect.set(first.scope, 'profileId', 'other')).toBe(false);
    first.close();
    await expect(first.read('knowledge', 'item')).rejects.toMatchObject({ code: 'store-closed' });
    const reopened = await f.open();
    expect(await reopened.read('knowledge', 'item')).toEqual({
      revision: 1,
      deleted: false,
      value,
    });
    expect(f.keys.writes).toBe(1);
    for (const file of await files(f.root)) {
      const bytes = await readFile(file);
      expect(bytes.includes(value.message)).toBe(false);
      expect(bytes.includes(master)).toBe(false);
      expect(bytes.includes(master.toString('base64'))).toBe(false);
      expect((await stat(file)).mode & 0o077).toBe(0);
    }
  });
  it('elects one OS key reference and commits one winner under concurrent first-open/write', async () => {
    const f = await setup();
    const stores = await Promise.all(Array.from({ length: 12 }, () => f.open()));
    expect(f.keys.values.size).toBe(1);
    const writes = await Promise.allSettled(
      stores.map((store, index) => store.write('knowledge', 'race', { index }, 0)),
    );
    expect(writes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of writes)
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ code: 'revision-conflict' });
    const winner = await stores[0]!.read('knowledge', 'race');
    for (const store of stores) expect(await store.read('knowledge', 'race')).toEqual(winner);
  });
  it('captures mutable caller data before asynchronous I/O', async () => {
    const f = await setup();
    const store = await f.open();
    const value = { nested: { body: 'before' } };
    const pending = store.write('knowledge', 'item', value, 0);
    value.nested.body = 'after';
    expect(await pending).toMatchObject({ value: { nested: { body: 'before' } } });
    expect(await store.read('knowledge', 'item')).toMatchObject({
      value: { nested: { body: 'before' } },
    });
  });
  it('keeps tombstone markers after body cleanup so stale writers cannot recreate a removed revision', async () => {
    const f = await setup();
    const store = await f.open();
    await store.write('knowledge', 'item', { body: 'first' }, 0);
    await store.write('knowledge', 'item', { body: 'second' }, 1);
    expect(await store.remove('knowledge', 'item', 2)).toEqual({
      revision: 3,
      cleanupPending: false,
    });
    expect(await store.read('knowledge', 'item')).toEqual({ revision: 3, deleted: true });
    for (const revision of [0, 1, 2, 3])
      await expect(
        store.write('knowledge', 'item', { body: 'stale' }, revision),
      ).rejects.toMatchObject({ code: 'revision-conflict' });
    expect(
      (await readdir(recordDir(f.root, 'item'))).filter((name) => name.endsWith('.json')),
    ).toHaveLength(3);
    expect(await readdir(path.join(recordDir(f.root, 'item'), 'blobs'))).toHaveLength(1);
  });
  it('preserves the previous revision on disk failure and reports an ambiguous committed revision without deleting it', async () => {
    const f = await setup();
    const store = await f.open();
    await store.write('knowledge', 'item', { body: 'first' }, 0);
    const original = privateFiles.publishImmutable;
    const publish = vi.spyOn(privateFiles, 'publishImmutable');
    publish.mockRejectedValueOnce(
      Object.assign(new Error('Synthetic disk-full failure.'), { code: 'ENOSPC' }),
    );
    await expect(store.write('knowledge', 'item', { body: 'lost' }, 1)).rejects.toMatchObject({
      code: 'ENOSPC',
    });
    expect(await store.read('knowledge', 'item')).toMatchObject({
      revision: 1,
      value: { body: 'first' },
    });
    publish.mockImplementation(async (file, bytes) => {
      const committed = await original(file, bytes);
      if (file.endsWith('000000000002.json'))
        throw new LocalStoreError('commit-unknown', 'Synthetic fsync failure after publication.');
      return committed;
    });
    await expect(store.write('knowledge', 'item', { body: 'second' }, 1)).rejects.toMatchObject({
      code: 'commit-unknown',
    });
    expect(await store.read('knowledge', 'item')).toMatchObject({
      revision: 2,
      value: { body: 'second' },
    });
  });
  it('reports pending cleanup without hiding that deletion already committed', async () => {
    const f = await setup();
    const store = await f.open();
    await store.write('knowledge', 'item', { body: 'private' }, 0);
    vi.spyOn(store, 'purgeDeleted').mockRejectedValueOnce(new Error('Synthetic cleanup failure.'));
    expect(await store.remove('knowledge', 'item', 1)).toEqual({
      revision: 2,
      cleanupPending: true,
    });
    expect(await store.read('knowledge', 'item')).toEqual({ revision: 2, deleted: true });
    expect(await store.purgeDeleted('knowledge', 'item')).toBe(true);
  });
  it('binds encrypted data to profile/repository/worktree and refuses copied records', async () => {
    const f = await setup();
    const scope: LocalScope = {
      kind: 'repository',
      profileId: profile.profileId,
      repositoryKey: hash('repository'),
      worktreeKey: hash('worktree-one'),
    };
    const first = await f.open(scope);
    const otherScope = { ...scope, worktreeKey: hash('worktree-two') };
    const second = await f.open(otherScope);
    await first.write('knowledge', 'item', { body: 'private' }, 0);
    expect(await second.read('knowledge', 'item')).toBeUndefined();
    const repoDir = path.join(
      f.root,
      'profiles',
      profile.profileId,
      'local',
      'repositories',
      scope.repositoryKey,
    );
    await cp(
      path.join(repoDir, scope.worktreeKey, 'knowledge', 'item'),
      path.join(repoDir, otherScope.worktreeKey, 'knowledge', 'item'),
      { recursive: true },
    );
    await expect(second.read('knowledge', 'item')).rejects.toMatchObject({
      code: 'corrupt-storage',
    });
    const otherProfile = await f.open({ kind: 'profile', profileId: 'another-profile' });
    expect(await otherProfile.read('knowledge', 'item')).toBeUndefined();
    expect(f.keys.values.size).toBe(2);
  });
  it('rejects a modified latest ciphertext even after its public digest is rewritten; no old revision fallback', async () => {
    const f = await setup();
    const store = await f.open();
    await store.write('knowledge', 'item', { body: 'first' }, 0);
    await store.write('knowledge', 'item', { body: 'second' }, 1);
    const markerPath = path.join(recordDir(f.root, 'item'), '000000000002.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    const blobPath = path.join(recordDir(f.root, 'item'), 'blobs', marker.blob);
    const envelope = JSON.parse(await readFile(blobPath, 'utf8'));
    envelope.tag = Buffer.alloc(16).toString('base64');
    const bytes = Buffer.from(JSON.stringify(envelope));
    await writeFile(blobPath, bytes);
    marker.sha256 = hash(bytes);
    await writeFile(markerPath, JSON.stringify(marker));
    await expect(store.read('knowledge', 'item')).rejects.toMatchObject({
      code: 'corrupt-storage',
    });
  });
  it('never generates a replacement key or plaintext store when an existing OS key is missing/locked', async () => {
    const f = await setup();
    const store = await f.open();
    await store.write('knowledge', 'item', { body: 'private' }, 0);
    store.close();
    const writes = f.keys.writes;
    f.keys.unavailable = true;
    await expect(f.open()).rejects.toMatchObject({ code: 'credential-unavailable' });
    f.keys.unavailable = false;
    f.keys.values.clear();
    await expect(f.open()).rejects.toMatchObject({ code: 'credential-unavailable' });
    expect(f.keys.writes).toBe(writes);
  });
});

it('refuses a missing key reference over existing data instead of creating a new master key', async () => {
  const f = await setup();
  const store = await f.open();
  await store.write('knowledge', 'item', { body: 'private' }, 0);
  store.close();
  const writes = f.keys.writes;
  await unlink(path.join(f.root, 'profiles', profile.profileId, 'local', 'key-ref.json'));
  await expect(f.open()).rejects.toMatchObject({ code: 'credential-unavailable' });
  expect(f.keys.writes).toBe(writes);
  expect((await files(f.root)).some((file) => file.endsWith('.enc'))).toBe(true);
});

it('moves a reader to the committed tombstone when concurrent cleanup removes its selected body', async () => {
  const f = await setup();
  const store = await f.open();
  await store.write('knowledge', 'item', { body: 'private' }, 0);
  const marker = JSON.parse(
    await readFile(path.join(recordDir(f.root, 'item'), '000000000001.json'), 'utf8'),
  );
  const oldBlob = await realpath(path.join(recordDir(f.root, 'item'), 'blobs', marker.blob));
  const original = privateFiles.readPrivateFile;
  let deleted = false;
  vi.spyOn(privateFiles, 'readPrivateFile').mockImplementation(async (file, limit) => {
    if (file === oldBlob && !deleted) {
      deleted = true;
      await store.remove('knowledge', 'item', 1);
    }
    return original(file, limit);
  });
  expect(await store.read('knowledge', 'item')).toEqual({ revision: 2, deleted: true });
  expect(deleted).toBe(true);
});

describe('user-owned local knowledge', () => {
  it('persists candidate/edit/activation/archive/delete with explicit revision conflicts', async () => {
    const f = await setup();
    const records = await f.open();
    const knowledge = new LocalKnowledgeStore(records);
    const candidate = await knowledge.create(memory);
    expect(candidate.state).toBe('candidate');
    expect(await knowledge.active()).toEqual([]);
    const active = await knowledge.setState(candidate.id, 1, 'active');
    expect(active.revision).toBe(2);
    expect(active.hash).not.toBe(candidate.hash);
    await expect(knowledge.edit(candidate.id, 1, { body: 'stale' })).rejects.toMatchObject({
      code: 'revision-conflict',
    });
    const edited = await knowledge.edit(candidate.id, 2, { body: 'Updated return contract.' });
    expect((await knowledge.active())[0]!.body).toBe(edited.body);
    await knowledge.setState(candidate.id, 3, 'archived');
    expect(await knowledge.active()).toEqual([]);
    records.close();
    const reopened = new LocalKnowledgeStore(await f.open());
    expect((await reopened.get(candidate.id))!.state).toBe('archived');
    await reopened.remove(candidate.id, 4);
    expect(await reopened.get(candidate.id)).toBeUndefined();
    expect(await reopened.list()).toEqual([]);
  });
  it('stores full review-only Skill text and imports/exports explicitly without reusing scope or activation', async () => {
    const f = await setup();
    const knowledge = new LocalKnowledgeStore(await f.open());
    const skill = await knowledge.create({
      kind: 'skill',
      title: 'Callers',
      body: '# Review\nRead the caller and counter-evidence.',
      reviewOnly: true,
      origin: 'user-authored',
      appliesTo: { paths: [], languages: [], symbols: [], branches: [] },
      sources: [],
    });
    const active = await knowledge.setState(skill.id, 1, 'active');
    const target = path.join(f.root, 'explicit-export.json');
    await knowledge.exportFile(skill.id, target);
    expect((await stat(target)).mode & 0o077).toBe(0);
    await expect(knowledge.exportFile(skill.id, target)).rejects.toMatchObject({
      code: 'revision-conflict',
    });
    const other = new LocalKnowledgeStore(
      await f.open({ kind: 'profile', profileId: 'other-profile' }),
    );
    const imported = await other.importKnowledge(JSON.parse(await readFile(target, 'utf8')));
    expect(imported.id).not.toBe(skill.id);
    expect(imported.scope.profileId).toBe('other-profile');
    expect(imported.state).toBe('candidate');
    expect(imported.body).toBe(active.body);
    expect(imported.kind === 'skill' && imported.reviewOnly).toBe(true);
    expect(imported.sources.at(-1)?.kind).toBe('import');
  });
  it('filters expired context, preserves import dates, and allows explicitly clearing an expiry', async () => {
    const f = await setup();
    const records = await f.open();
    const old = new LocalKnowledgeStore(records, () => new Date('2026-01-01T00:00:00.000Z'));
    const candidate = await old.create({ ...memory, expiresAt: '2026-01-02T00:00:00.000Z' });
    await old.setState(candidate.id, 1, 'active');
    const now = new LocalKnowledgeStore(records, () => new Date('2026-09-13T00:00:00.000Z'));
    expect(await now.active()).toEqual([]);
    const imported = await now.importKnowledge(JSON.parse(await old.exportKnowledge(candidate.id)));
    expect(imported.expiresAt).toBe('2026-01-02T00:00:00.000Z');
    expect(imported.createdAt).toBe(candidate.createdAt);
    expect(imported.state).toBe('candidate');
    const cleared = await now.edit(candidate.id, 2, { expiresAt: null });
    expect(cleared.expiresAt).toBeUndefined();
    expect((await now.active()).map((item) => item.id)).toEqual([candidate.id]);
  });
});
