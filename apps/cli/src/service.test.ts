import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  contentHash,
  ServiceJobs,
  ReviewRequests,
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
    preparations = 0,
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
  const dependencies = {
    keys,
    prepareExecutor: async () => {
      preparations++;
      return executor;
    },
  };
  const cli = (args: string[]) => executeCli([...args, ...common], dependencies);
  let stop = new AbortController();
  let running = executeCli(['service', 'run', ...common], {
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
  const restart = async () => {
    stop.abort();
    await running;
    stop = new AbortController();
    running = executeCli(['service', 'run', ...common], { ...dependencies, signal: stop.signal });
    await until(
      () => cli(['service', 'status']),
      (result) => result.exitCode === 0,
    );
  };
  return {
    root,
    repo,
    git,
    cli,
    release,
    restart,
    calls: () => calls,
    preparations: () => preparations,
    observed,
  };
}
it('runs explicit external-file watching through CLI commands, the service queue and the shared review runner', async () => {
  const f = await fixture();
  f.release();
  expect((await f.cli(['service', 'allow', '--trigger', 'save'])).exitCode).toBe(0);
  expect((await f.cli(['watch', 'start', '--trigger', 'save'])).exitCode).toBe(2);
  expect(
    (await f.cli(['watch', 'start', '--trigger', 'save', '--external-changes'])).exitCode,
  ).toBe(0);
  expect(f.calls()).toBe(0);
  fs.writeFileSync(path.join(f.repo, 'a.ts'), 'export const watched=3;\n');
  await until(
    () => f.cli(['watch', 'status']),
    (r) => (r.value as Array<{ receipt?: ServiceJob }>)[0]?.receipt?.state === 'finished',
  );
  expect(f.calls()).toBe(1);
  expect(f.observed[0]).toContain('watched=3');
  await f.restart();
  expect((await f.cli(['watch', 'status'])).value).toEqual([
    expect.objectContaining({
      enabled: true,
      trigger: 'save',
      receipt: expect.objectContaining({ state: 'finished' }),
    }),
  ]);
  expect((await f.cli(['watch', 'status', '--external-changes'])).exitCode).toBe(2);
  expect((await f.cli(['watch', 'stop'])).exitCode).toBe(0);
  expect((await f.cli(['watch', 'status'])).value).toEqual([
    expect.objectContaining({ enabled: false }),
  ]);
  expect(f.calls()).toBe(1);
}, 30000);
it('reattaches a completed journal after the service fails before saving its receipt', async () => {
  const f = await fixture();
  expect((await f.cli(['service', 'allow', '--trigger', 'commit'])).exitCode).toBe(0);
  const failure = vi
    .spyOn(ServiceJobs.prototype, 'finish')
    .mockRejectedValueOnce(Error('service completion disk failure'));
  const id = randomUUID();
  try {
    expect((await f.cli(['enqueue', '--trigger', 'commit', '--request-id', id])).exitCode).toBe(0);
    f.release();
    await until(
      () => f.cli(['service', 'status']),
      (r) => (r.value as { problem?: string }).problem === 'service-invalid',
    );
  } finally {
    failure.mockRestore();
  }
  const before = (await f.cli(['service', 'job', '--id', id])).value as ServiceJob;
  expect(before.state).toBe('running');
  expect(before.execution?.generation).toBe(1);
  fs.writeFileSync(path.join(f.repo, 'a.ts'), 'MUTATED_AFTER_ORIGINAL_REVIEW');
  await f.restart();
  expect(((await f.cli(['service', 'job', '--id', id])).value as ServiceJob).state).toBe(
    'interrupted',
  );
  const result = await f.cli(['service', 'reconcile', '--id', id]);
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  const restored = result.value as ServiceJob;
  expect(restored.state).toBe('finished');
  expect(restored.result).toMatchObject({ status: 'completed', exitCode: 0 });
  expect((await f.cli(['service', 'reconcile', '--id', id])).value).toEqual(restored);
  expect((await f.cli(['result', restored.result!.runId!])).exitCode).toBe(0);
  expect(f.calls()).toBe(1);
}, 40000);

it('keeps an unconfirmed request interrupted and recovers only its matching saved report', async () => {
  const f = await fixture();
  expect((await f.cli(['service', 'allow', '--trigger', 'commit'])).exitCode).toBe(0);
  const failure = vi
    .spyOn(ReviewRequests.prototype, 'finish')
    .mockRejectedValueOnce(Error('journal write failure'));
  const id = randomUUID();
  let interrupted: ServiceJob;
  try {
    expect((await f.cli(['enqueue', '--trigger', 'commit', '--request-id', id])).exitCode).toBe(0);
    f.release();
    const result = await until(
      () => f.cli(['service', 'job', '--id', id]),
      (r) => (r.value as ServiceJob)?.state === 'interrupted',
    );
    interrupted = result.value as ServiceJob;
    expect(interrupted.result?.completionUnconfirmed).toBe(true);
  } finally {
    failure.mockRestore();
  }
  const execution = interrupted!.execution!;
  expect(
    (
      await f.cli([
        'requests',
        'reconcile',
        '--key',
        execution.key,
        '--generation',
        String(execution.generation + 1),
      ])
    ).exitCode,
  ).toBe(2);
  const restored = await f.cli(['service', 'reconcile', '--id', id]);
  expect(restored.value).toMatchObject({
    state: 'finished',
    result: { runId: interrupted!.result!.runId, exitCode: 0 },
  });
  expect(f.calls()).toBe(1);
}, 40000);
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
it('waits for a foreground manual review before preparing or starting an automatic service review', async () => {
  const f = await fixture();
  expect((await f.cli(['service', 'allow', '--trigger', 'commit'])).exitCode).toBe(0);
  const manual = f.cli(['review']);
  const id = randomUUID();
  try {
    await until(
      async () => f.calls(),
      (value) => value === 1,
    );
    const preparations = f.preparations();
    fs.writeFileSync(path.join(f.repo, 'a.ts'), 'export const a=3;\n');
    f.git('add', '.');
    expect((await f.cli(['enqueue', '--trigger', 'commit', '--request-id', id])).exitCode).toBe(0);
    const deferred = await until(
      () => f.cli(['service', 'job', '--id', id]),
      (value) => (value.value as ServiceJob)?.waitingReason === 'manual-priority',
    );
    expect((deferred.value as ServiceJob).state).toBe('queued');
    expect(f.calls()).toBe(1);
    expect(f.preparations()).toBe(preparations);
  } finally {
    f.release();
    expect((await manual).exitCode).toBe(0);
  }
  const finished = await until(
    () => f.cli(['service', 'job', '--id', id]),
    (value) => (value.value as ServiceJob)?.state === 'finished',
  );
  expect((finished.value as ServiceJob).result?.status).toBe('completed');
  expect((finished.value as ServiceJob).waitingReason).toBeUndefined();
  expect(f.calls()).toBe(2);
}, 40000);
