import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clientReviewReport,
  type LocalKnowledge,
  type LocalReviewResponse,
} from '@gcr/client-contract';
import { contentHash, type LocalKeyStore, type LocalReviewExecutor } from '@gcr/client-core';
import { executeCli } from './cli.js';

let root: string, repo: string, data: string;
const secrets = new Map<string, Uint8Array>();
const keys: LocalKeyStore = {
  read: async (id) => (secrets.get(id) ? Buffer.from(secrets.get(id)!) : undefined),
  write: async (id, value) => {
    secrets.set(id, Uint8Array.from(value));
  },
  remove: async (id) => {
    secrets.delete(id);
  },
};
let modelCalls = 0;
const descriptor = {
  id: 'fixture',
  version: '1',
  model: 'fixture-model',
  configHash: contentHash('cli-fixture'),
  capabilities: {
    available: true,
    sourceIsolation: 'fixed-source-only' as const,
    cancellation: true,
    timeout: true,
    childProcessCleanup: true,
    outputTokenLimit: false,
  },
};
const executor: LocalReviewExecutor = {
  descriptor,
  review: async (request) => {
    modelCalls++;
    const reads = await Promise.all(
      ['source', 'base'].map(async (side) =>
        JSON.parse(await request.source.execute('read_file', { path: 'load.py', side })),
      ),
    );
    const response: LocalReviewResponse = {
      summary: 'Fixture response.',
      files: [
        {
          path: 'load.py',
          side: 'source',
          complete: true,
          summary: 'Fixture coverage.',
          readIds: reads.map((read) => read.readId),
        },
      ],
      findings: [],
      questions: [{ prompt: 'Optional design clarification.', required: false }],
    };
    return { raw: JSON.stringify(response), model: descriptor.model };
  },
};
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcr-cli-test-'));
  repo = path.join(root, 'repo');
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
  fs.writeFileSync(path.join(repo, 'load.py'), 'def load():\n    return 1\n');
  git('add', '.');
  git('commit', '-m', 'base');
  fs.writeFileSync(path.join(repo, 'load.py'), 'def load():\n    return 2\n');
  git('add', '.');
});
afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  for (const secret of secrets.values()) secret.fill(0);
  secrets.clear();
});
const cli = (args: string[], input?: unknown) =>
  executeCli([...args, '--cwd', repo, '--data-dir', data, '--profile', 'cli-test'], {
    keys,
    prepareExecutor: async () => executor,
    ...(input === undefined ? {} : { readStdin: async () => JSON.stringify(input) }),
  });
describe('standalone CLI assembly', () => {
  it('status is read-only and does not prepare an executor or create local storage', async () => {
    const result = await cli(['status']);
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(data)).toBe(false);
    expect(modelCalls).toBe(0);
  });
  it('rejects unsupported central mode and invalid options before source/model work', async () => {
    const result = await cli(['review', '--mode', 'centralized']);
    expect(result.exitCode).toBe(2);
    expect(result.value).toMatchObject({
      mode: 'centralized',
      status: 'unavailable',
      centralRequests: 'forbidden',
    });
    expect((await cli(['review', '--api-key', 'secret-canary'])).exitCode).toBe(2);
    expect(fs.existsSync(data)).toBe(false);
    expect(modelCalls).toBe(0);
  });
  it.each(['memory', 'skill'])(
    'supports %s candidate/activation/CAS/export/import/archive/delete across reopened stores',
    async (kind) => {
      const created = await cli([kind, 'create', '--input', '-'], {
        title: `${kind} title`,
        body: 'private-knowledge-canary',
        appliesTo: { paths: ['load.py'], languages: ['python'], symbols: [], branches: [] },
      });
      expect(created.exitCode).toBe(0);
      let item = created.value as LocalKnowledge;
      expect(item.state).toBe('candidate');
      expect((await cli([kind, 'show', item.id])).value).toEqual(item);
      expect((await cli([kind, 'activate', item.id, '--revision', '99'])).exitCode).toBe(2);
      item = (await cli([kind, 'activate', item.id, '--revision', '1'])).value as LocalKnowledge;
      expect(item.state).toBe('active');
      const context = await cli(['context', '--require-knowledge', item.id]);
      expect(context.exitCode).toBe(0);
      expect(JSON.stringify(context.value)).toContain(item.hash);
      expect(JSON.stringify(context.value)).not.toContain(item.body);
      item = (
        await cli([kind, 'edit', item.id, '--revision', '2', '--input', '-'], {
          body: 'updated-knowledge-canary',
        })
      ).value as LocalKnowledge;
      expect(item.revision).toBe(3);
      const output = path.join(root, `${kind}.json`);
      expect((await cli([kind, 'export', item.id, '--output', output])).exitCode).toBe(0);
      expect(fs.statSync(output).mode & 0o777).toBe(0o600);
      expect((await cli([kind, 'export', item.id, '--output', output])).exitCode).toBe(2);
      const imported = (await cli([kind, 'import', '--input', output])).value as LocalKnowledge;
      expect(imported.id).not.toBe(item.id);
      expect(imported.state).toBe('candidate');
      expect((await cli([kind, 'deactivate', item.id, '--revision', '3'])).value).toMatchObject({
        state: 'inactive',
        revision: 4,
      });
      expect((await cli(['context', '--require-knowledge', item.id])).exitCode).toBe(2);
      expect((await cli([kind, 'archive', item.id, '--revision', '4'])).value).toMatchObject({
        state: 'archived',
        revision: 5,
      });
      expect((await cli([kind, 'delete', item.id, '--revision', '5'])).exitCode).toBe(0);
      expect((await cli([kind, 'show', item.id])).exitCode).toBe(2);
      const walk = (directory: string): string =>
        fs
          .readdirSync(directory, { withFileTypes: true })
          .map((entry) =>
            entry.isDirectory()
              ? walk(path.join(directory, entry.name))
              : fs.readFileSync(path.join(directory, entry.name), 'utf8'),
          )
          .join('');
      expect(walk(data)).not.toContain('knowledge-canary');
    },
    30_000,
  );
  it('keeps profile knowledge usable outside Git and checks kind/scope before mutation', async () => {
    const create = await executeCli(
      [
        'memory',
        'create',
        '--scope',
        'profile',
        '--data-dir',
        data,
        '--profile',
        'cli-test',
        '--input',
        '-',
      ],
      { cwd: root, keys, readStdin: async () => '{"title":"profile","body":"body"}' },
    );
    expect(create.exitCode).toBe(0);
    const item = create.value as LocalKnowledge;
    expect((await cli(['skill', 'show', item.id, '--scope', 'profile'])).exitCode).toBe(2);
    expect((await cli(['memory', 'show', item.id])).exitCode).toBe(2);
  });
  it('rejects invalid drafts, revision misuse and symlink input', async () => {
    expect(
      (await cli(['memory', 'create', '--input', '-'], { title: 'a', body: 'b', state: 'active' }))
        .exitCode,
    ).toBe(2);
    expect((await cli(['memory', 'list', '--revision', '1'])).exitCode).toBe(2);
    const link = path.join(root, 'linked.json');
    fs.symlinkSync(path.join(root, 'memory.json'), link);
    expect((await cli(['memory', 'import', '--input', link])).exitCode).toBe(2);
  });
  it('saves a terminal report and reads it after all stores have closed', async () => {
    const result = await cli(['review']);
    expect(result.exitCode).toBe(1);
    const report = clientReviewReport(result.value);
    expect(report.status).toBe('completed');
    const reread = await cli(['result', report.runId]);
    expect(reread.exitCode).toBe(1);
    expect(reread.value).toEqual(report);
    expect((await cli(['history'])).value).toMatchObject([
      { runId: report.runId, status: 'completed', exitCode: 1 },
    ]);
    expect(modelCalls).toBe(1);
  });
  it('does not describe an unavailable executor as a completed or clean review', async () => {
    const result = await executeCli(
      ['review', '--cwd', repo, '--data-dir', data, '--profile', 'cli-test'],
      {
        keys,
        prepareExecutor: async () => {
          throw Error('private credential diagnostic');
        },
      },
    );
    expect(result.exitCode).toBe(2);
    expect(result.value).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(result.value)).not.toContain('private credential');
    expect(modelCalls).toBe(1);
  });
});
