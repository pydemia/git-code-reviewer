import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  contentHash,
  type LocalKeyStore,
  type LocalReviewExecutor,
  type ServiceJob,
} from '@gcr/client-core';
import { executeCli } from './cli.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) throw Error('Service CLI did not settle');
    await new Promise((r) => setTimeout(r, 40));
  }
}
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcr-cli-service-')),
    repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const data = path.join(root, 'data'),
    profile = 'cli-service-fixture';
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    ).trim();
  git('init', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a=1;\n');
  git('add', '.');
  git('commit', '-m', 'base');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a=2;\n');
  git('add', '.');
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
  let calls = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observed: string[] = [];
  const executor: LocalReviewExecutor = {
    descriptor: {
      id: 'service-fixture',
      version: '1',
      model: 'fixture',
      configHash: contentHash('service-fixture'),
      capabilities: {
        available: true,
        sourceIsolation: 'fixed-source-only',
        cancellation: true,
        timeout: true,
        childProcessCleanup: true,
        outputTokenLimit: false,
      },
    },
    review: async (request) => {
      calls++;
      await gate;
      const reads = await Promise.all(
        ['source', 'base'].map(async (side) =>
          JSON.parse(await request.source.execute('read_file', { path: 'a.ts', side })),
        ),
      );
      observed.push(JSON.stringify(reads[0]));
      return {
        model: 'fixture',
        raw: JSON.stringify({
          summary: 'Fixed source reviewed.',
          files: [
            {
              path: 'a.ts',
              side: 'source',
              complete: true,
              summary: 'Read source and base.',
              readIds: reads.map((read) => read.readId),
            },
          ],
          findings: [],
          questions: [],
        }),
      };
    },
  };
  const common = ['--cwd', repo, '--data-dir', data, '--profile', profile];
  const dependencies = { keys, prepareExecutor: async () => executor };
  const cli = (args: string[]) => executeCli([...args, ...common], dependencies);
  const stop = new AbortController();
  const running = executeCli(['service', 'run', ...common], {
    ...dependencies,
    signal: stop.signal,
  });
  cleanups.push(async () => {
    release();
    stop.abort();
    await running;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await until(
    () => cli(['service', 'status']),
    (result) => result.exitCode === 0,
  );
  return { root, repo, git, cli, release, calls: () => calls, observed };
}
it('returns an encrypted queue receipt before model completion and shares results across separate receipts', async () => {
  const f = await fixture();
  expect((await f.cli(['enqueue', '--trigger', 'commit'])).exitCode).toBe(2);
  expect(
    (await f.cli(['service', 'allow', '--trigger', 'commit', '--trigger', 'manual'])).exitCode,
  ).toBe(0);
  const id = randomUUID();
  const accepted = await f.cli(['enqueue', '--trigger', 'commit', '--request-id', id]);
  expect(accepted.exitCode).toBe(0);
  expect(accepted.value).toMatchObject({
    status: 'accepted',
    reviewCompletion: 'not-awaited',
    receipt: { id },
  });
  await until(
    async () => f.calls(),
    (count) => count === 1,
  );
  const duplicate = await f.cli(['enqueue', '--trigger', 'commit', '--request-id', id]);
  expect(duplicate.exitCode).toBe(0);
  fs.writeFileSync(path.join(f.repo, 'a.ts'), 'export const unrelatedWorking=999;\n');
  f.release();
  const finished = await until(
    () => f.cli(['service', 'job', '--id', id]),
    (result) => (result.value as ServiceJob)?.state === 'finished',
  );
  expect((finished.value as ServiceJob).result).toMatchObject({ exitCode: 0, status: 'completed' });
  expect(f.observed[0]).toContain('export const a=2;');
  expect(f.observed[0]).not.toContain('unrelatedWorking');
  const next = randomUUID();
  expect((await f.cli(['enqueue', '--trigger', 'manual', '--request-id', next])).exitCode).toBe(0);
  const reused = await until(
    () => f.cli(['service', 'job', '--id', next]),
    (result) => (result.value as ServiceJob)?.state === 'finished',
  );
  expect((reused.value as ServiceJob).result?.runId).toBe(
    (finished.value as ServiceJob).result?.runId,
  );
  expect(f.calls()).toBe(1);
}, 40000);
it('revocation prevents new enqueue and rejects caller-side model or mode changes', async () => {
  const f = await fixture();
  expect((await f.cli(['service', 'allow', '--trigger', 'commit'])).exitCode).toBe(0);
  expect((await f.cli(['enqueue', '--trigger', 'commit', '--mode', 'standalone'])).exitCode).toBe(
    2,
  );
  expect((await f.cli(['enqueue', '--trigger', 'commit', '--model', 'gpt-6-astra'])).exitCode).toBe(
    2,
  );
  expect((await f.cli(['service', 'revoke'])).exitCode).toBe(0);
  expect((await f.cli(['enqueue', '--trigger', 'commit'])).exitCode).toBe(2);
  expect(f.calls()).toBe(0);
}, 20000);
it('defers a new source at the shared hourly limit without invoking another model review', async () => {
  const f = await fixture();
  expect(
    (await f.cli(['service', 'allow', '--trigger', 'commit', '--reviews-per-hour', '1'])).exitCode,
  ).toBe(0);
  const first = randomUUID();
  expect((await f.cli(['enqueue', '--trigger', 'commit', '--request-id', first])).exitCode).toBe(0);
  f.release();
  await until(
    () => f.cli(['service', 'job', '--id', first]),
    (result) => (result.value as ServiceJob)?.state === 'finished',
  );
  fs.writeFileSync(path.join(f.repo, 'a.ts'), 'export const a=3;\n');
  f.git('add', '.');
  const second = randomUUID();
  expect((await f.cli(['enqueue', '--trigger', 'commit', '--request-id', second])).exitCode).toBe(
    0,
  );
  const deferred = await until(
    () => f.cli(['service', 'job', '--id', second]),
    (result) => !!(result.value as ServiceJob)?.notBefore,
  );
  expect((deferred.value as ServiceJob).state).toBe('queued');
  expect((deferred.value as ServiceJob).notBefore).toBeGreaterThan(Date.now());
  expect(f.calls()).toBe(1);
  expect((await f.cli(['service', 'cancel', '--id', second])).exitCode).toBe(0);
}, 40000);
