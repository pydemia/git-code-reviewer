import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Copy this file and reports.json beside a clean consumer's node_modules to test packed artifacts.
// A module override is for pre-pack development checks only; it is not a runtime dependency.
const core = await import(process.env.GCR_CLIENT_SMOKE_MODULE ?? '@gcr/client-core');
const fixturePath =
  process.env.GCR_CLIENT_SMOKE_FIXTURES ??
  fileURLToPath(new URL('./reports.json', import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, 'utf8')).cases[0].report;
const client = fixture.identity.client;
const scope = {
  kind: 'repository',
  profileId: client.profileId,
  repositoryKey: client.repositoryKey,
  worktreeKey: client.worktreeKey,
};
const exec = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const open = (root, service) =>
  core.LocalRecordStore.open({
    dataDirectory: root,
    scope,
    keys: new core.PlatformLocalKeyStore(service),
  });
const child = async (operation, root, service, id, argument = '') => {
  const result = await exec(
    process.execPath,
    [script, '--child', operation, root, service, id, argument],
    { timeout: 30_000, maxBuffer: 16 * 1024 },
  );
  return JSON.parse(result.stdout.trim());
};

if (process.argv[2] === '--child') {
  const [operation, root, service, id, argument] = process.argv.slice(3);
  const records = await open(root, service);
  const knowledge = new core.LocalKnowledgeStore(records);
  const history = new core.LocalHistoryStore(records);
  try {
    if (operation === 'read') {
      const item = await knowledge.get(id);
      assert.equal(item.revision, 3);
      assert.equal(item.body, 'poc:updated private memory');
      assert.equal((await history.getChat('chat-smoke')).chat.messages.length, 2);
      assert.equal((await history.listReviews()).length, 1);
      assert.equal((await history.getRetention()).policy.reviews.maxEntries, 10);
      console.log(JSON.stringify({ result: 'restored', revision: item.revision }));
    } else if (operation === 'race') {
      try {
        await knowledge.edit(id, 3, { body: `poc:worker-${argument}` });
        console.log(JSON.stringify({ result: 'committed' }));
      } catch (error) {
        if (error.code !== 'revision-conflict') throw error;
        console.log(JSON.stringify({ result: 'conflict' }));
      }
    } else if (operation === 'deleted') {
      assert.equal(await knowledge.get(id), undefined);
      console.log(JSON.stringify({ result: 'deleted' }));
    } else throw new Error('Unknown storage smoke operation.');
  } finally {
    records.close();
  }
} else {
  const root = await mkdtemp(path.join(tmpdir(), 'gcr-store-smoke-'));
  const service = `com.commitdefender.local-smoke.${randomUUID()}`;
  const keys = new core.PlatformLocalKeyStore(service);
  const stores = [];
  let cleanup = 'pending';
  let result;
  try {
    const records = await open(root, service);
    stores.push(records);
    const knowledge = new core.LocalKnowledgeStore(records);
    const history = new core.LocalHistoryStore(records);
    const item = await knowledge.create({
      kind: 'memory',
      title: 'Storage smoke',
      body: 'poc:private memory',
      rationale: 'Synthetic storage fixture.',
      counterEvidence: [],
      appliesTo: { paths: [], languages: [], symbols: [], branches: [] },
      sources: [{ kind: 'user-note', id: 'synthetic-smoke' }],
    });
    await knowledge.setState(item.id, 1, 'active');
    await knowledge.edit(item.id, 2, { body: 'poc:updated private memory' });
    const now = new Date().toISOString();
    const report = {
      ...fixture,
      runId: 'review-smoke',
      requestedAt: now,
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      summary: 'Synthetic storage fixture. No model execution.',
    };
    await history.saveReview(report);
    await history.saveChat(
      {
        formatVersion: 1,
        id: 'chat-smoke',
        scope,
        title: 'Storage smoke',
        createdAt: now,
        updatedAt: now,
        messages: [
          { id: 'message-user', role: 'user', content: 'poc:private question', at: now },
          { id: 'message-assistant', role: 'assistant', content: 'poc:synthetic answer', at: now },
        ],
      },
      0,
    );
    await history.configureRetention(
      { reviews: { maxAgeDays: 30, maxEntries: 10 }, chats: { maxAgeDays: 30, maxEntries: 10 } },
      0,
    );
    records.close();
    const restored = await child('read', root, service, item.id);
    assert.equal(restored.result, 'restored');
    const races = await Promise.all(
      Array.from({ length: 8 }, (_, index) => child('race', root, service, item.id, String(index))),
    );
    assert.equal(races.filter((item) => item.result === 'committed').length, 1);
    assert.equal(races.filter((item) => item.result === 'conflict').length, 7);
    const reopened = await open(root, service);
    stores.push(reopened);
    const after = new core.LocalKnowledgeStore(reopened);
    const winner = await after.get(item.id);
    assert.equal(winner.revision, 4);
    assert(winner.body.startsWith('poc:worker-'));
    const deletion = await after.remove(item.id, 4);
    assert.equal(deletion.cleanupPending, false);
    reopened.close();
    assert.equal((await child('deleted', root, service, item.id)).result, 'deleted');
    result = {
      platform: process.platform,
      node: process.version,
      packageVersion: core.clientCorePackage.version,
      keyStore: process.platform === 'darwin' ? 'macOS Keychain' : 'Linux Secret Service',
      restoredInNewProcess: true,
      concurrentWriters: 8,
      committed: 1,
      conflicts: 7,
      deletionRestoredInNewProcess: true,
      syntheticData: true,
      modelCalls: 0,
    };
  } finally {
    for (const store of stores) store.close();
    let reference;
    try {
      const metadata = JSON.parse(
        await readFile(
          path.join(root, 'profiles', scope.profileId, 'local', 'key-ref.json'),
          'utf8',
        ),
      );
      reference = `${scope.profileId}.${metadata.id}`;
      await keys.remove(reference);
      assert.equal(await keys.read(reference), undefined);
      cleanup = 'completed';
    } catch (error) {
      if (error.code === 'ENOENT') cleanup = 'completed';
      else
        console.error(
          JSON.stringify({
            cleanup: 'pending',
            service,
            reference,
            code: error.code ?? 'cleanup-failed',
          }),
        );
    }
    if (cleanup === 'completed') await rm(root, { recursive: true, force: true });
  }
  assert.equal(cleanup, 'completed');
  console.log(JSON.stringify({ ...result, cleanup }, null, 2));
}
