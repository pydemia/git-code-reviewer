import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ClientReviewReport, ReviewConversation } from '@gcr/client-contract';
import {
  contentHash,
  discoverLocalIdentity,
  LocalRecordStore,
  ReviewConversationStore,
  type LocalKeyStore,
  type LocalReviewChatExecutor,
} from '@gcr/client-core';
import { executeCli, type CliDependencies, type CliResult } from './cli.js';

vi.setConfig({ testTimeout: 20_000 });
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
const descriptor = {
  id: 'chat-fixture',
  version: '1',
  model: 'fixture',
  configHash: contentHash('cli-chat'),
  capabilities: {
    available: true,
    sourceIsolation: 'fixed-source-only' as const,
    cancellation: true,
    timeout: true,
    childProcessCleanup: true,
    outputTokenLimit: false,
  },
};
const conversation = (result: CliResult) =>
  (result.value as { conversation: ReviewConversation }).conversation;
async function fixture(reviewOptions: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcr-cli-chat-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'),
    data = path.join(root, 'data');
  fs.mkdirSync(repo);
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
  fs.writeFileSync(path.join(repo, 'api.py'), 'def limit():\n    return 10\n');
  fs.writeFileSync(path.join(repo, 'related.py'), 'VALUE = 1\n');
  git('add', '.');
  git('commit', '-m', 'base');
  fs.writeFileSync(path.join(repo, 'api.py'), 'def limit():\n    return 0\n');
  git('add', '.');
  const secrets = new Map<string, Buffer>();
  const keys: LocalKeyStore = {
    read: async (id) => (secrets.has(id) ? Buffer.from(secrets.get(id)!) : undefined),
    write: async (id, value) => {
      secrets.set(id, Buffer.from(value));
    },
    remove: async (id) => {
      secrets.delete(id);
    },
  };
  cleanup.push(() => {
    secrets.forEach((v) => v.fill(0));
    secrets.clear();
  });
  const converse = vi.fn<LocalReviewChatExecutor['converse']>();
  const executor: LocalReviewChatExecutor = {
    descriptor,
    conversationCapability: 'checkpoint-tool-v1',
    converse,
    async review(input) {
      const reads = await Promise.all(
        ['source', 'base'].map(async (side) =>
          JSON.parse(await input.source.execute('read_file', { path: 'api.py', side })),
        ),
      );
      return {
        model: 'fixture',
        raw: JSON.stringify({
          summary: 'Synthetic review.',
          files: [
            {
              path: 'api.py',
              side: 'source',
              complete: true,
              summary: 'Read changed limit.',
              readIds: reads.map((r) => r.readId),
            },
          ],
          findings: [],
          questions: [],
        }),
      };
    },
  };
  const prepareExecutor = vi.fn(async () => executor);
  const invoke = (args: string[], body?: unknown, override: CliDependencies = {}) =>
    executeCli([...args, '--cwd', repo, '--data-dir', data, '--profile', 'chat-test'], {
      keys,
      prepareExecutor,
      ...(body === undefined ? {} : { readStdin: async () => JSON.stringify(body) }),
      ...override,
    });
  const report = await invoke(['review', ...reviewOptions]);
  expect(report.exitCode, JSON.stringify(report)).toBe(0);
  const runId = (report.value as ClientReviewReport).runId;
  const chat = (
    action: string,
    body?: unknown,
    override?: CliDependencies,
    options: string[] = [],
  ) =>
    invoke(
      ['chat', action, runId, ...(body === undefined ? [] : ['--input', '-']), ...options],
      body,
      override,
    );
  const open = async () => {
    const client = discoverLocalIdentity(repo, 'chat-test');
    const records = await LocalRecordStore.open({
      dataDirectory: data,
      keys,
      scope: {
        kind: 'repository',
        profileId: client.profileId,
        repositoryKey: client.repositoryKey,
        worktreeKey: client.worktreeKey,
      },
    });
    cleanup.push(() => records.close());
    return new ReviewConversationStore(records);
  };
  return { repo, data, runId, chat, invoke, open, converse, prepareExecutor, executor, keys };
}
const ask: LocalReviewChatExecutor['converse'] = async (input) => {
  await input.questions.askUser('question-call', {
    question: 'Does zero disable the limit?',
    options: ['Yes', 'No'],
  });
  throw Error('Durable checkpoint releases the model.');
};
const answer: LocalReviewChatExecutor['converse'] = async (input) => {
  const read = JSON.parse(await input.source.execute('read_file', { path: 'api.py' }));
  expect(read.text).toContain('return 0');
  return {
    model: 'fixture',
    raw: JSON.stringify({
      content: 'The saved limit is zero.',
      citations: [{ readId: read.readId, startLine: 2, endLine: 2 }],
    }),
  };
};

it('reopens a durable question, answers once and reads the original citation after the working file changes', async () => {
  const f = await fixture();
  expect(conversation(await f.chat('read')).turns).toEqual([]);
  expect(f.prepareExecutor).toHaveBeenCalledTimes(1);
  f.converse.mockImplementationOnce(ask).mockImplementation(answer);
  const sent = await f.chat('send', { turnId: 'turn-1', content: 'Explain the limit.' });
  expect(sent.exitCode, JSON.stringify(sent)).toBe(1);
  const turn = conversation(sent).turns[0]!;
  expect(turn.status).toBe('awaiting_input');
  expect(turn.worker).toBeNull();
  fs.writeFileSync(path.join(f.repo, 'api.py'), 'PRIVATE_CURRENT_WORKING_FILE');
  expect(conversation(await f.chat('read')).turns[0]).toEqual(turn);
  expect((await f.chat('resume', { turnId: turn.id })).exitCode).toBe(2);
  const body = { turnId: turn.id, questionId: turn.questions[0]!.id, content: 'Yes' };
  const completed = await f.chat('answer', body);
  expect(completed.exitCode, JSON.stringify(completed)).toBe(0);
  expect(conversation(completed).turns[0]?.status).toBe('completed');
  expect(conversation(completed).turns[0]?.usage.modelCalls).toBe(2);
  expect(conversation(await f.chat('answer', body))).toEqual(conversation(completed));
  expect(conversation(await f.chat('send', { turnId: turn.id, content: turn.content }))).toEqual(
    conversation(completed),
  );
  expect((await f.chat('answer', { ...body, content: 'No' })).exitCode).toBe(2);
  expect((await f.chat('send', { turnId: turn.id, content: 'Different question' })).exitCode).toBe(
    2,
  );
  const preparations = f.prepareExecutor.mock.calls.length;
  const excerpt = await f.chat('source', { turnId: turn.id, citation: 0 });
  expect(excerpt).toMatchObject({
    exitCode: 0,
    value: {
      text: '    return 0',
      location: { path: 'api.py', side: 'source', startLine: 2, endLine: 2 },
    },
  });
  expect(f.prepareExecutor).toHaveBeenCalledTimes(preparations);
  expect(f.converse).toHaveBeenCalledTimes(2);
});

it('does not auto-run a queued turn on read or repeated send; only an explicit resume claims it', async () => {
  const f = await fixture(),
    store = await f.open();
  await store.append(f.runId, 'queued', 'Explain this saved review.');
  f.converse.mockImplementation(answer);
  expect((await f.chat('read')).exitCode).toBe(1);
  expect(
    (await f.chat('send', { turnId: 'queued', content: 'Explain this saved review.' })).exitCode,
  ).toBe(1);
  expect(f.converse).not.toHaveBeenCalled();
  expect((await f.chat('resume', { turnId: 'queued' })).exitCode).toBe(0);
  expect((await f.chat('resume', { turnId: 'queued' })).exitCode).toBe(2);
  expect(f.converse).toHaveBeenCalledTimes(1);
});

it('rejects changed context, executor and insufficient timeout before appending or running', async () => {
  const f = await fixture();
  const body = { turnId: 'blocked', content: 'Explain.' };
  const changed = {
    ...f.executor,
    descriptor: { ...descriptor, configHash: contentHash('other-account') },
  };
  expect((await f.chat('send', body, { prepareExecutor: async () => changed })).exitCode).toBe(2);
  expect((await f.chat('send', body, {}, ['--timeout-ms', '1'])).exitCode).toBe(2);
  const created = await f.invoke(['memory', 'create', '--input', '-'], {
    title: 'New rule',
    body: 'Different context.',
    appliesTo: { paths: ['api.py'], languages: ['python'], symbols: [], branches: [] },
  });
  expect(created.exitCode).toBe(0);
  const id = (created.value as { id: string }).id;
  expect((await f.invoke(['memory', 'activate', id, '--revision', '1'])).exitCode).toBe(0);
  expect((await f.chat('send', body)).exitCode).toBe(2);
  expect(conversation(await f.chat('read')).turns).toEqual([]);
  expect(f.converse).not.toHaveBeenCalled();
});

it('rejects extra fields, invalid question/citation and a different profile without a model call', async () => {
  const f = await fixture();
  for (const [action, body] of [
    ['send', { turnId: 'x', content: 'Question', model: 'override' }],
    ['send', { turnId: '../escape', content: 'Question' }],
    ['send', { turnId: 'x', content: ' ' }],
    ['answer', { turnId: 'x', content: 'Yes' }],
    ['source', { turnId: 'x', citation: -1 }],
    ['source', { turnId: 'x', citation: 0 }],
    ['cancel', { turnId: 'unknown' }],
  ] as const)
    expect((await f.chat(action, body)).exitCode).toBe(2);
  const other = await executeCli(
    ['chat', 'read', f.runId, '--cwd', f.repo, '--data-dir', f.data, '--profile', 'other'],
    { keys: f.keys },
  );
  expect(other.exitCode).toBe(2);
  expect(f.converse).not.toHaveBeenCalled();
});

it('requires the original restricted source approval when resuming a narrow review', async () => {
  const f = await fixture(['--allow-path', 'api.py']);
  const body = { turnId: 'narrow', content: 'Explain.' };
  expect((await f.chat('send', body)).exitCode).toBe(2);
  expect(conversation(await f.chat('read')).turns).toEqual([]);
  f.converse.mockImplementation(answer);
  expect((await f.chat('send', body, {}, ['--allow-path', 'api.py'])).exitCode).toBe(0);
  expect(f.converse).toHaveBeenCalledTimes(1);
});

it('cancels a live turn from a separate invocation and fences its late response', async () => {
  const f = await fixture();
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.converse.mockImplementation(async (input) => {
    started();
    await new Promise<void>((resolve) =>
      input.signal!.addEventListener('abort', () => resolve(), { once: true }),
    );
    return { model: 'fixture', raw: JSON.stringify({ content: 'Late answer', citations: [] }) };
  });
  const pending = f.chat('send', { turnId: 'live', content: 'Explain.' });
  await running;
  const preparations = f.prepareExecutor.mock.calls.length;
  expect((await f.chat('cancel', { turnId: 'live' })).exitCode).toBe(0);
  expect(f.prepareExecutor).toHaveBeenCalledTimes(preparations);
  const result = await pending;
  expect(result.exitCode).toBe(2);
  const turn = conversation(await f.chat('read')).turns[0]!;
  expect(turn.status).toBe('cancelled');
  expect(turn.response).toBeNull();
  expect((await f.chat('resume', { turnId: 'live' })).exitCode).toBe(2);
  expect(f.converse).toHaveBeenCalledTimes(1);
});
