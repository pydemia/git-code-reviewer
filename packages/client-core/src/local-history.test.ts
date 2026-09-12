import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { clientReviewReport, type LocalScope } from '@gcr/client-contract';
import { LocalRecordStore } from './local-records.js';
import { LocalHistoryStore, localChatArchive, type LocalChatArchive } from './local-history.js';
import type { LocalKeyStore } from './local-credentials.js';
const corpus = JSON.parse(
  readFileSync(
    new URL('../../../tests/fixtures/client-contract/reports.json', import.meta.url),
    'utf8',
  ),
);
const report = () => clientReviewReport(corpus.cases[0].report);
const resources: Array<{ root: string; stores: LocalRecordStore[] }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of resources.splice(0)) {
    for (const store of f.stores) store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'gcr-history-'));
  const stores: LocalRecordStore[] = [];
  resources.push({ root, stores });
  const values = new Map<string, Buffer>();
  const keys: LocalKeyStore = {
    read: async (id) => (values.has(id) ? Buffer.from(values.get(id)!) : undefined),
    write: async (id, key) => {
      values.set(id, Buffer.from(key));
    },
    remove: async (id) => {
      values.delete(id);
    },
  };
  const client = report().identity.client;
  const scope: LocalScope = {
    kind: 'repository',
    profileId: client.profileId,
    repositoryKey: client.repositoryKey,
    worktreeKey: client.worktreeKey,
  };
  const open = async () => {
    const store = await LocalRecordStore.open({ dataDirectory: root, scope, keys });
    stores.push(store);
    return store;
  };
  const now = () => new Date('2026-01-02T00:00:00.000Z');
  return { open, scope, now };
}
function chat(scope: LocalScope): LocalChatArchive {
  return {
    formatVersion: 1,
    id: 'chat-fixture',
    scope,
    title: 'Synthetic conversation',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    messages: [
      {
        id: 'message-user',
        role: 'user',
        content: 'NEVER_PLAINTEXT_CHAT: explain the return contract.',
        at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'message-assistant',
        role: 'assistant',
        content: 'Synthetic stored answer, not a model execution.',
        at: '2026-01-01T00:01:00.000Z',
      },
    ],
  };
}
it('restores full review/chat history and retention settings after reopening', async () => {
  const f = await setup();
  const records = await f.open();
  const history = new LocalHistoryStore(records, f.now);
  expect(await history.saveReview(report())).toEqual({ revision: 1, retentionPending: false });
  expect(await history.saveChat(chat(f.scope), 0)).toEqual({
    revision: 1,
    retentionPending: false,
  });
  const policy = {
    reviews: { maxAgeDays: 30, maxEntries: 100 },
    chats: { maxAgeDays: 60, maxEntries: 200 },
  };
  await history.configureRetention(policy, 0);
  records.close();
  const reopened = new LocalHistoryStore(await f.open(), f.now);
  expect(await reopened.getReview(report().runId)).toEqual(report());
  expect((await reopened.getChat('chat-fixture'))!.chat).toEqual(chat(f.scope));
  expect(await reopened.getRetention()).toEqual({ revision: 1, policy });
  await expect(reopened.configureRetention(policy, 0)).rejects.toMatchObject({
    code: 'revision-conflict',
  });
  await expect(reopened.saveReview(report())).rejects.toMatchObject({ code: 'revision-conflict' });
});
it('keeps failed and cancelled reports as history without upgrading their status', async () => {
  const f = await setup();
  const history = new LocalHistoryStore(await f.open(), f.now);
  for (const name of ['failed', 'cancelled', 'partial', 'needs-context']) {
    const value = clientReviewReport(
      corpus.cases.find((entry: { name: string }) => entry.name === name).report,
    );
    await history.saveReview(value);
    expect((await history.getReview(value.runId))!.status).toBe(value.status);
  }
  expect(await history.listReviews()).toHaveLength(4);
});
it('prunes by age and count using persisted policy and leaves local knowledge outside history retention', async () => {
  const f = await setup();
  const records = await f.open();
  const history = new LocalHistoryStore(records, f.now);
  await records.write('knowledge', 'untouched-memory', { body: 'private user note' }, 0);
  await history.configureRetention(
    { reviews: { maxAgeDays: 10, maxEntries: 1 }, chats: { maxAgeDays: 10, maxEntries: 1 } },
    0,
  );
  const first = report(),
    second = report();
  first.runId = 'review-a';
  second.runId = 'review-b';
  second.finishedAt = '2026-01-01T00:00:02.000Z';
  await history.saveReview(first);
  await history.saveReview(second);
  expect((await history.listReviews()).map((item) => item.runId)).toEqual(['review-b']);
  const conversation = chat(f.scope);
  await history.saveChat(conversation, 0);
  const future = new LocalHistoryStore(records, () => new Date('2026-02-01T00:00:00.000Z'));
  expect(await future.prune()).toEqual({ deleted: 2, cleanupPending: false });
  expect(await future.listReviews()).toEqual([]);
  expect(await future.listChats()).toEqual([]);
  expect(await records.read('knowledge', 'untouched-memory')).toMatchObject({
    value: { body: 'private user note' },
  });
});
it('rejects another repository/profile and malformed messages or retention policy', async () => {
  const f = await setup();
  const history = new LocalHistoryStore(await f.open(), f.now);
  const foreign = report();
  foreign.identity.client.profileId = 'other';
  await expect(history.saveReview(foreign)).rejects.toMatchObject({ code: 'corrupt-storage' });
  const archive = chat(f.scope);
  archive.scope = { kind: 'profile', profileId: f.scope.profileId };
  await expect(history.saveChat(archive, 0)).rejects.toMatchObject({ code: 'corrupt-storage' });
  const original = chat(f.scope);
  expect(() =>
    localChatArchive({ ...original, messages: [{ ...original.messages[0], role: ['user'] }] }),
  ).toThrow();
  expect(() =>
    localChatArchive({ ...original, messages: [original.messages[0], original.messages[0]] }),
  ).toThrow();
  await expect(
    history.configureRetention(
      { reviews: { maxAgeDays: 0, maxEntries: 1 }, chats: { maxAgeDays: 1, maxEntries: 1 } },
      0,
    ),
  ).rejects.toMatchObject({ code: 'corrupt-storage' });
});
it('protects chat revisions and retains a concurrent update when retention saw an older revision', async () => {
  const f = await setup();
  const records = await f.open();
  const history = new LocalHistoryStore(records, f.now);
  const archive = chat(f.scope);
  await history.saveChat(archive, 0);
  const updated = { ...archive, title: 'Updated question', updatedAt: '2026-01-02T00:00:00.000Z' };
  await history.saveChat(updated, 1);
  await expect(history.saveChat(archive, 1)).rejects.toMatchObject({ code: 'revision-conflict' });
  expect((await history.getChat(archive.id))!.chat.title).toBe('Updated question');
  const future = new LocalHistoryStore(records, () => new Date('2026-06-01T00:00:00.000Z'));
  const remove = records.remove.bind(records);
  vi.spyOn(records, 'remove').mockImplementationOnce(async (kind, id, revision) => {
    await records.write(
      'chats',
      archive.id,
      { ...updated, title: 'Fresh concurrent chat', updatedAt: '2026-06-01T00:00:00.000Z' },
      2,
    );
    return remove(kind, id, revision);
  });
  expect(await future.prune()).toEqual({ deleted: 0, cleanupPending: true });
  expect((await future.getChat(archive.id))!.chat.title).toBe('Fresh concurrent chat');
});
it('reports retention failure separately from a successfully saved review', async () => {
  const f = await setup();
  const history = new LocalHistoryStore(await f.open(), f.now);
  vi.spyOn(history, 'prune').mockRejectedValueOnce(
    new Error('Synthetic retention storage failure.'),
  );
  expect(await history.saveReview(report())).toEqual({ revision: 1, retentionPending: true });
  expect(await history.getReview(report().runId)).toEqual(report());
  await history.removeReview(report().runId);
  expect(await history.getReview(report().runId)).toBeUndefined();
});
