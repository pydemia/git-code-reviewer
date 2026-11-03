import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { captureLocalSource, type LocalSourceSnapshot } from './source-snapshot.js';
import { contentHash, discoverLocalIdentity } from './local-identity.js';
import { resolveLocalContext } from './review-context.js';
import { resolveLocalExecutionPolicy } from './review-policy.js';
import { runLocalReview } from './review-runner.js';
import { LocalRecordStore } from './local-records.js';
import { LocalHistoryStore } from './local-history.js';
import { ReviewConversationStore } from './review-conversations.js';
import { runReviewConversation, type LocalReviewChatExecutor } from './review-chat-runner.js';

// Each case captures real Git trees and syncs encrypted CAS records to disk.
vi.setConfig({ testTimeout: 20_000 });

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
async function fixture(modelCalls = 3) {
  const root = await mkdtemp(path.join(tmpdir(), 'gcr-chat-'));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      {
        stdio: 'pipe',
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      },
    );
  git('init', '-b', 'main');
  await writeFile(path.join(repo, 'api.py'), 'def limit():\n    return 10\n');
  git('add', '.');
  git('commit', '-m', 'base');
  await writeFile(path.join(repo, 'api.py'), 'def limit():\n    return 0\n');
  git('add', '.');
  const snapshot = captureLocalSource({ cwd: repo, kind: 'index' });
  const snapshots: LocalSourceSnapshot[] = [snapshot];
  const stores: LocalRecordStore[] = [];
  cleanup.push(async () => {
    for (const store of stores) store.close();
    for (const s of snapshots) s.close();
    await rm(root, { recursive: true, force: true });
  });
  const descriptor = {
    id: 'fixture',
    version: '1',
    model: 'fixture',
    configHash: contentHash('fixture'),
    capabilities: {
      available: true,
      sourceIsolation: 'fixed-source-only' as const,
      cancellation: true,
      timeout: true,
      childProcessCleanup: true,
      outputTokenLimit: false,
    },
  };
  const client = discoverLocalIdentity(repo, 'chat-fixture');
  const resolve = async (snapshot: LocalSourceSnapshot) => {
    const context = await resolveLocalContext({ client, snapshot, stores: [] });
    const policy = resolveLocalExecutionPolicy({
      context,
      snapshot,
      executor: descriptor,
      workspaceTrusted: true,
      approval: {
        client,
        executor: descriptor,
        paths: ['**'],
        allowRelated: true,
        allowBase: true,
        allowKnowledge: true,
      },
      budget: { modelCalls },
    });
    if (context.status !== 'ready' || policy.status !== 'ready') throw Error('fixture');
    return { context: context.context, policy: policy.policy };
  };
  const authority = await resolve(snapshot);
  const report = await runLocalReview({
    ...authority,
    snapshot,
    executor: {
      descriptor,
      async review() {
        return {
          model: 'fixture',
          raw: JSON.stringify({
            summary: 'Synthetic limit review',
            files: [
              {
                path: 'api.py',
                side: 'source',
                complete: false,
                summary: 'Synthetic pending context',
                readIds: [],
              },
            ],
            findings: [],
            questions: [],
          }),
        };
      },
    },
  });
  const keys = new Map<string, Buffer>();
  let now = new Date();
  const open = async () => {
    const records = await LocalRecordStore.open({
      dataDirectory: path.join(root, 'data'),
      scope: {
        kind: 'repository',
        profileId: client.profileId,
        repositoryKey: client.repositoryKey,
        worktreeKey: client.worktreeKey,
      },
      keys: {
        async read(id) {
          return keys.has(id) ? Buffer.from(keys.get(id)!) : undefined;
        },
        async write(id, value) {
          keys.set(id, Buffer.from(value));
        },
        async remove(id) {
          keys.delete(id);
        },
      },
    });
    stores.push(records);
    return { records, store: new ReviewConversationStore(records, () => now) };
  };
  const { records, store } = await open();
  await store.create({ id: 'conversation', review: report, snapshot, policy: authority.policy });
  await store.append('conversation', 'turn', 'Explain the changed limit.');
  const assertAuthorized = vi.fn(async () => undefined);
  const run = (converse: LocalReviewChatExecutor['converse'], selected = store) =>
    runReviewConversation({
      store: selected,
      conversationId: 'conversation',
      turnId: 'turn',
      ...authority,
      assertAuthorized,
      executor: {
        descriptor,
        conversationCapability: 'checkpoint-tool-v1',
        review: async () => {
          throw Error('wrong entry');
        },
        converse,
      },
    });
  return {
    root,
    repo,
    snapshot,
    snapshots,
    store,
    records,
    open,
    authority,
    resolve,
    run,
    assertAuthorized,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}
const question: LocalReviewChatExecutor['converse'] = async (input) => {
  await input.questions.askUser('call-1', {
    question: 'Should zero disable the limit?',
    options: ['Yes', 'No'],
  });
  throw Error('model stopped for durable input');
};
const answer: LocalReviewChatExecutor['converse'] = async (input) => {
  const read = JSON.parse(
    await input.source.execute('read_file', { path: 'api.py', startLine: 1, endLine: 2 }),
  );
  return {
    model: 'fixture',
    raw: JSON.stringify({
      content: 'The captured limit is zero.',
      citations: [{ readId: read.readId, startLine: 2, endLine: 2 }],
    }),
  };
};

it('reopens an encrypted question checkpoint, accepts one answer and resumes the same turn on the captured source', async () => {
  const f = await fixture();
  const pending = await f.run(question),
    turn = pending.conversation.turns[0]!;
  expect(turn.status).toBe('awaiting_input');
  expect(turn.worker).toBeNull();
  await expect(f.run(answer)).rejects.toMatchObject({ code: 'invalid-state' });
  f.records.close();
  await writeFile(path.join(f.repo, 'api.py'), 'PRIVATE_LIVE_SOURCE_NEVER_READ');
  const reopened = await f.open();
  const id = turn.questions[0]!.id;
  f.advance(60 * 60 * 1000);
  const answered = await reopened.store.answer('conversation', 'turn', id, 'Yes');
  expect((await reopened.store.answer('conversation', 'turn', id, 'Yes')).revision).toBe(
    answered.revision,
  );
  await expect(reopened.store.answer('conversation', 'turn', id, 'No')).rejects.toMatchObject({
    code: 'invalid-state',
  });
  const done = await f.run(answer, reopened.store);
  expect(done.conversation.turns[0]).toMatchObject({
    id: 'turn',
    status: 'completed',
    usage: { modelCalls: 2 },
    response: { content: 'The captured limit is zero.' },
  });
  expect(done.conversation.turns[0]!.usage.durationMs).toBeLessThan(60_000);
  expect(await new LocalHistoryStore(reopened.records).listChats()).toEqual([]);
  const readTree = async (directory: string): Promise<string[]> =>
    (
      await Promise.all(
        (await readdir(directory, { withFileTypes: true })).map((entry) =>
          entry.isDirectory()
            ? readTree(path.join(directory, entry.name))
            : readFile(path.join(directory, entry.name)).then((b) => [b.toString('utf8')]),
        ),
      )
    ).flat();
  expect((await readTree(path.join(f.root, 'data'))).join('')).not.toContain('Should zero disable');
});

it('admits only one concurrent worker and keeps unknown execution reserved after reopening', async () => {
  const f = await fixture();
  const second = await f.open();
  const results = await Promise.allSettled([
    f.store.claim('conversation', 'turn', f.authority.policy),
    second.store.claim('conversation', 'turn', f.authority.policy),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const persisted = await second.store.get('conversation');
  expect(persisted.conversation.turns[0]!.usage.sourceBytes).toBe(
    persisted.conversation.limits.sourceBytes,
  );
  await expect(f.store.claim('conversation', 'turn', f.authority.policy)).rejects.toMatchObject({
    code: 'invalid-state',
  });
  const interrupted = await second.store.interrupt('conversation', persisted.revision);
  expect(interrupted.conversation.turns[0]).toMatchObject({
    status: 'failed',
    error: 'interrupted',
  });
});

it('cancellation wins over a late successful response and prevents any subsequent source return', async () => {
  const f = await fixture();
  const result = await f.run(async (input) => {
    const response = await answer(input);
    await f.store.cancel('conversation', 'turn');
    await expect(input.source.execute('read_file', { path: 'api.py' })).rejects.toThrow();
    return response;
  });
  expect(result.conversation.turns[0]).toMatchObject({ status: 'cancelled', response: null });
});

it('rejects a checkpoint saved from an ownership revision cancelled by another process', async () => {
  const f = await fixture();
  const { stored, previousUsage } = await f.store.claim('conversation', 'turn', f.authority.policy);
  await f.store.cancel('conversation', 'turn');
  await expect(
    f.store.checkpoint({
      stored,
      worker: stored.conversation.turns[0]!.worker!,
      callId: 'late',
      question: { question: 'Late?', options: [] },
      usage: { ...previousUsage, modelCalls: 1 },
    }),
  ).rejects.toMatchObject({ code: 'revision-conflict' });
  expect((await f.store.get('conversation')).conversation.turns[0]!.questions).toEqual([]);
});

it('rejects a changed snapshot identity and current authority revocation before model admission', async () => {
  const f = await fixture();
  await writeFile(path.join(f.repo, 'api.py'), 'def limit():\n    return 99\n');
  const changed = captureLocalSource({ cwd: f.repo, kind: 'working-tree' });
  f.snapshots.push(changed);
  const authority = await f.resolve(changed);
  await expect(f.store.claim('conversation', 'turn', authority.policy)).rejects.toMatchObject({
    code: 'stale-identity',
  });
  const model = vi.fn(answer);
  f.assertAuthorized.mockRejectedValueOnce(Error('revoked'));
  await expect(f.run(model)).rejects.toMatchObject({ code: 'policy-unavailable' });
  expect(model).not.toHaveBeenCalled();
  expect((await f.store.get('conversation')).conversation.turns[0]!.usage.modelCalls).toBe(0);
});

it('rechecks authority during execution and discards a response after revocation', async () => {
  const f = await fixture();
  const result = await f.run(async (input) => {
    const result = await answer(input);
    f.assertAuthorized.mockRejectedValue(Error('revoked'));
    return result;
  });
  expect(result.conversation.turns[0]!.status).toBe('failed');
  expect(result.conversation.turns[0]!.error).toBe('policy-unavailable');
  expect(result.conversation.turns[0]!.response).toBeNull();
});

it('keeps expired unanswered questions pending and refuses to manufacture an answer', async () => {
  const f = await fixture();
  const pending = await f.run(question);
  f.advance(25 * 60 * 60 * 1000);
  await expect(
    f.store.answer('conversation', 'turn', pending.conversation.turns[0]!.questions[0]!.id, 'Yes'),
  ).rejects.toMatchObject({ code: 'expired' });
  expect((await f.store.get('conversation')).conversation.turns[0]!.status).toBe('awaiting_input');
  await f.store.cancel('conversation', 'turn');
  await expect(
    f.store.answer('conversation', 'turn', pending.conversation.turns[0]!.questions[0]!.id, 'Yes'),
  ).rejects.toMatchObject({ code: 'invalid-state' });
});

it('does not reset a turn model budget when the user answers', async () => {
  const f = await fixture(1);
  const pending = await f.run(question);
  await f.store.answer(
    'conversation',
    'turn',
    pending.conversation.turns[0]!.questions[0]!.id,
    'Yes',
  );
  const model = vi.fn(answer);
  await expect(f.run(model)).rejects.toMatchObject({ code: 'quota-exceeded' });
  expect(model).not.toHaveBeenCalled();
});

it.each(['unread', 'outside-read', 'wrong-model'])(
  'rejects invalid current-step evidence: %s',
  async (kind) => {
    const f = await fixture();
    const result = await f.run(async (input) => {
      const result = await answer(input),
        response = JSON.parse(result.raw);
      if (kind === 'unread') response.citations[0].readId = 'old-read';
      if (kind === 'outside-read') response.citations[0].endLine = 3;
      return {
        model: kind === 'wrong-model' ? 'other-model' : 'fixture',
        raw: JSON.stringify(response),
      };
    });
    expect(result.conversation.turns[0]).toMatchObject({
      status: 'failed',
      error: 'invalid-output',
      response: null,
    });
  },
);

it('serializes tool requests so a committed question blocks later reads and a second question', async () => {
  const f = await fixture();
  const result = await f.run(async (input) => {
    const results = await Promise.allSettled([
      input.questions.askUser('first', { question: 'Choose?', options: [] }),
      input.source.execute('read_file', { path: 'api.py' }),
      input.questions.askUser('second', { question: 'Another?', options: [] }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
    throw Error('paused');
  });
  expect(result.conversation.turns[0]!.questions).toHaveLength(1);
});

it('requires fresh source reads after an answer instead of accepting a real read ID from the paused step', async () => {
  const f = await fixture();
  let oldRead = '';
  const pending = await f.run(async (input) => {
    oldRead = JSON.parse(await input.source.execute('read_file', { path: 'api.py' })).readId;
    return question(input);
  });
  await f.store.answer(
    'conversation',
    'turn',
    pending.conversation.turns[0]!.questions[0]!.id,
    'Yes',
  );
  const result = await f.run(async () => ({
    model: 'fixture',
    raw: JSON.stringify({
      content: 'A stale citation.',
      citations: [{ readId: oldRead, startLine: 2, endLine: 2 }],
    }),
  }));
  expect(result.conversation.turns[0]).toMatchObject({ status: 'failed', error: 'invalid-output' });
});

it('closes a pending conversation and fences both answers and new turns', async () => {
  const f = await fixture();
  const pending = await f.run(question);
  const closed = await f.store.close('conversation');
  expect(closed.conversation.closed).toBe(true);
  await expect(
    f.store.answer('conversation', 'turn', pending.conversation.turns[0]!.questions[0]!.id, 'Yes'),
  ).rejects.toMatchObject({ code: 'invalid-state' });
  await expect(f.store.append('conversation', 'new-turn', 'More')).rejects.toMatchObject({
    code: 'invalid-state',
  });
});

it('uses configured chat retention, expires unanswered questions, and preserves queued execution', async () => {
  const f = await fixture();
  await f.run(question);
  await new LocalHistoryStore(f.records).configureRetention(
    { reviews: { maxEntries: 10, maxAgeDays: 1 }, chats: { maxEntries: 10, maxAgeDays: 1 } },
    0,
  );
  f.advance(25 * 60 * 60 * 1000);
  expect(await f.store.prune()).toMatchObject({ expired: 1, deleted: 0 });
  expect((await f.store.get('conversation')).conversation.turns[0]).toMatchObject({
    status: 'cancelled',
    error: 'expired',
  });
  await f.store.append('conversation', 'new-turn', 'Keep queued work.');
  f.advance(2 * 86400000);
  expect(await f.store.prune()).toMatchObject({ deleted: 0 });
  await f.store.close('conversation');
  f.advance(2 * 86400000);
  expect(await f.store.prune()).toMatchObject({ deleted: 1 });
  await expect(f.store.get('conversation')).rejects.toMatchObject({ code: 'missing' });
});

it('isolates saved central conversations from standalone mode and other central audiences', async () => {
  const f = await fixture();
  const stored = await f.store.get('conversation');
  const audience = {
    serverId: 'server',
    tenantId: 'tenant',
    userId: 'alice',
    repositoryId: 'repository',
  };
  const client = { ...stored.conversation.identity.client, mode: 'centralized' as const, audience };
  stored.conversation.identity.client = client;
  stored.review.identity.client = client;
  await f.records.write(
    'conversations',
    'conversation',
    { conversation: stored.conversation, review: stored.review, source: stored.source },
    stored.revision,
  );
  const same = new ReviewConversationStore(f.records, undefined, audience);
  const other = new ReviewConversationStore(f.records, undefined, { ...audience, userId: 'bob' });
  expect((await same.list()).map((item) => item.conversation.id)).toEqual(['conversation']);
  expect(await f.store.list()).toEqual([]);
  expect(await other.list()).toEqual([]);
  await expect(other.get('conversation')).rejects.toMatchObject({ code: 'audience-mismatch' });
  await expect(other.remove('conversation', stored.revision + 1)).rejects.toMatchObject({
    code: 'audience-mismatch',
  });
  expect((await same.get('conversation')).conversation.identity.client).toEqual(client);
});
