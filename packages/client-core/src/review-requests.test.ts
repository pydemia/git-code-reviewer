import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { clientReviewReport, type LocalScope } from '@gcr/client-contract';
import { ReviewRequests, executeReviewRequest, reviewRequestKey } from './review-requests.js';
import { LocalRecordStore } from './local-records.js';
import { LocalHistoryStore } from './local-history.js';
import type { LocalKeyStore } from './local-credentials.js';
const corpus = JSON.parse(
  readFileSync(
    new URL('../../../tests/fixtures/client-contract/reports.json', import.meta.url),
    'utf8',
  ),
);
const report = () => clientReviewReport(corpus.cases[0].report);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gcr-requests-'));
  const values = new Map<string, Buffer>();
  const keys: LocalKeyStore = {
    read: async (id) => (values.has(id) ? Buffer.from(values.get(id)!) : undefined),
    write: async (id, value) => {
      values.set(id, Buffer.from(value));
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
  const storage = { dataDirectory: root, scope, keys };
  let now = Date.parse('2026-01-02T00:00:00.000Z');
  const opened: Array<{ close(): void }> = [];
  const open = async () => {
    const queue = await ReviewRequests.open({ ...storage, now: () => now });
    opened.push(queue);
    return queue;
  };
  const records = await LocalRecordStore.open(storage);
  opened.push(records);
  const history = new LocalHistoryStore(records, () => new Date(now));
  cleanups.push(async () => {
    for (const resource of opened) resource.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    storage,
    values,
    now: () => now,
    open,
    history,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
function changed() {
  const value = report();
  value.identity.source.hash = 'f'.repeat(64);
  return value;
}
it('reconciles the exact saved completion after lease expiry without another model run', async () => {
  const f = await setup(),
    queue = await f.open();
  const request = await queue.enqueue(report().identity, 'commit');
  const claim = await queue.claim(request.key, { leaseMs: 1000 });
  if (claim.kind !== 'acquired') throw Error('fixture');
  await queue.begin(claim.lease, 'commit');
  await queue.prepareCompletion(claim.lease, report());
  await f.history.saveReview(report());
  const loadReport = vi.fn((id: string) => f.history.getReview(id));
  const assertValid = vi.fn(async () => undefined);
  expect(
    (await queue.reconcile(request.key, claim.lease.generation, { loadReport, assertValid }))
      .request.state,
  ).toBe('running');
  expect(loadReport).not.toHaveBeenCalled();
  queue.close();
  f.advance(1001);
  const reopened = await f.open();
  const recovered = await reopened.reconcile(request.key, claim.lease.generation, {
    loadReport,
    assertValid,
  });
  expect(recovered.request).toMatchObject({
    state: 'finished',
    resultId: report().runId,
    generation: claim.lease.generation,
  });
  expect(recovered.report).toEqual(report());
  await expect(reopened.finish(claim.lease, report())).rejects.toMatchObject({
    code: 'request-lost',
  });
  const run = vi.fn(async () => report());
  const reused = await executeReviewRequest({
    storage: f.storage,
    identity: report().identity,
    loadReport,
    saveReport: (r) => f.history.saveReview(r),
    run,
  });
  expect(reused.reused).toBe(true);
  expect(run).not.toHaveBeenCalled();
});

it('leaves unknown execution interrupted even when an unrelated older report exists', async () => {
  const f = await setup(),
    queue = await f.open();
  const request = await queue.enqueue(report().identity, 'manual');
  const claim = await queue.claim(request.key, { leaseMs: 1000 });
  if (claim.kind !== 'acquired') throw Error('fixture');
  await queue.begin(claim.lease, 'manual');
  await f.history.saveReview(report());
  f.advance(1001);
  const loadReport = vi.fn((id: string) => f.history.getReview(id));
  const recovered = await queue.reconcile(request.key, claim.lease.generation, {
    loadReport,
    assertValid: async () => undefined,
  });
  expect(recovered.request.state).toBe('interrupted');
  expect(recovered.report).toBeUndefined();
  expect(loadReport).not.toHaveBeenCalled();
  expect((await queue.claim(request.key)).kind).toBe('interrupted');
});

it('requires durable matching history and current authorization before attaching a completion receipt', async () => {
  const f = await setup(),
    queue = await f.open();
  const request = await queue.enqueue(report().identity, 'manual');
  const claim = await queue.claim(request.key, { leaseMs: 1000 });
  if (claim.kind !== 'acquired') throw Error('fixture');
  await queue.begin(claim.lease, 'manual');
  await queue.prepareCompletion(claim.lease, report());
  f.advance(1001);
  const assertValid = vi.fn(async () => undefined);
  expect(
    (
      await queue.reconcile(request.key, claim.lease.generation, {
        loadReport: async () => undefined,
        assertValid,
      })
    ).report,
  ).toBeUndefined();
  await expect(
    queue.reconcile(request.key, claim.lease.generation, {
      loadReport: async () => ({ ...report(), summary: 'Modified report' }),
      assertValid,
    }),
  ).rejects.toMatchObject({ code: 'request-invalid' });
  await expect(
    queue.reconcile(request.key, claim.lease.generation, {
      loadReport: async () => report(),
      assertValid: async () => {
        throw Error('revoked');
      },
    }),
  ).rejects.toThrow('revoked');
  expect((await queue.get(request.key))?.state).toBe('interrupted');
  await f.history.saveReview(report());
  expect(
    (
      await queue.reconcile(request.key, claim.lease.generation, {
        loadReport: (id) => f.history.getReview(id),
        assertValid,
      })
    ).report,
  ).toEqual(report());
});

it('cannot reuse a previous generation completion for a later interrupted attempt', async () => {
  const f = await setup(),
    queue = await f.open();
  const request = await queue.enqueue(report().identity, 'manual');
  const first = await queue.claim(request.key);
  if (first.kind !== 'acquired') throw Error('fixture');
  await queue.begin(first.lease, 'manual');
  await queue.prepareCompletion(first.lease, report());
  await queue.finish(first.lease, report());
  const second = await queue.claim(request.key, {
    retryFinishedGeneration: first.lease.generation,
    leaseMs: 1000,
  });
  if (second.kind !== 'acquired') throw Error('fixture');
  await queue.begin(second.lease, 'manual');
  f.advance(1001);
  const input = { loadReport: async () => report(), assertValid: async () => undefined };
  await expect(queue.reconcile(request.key, first.lease.generation, input)).rejects.toMatchObject({
    code: 'request-invalid',
  });
  const recovered = await queue.reconcile(request.key, second.lease.generation, input);
  expect(recovered.request.state).toBe('interrupted');
  expect(recovered.report).toBeUndefined();
});

it('preserves history when the auxiliary completion receipt cannot be written', async () => {
  const f = await setup();
  const failure = vi
    .spyOn(ReviewRequests.prototype, 'prepareCompletion')
    .mockRejectedValue(Error('disk fixture'));
  try {
    const result = await executeReviewRequest({
      storage: f.storage,
      identity: report().identity,
      loadReport: (id) => f.history.getReview(id),
      saveReport: (r) => f.history.saveReview(r),
      run: async () => report(),
    });
    expect(result.persisted).toBe(true);
    expect(result.recorded).toBe(true);
    expect(await f.history.getReview(report().runId)).toEqual(report());
  } finally {
    failure.mockRestore();
  }
});
it('merges all trigger reasons across independently opened journals and grants one lease', async () => {
  const f = await setup(),
    a = await f.open(),
    b = await f.open();
  const identity = report().identity;
  const rows = await Promise.all(
    ['save', 'stage', 'commit', 'push', 'manual', 'work_completed'].map((reason, i) =>
      (i % 2 ? a : b).enqueue(identity, reason as 'save'),
    ),
  );
  expect(new Set(rows.map((r) => r.key)).size).toBe(1);
  expect((await a.get(rows[0]!.key))!.reasons).toEqual([
    'commit',
    'manual',
    'push',
    'save',
    'stage',
    'work_completed',
  ]);
  const claims = await Promise.all([a.claim(rows[0]!.key), b.claim(rows[0]!.key)]);
  expect(claims.map((c) => c.kind).sort()).toEqual(['acquired', 'waiting']);
  const separate = await a.enqueue(changed().identity, 'stage');
  expect(separate.key).not.toBe(rows[0]!.key);
});
it('recovers a claimed lease after restart but never restarts an expired running request', async () => {
  const f = await setup(),
    a = await f.open();
  const row = await a.enqueue(report().identity, 'stage');
  const first = await a.claim(row.key, { leaseMs: 1000 });
  if (first.kind !== 'acquired') throw Error('fixture');
  a.close();
  f.advance(1001);
  const b = await f.open(),
    second = await b.claim(row.key, { leaseMs: 1000 });
  if (second.kind !== 'acquired') throw Error('fixture');
  await expect(b.begin(first.lease, 'stage')).rejects.toMatchObject({ code: 'request-lost' });
  await b.begin(second.lease, 'stage');
  f.advance(1001);
  expect((await b.claim(row.key)).kind).toBe('interrupted');
  expect((await b.claim(row.key, { retryFinishedGeneration: second.lease.generation })).kind).toBe(
    'interrupted',
  );
  await expect(b.finish(second.lease, report())).rejects.toMatchObject({ code: 'request-lost' });
});
it('persists minimum intervals and hourly reservations across reopened journals', async () => {
  const f = await setup(),
    a = await f.open();
  const row = await a.enqueue(report().identity, 'save');
  const claim = await a.claim(row.key);
  if (claim.kind !== 'acquired') throw Error('fixture');
  await a.begin(claim.lease, 'save', { maximumReviewsPerHour: 2, minimumIntervalMs: 600000 });
  await a.finish(claim.lease, report());
  a.close();
  const b = await f.open(),
    other = await b.enqueue(changed().identity, 'save');
  const next = await b.claim(other.key);
  if (next.kind !== 'acquired') throw Error('fixture');
  await expect(
    b.begin(next.lease, 'save', { maximumReviewsPerHour: 2, minimumIntervalMs: 600000 }),
  ).rejects.toMatchObject({ code: 'request-deferred' });
  await b.release(next.lease);
  f.advance(600000);
  const retry = await b.claim(other.key);
  if (retry.kind !== 'acquired') throw Error('fixture');
  await b.begin(retry.lease, 'save', { maximumReviewsPerHour: 2 });
  await b.finish(retry.lease, changed());
  const manual = report();
  manual.identity.source.hash = 'e'.repeat(64);
  const third = await b.enqueue(manual.identity, 'manual');
  const thirdClaim = await b.claim(third.key);
  if (thirdClaim.kind !== 'acquired') throw Error('fixture');
  await expect(
    b.begin(thirdClaim.lease, 'manual', { maximumReviewsPerHour: 2 }),
  ).rejects.toMatchObject({ code: 'request-deferred' });
});
it('reuses one encrypted report across concurrent callers, including two explicit retries', async () => {
  const f = await setup();
  let calls = 0;
  const input = {
    storage: f.storage,
    identity: report().identity,
    loadReport: (id: string) => f.history.getReview(id),
    saveReport: (value: ReturnType<typeof report>) => f.history.saveReview(value),
    run: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const value = report();
      value.runId = `run-${calls}`;
      return value;
    },
  };
  // Real clock is used by the wrapper; retention uses the synthetic report date.
  const first = await Promise.all([
    executeReviewRequest({ ...input, reason: 'save' }),
    executeReviewRequest({ ...input, reason: 'stage' }),
  ]);
  expect(calls).toBe(1);
  expect(first.map((r) => r.reused).sort()).toEqual([false, true]);
  expect(first[0]!.report).toEqual(first[1]!.report);
  const second = await Promise.all([
    executeReviewRequest({ ...input, retryFinished: true }),
    executeReviewRequest({ ...input, retryFinished: true }),
  ]);
  expect(calls).toBe(2);
  expect(second[0]!.report).toEqual(second[1]!.report);
});
it('checks current authorization even when a completed report is reusable', async () => {
  const f = await setup(),
    run = vi.fn(async () => report());
  const input = {
    storage: f.storage,
    identity: report().identity,
    run,
    loadReport: (id: string) => f.history.getReview(id),
    saveReport: (r: ReturnType<typeof report>) => f.history.saveReview(r),
  };
  await executeReviewRequest(input);
  await expect(
    executeReviewRequest({
      ...input,
      assertValid: async () => {
        throw Error('revoked');
      },
    }),
  ).rejects.toThrow('revoked');
  expect(run).toHaveBeenCalledTimes(1);
});
it('preserves an observed report after storage failure without advertising durable completion', async () => {
  const f = await setup();
  const input = {
    storage: f.storage,
    identity: report().identity,
    loadReport: async () => undefined,
    saveReport: async () => {
      throw Error('disk full');
    },
    run: vi.fn(async () => report()),
  };
  expect(await executeReviewRequest(input)).toMatchObject({
    persisted: false,
    recorded: false,
    reused: false,
    report: report(),
  });
  await expect(executeReviewRequest(input)).rejects.toMatchObject({ code: 'request-interrupted' });
  expect(input.run).toHaveBeenCalledTimes(1);
});
it('rejects a model report for a different execution before writing history', async () => {
  const f = await setup(),
    saveReport = vi.fn();
  await expect(
    executeReviewRequest({
      storage: f.storage,
      identity: report().identity,
      loadReport: async () => undefined,
      saveReport,
      run: async () => changed(),
    }),
  ).rejects.toMatchObject({ code: 'request-invalid' });
  expect(saveReport).not.toHaveBeenCalled();
});
it('deduplicates successful synchronization observations without mutating the caller identity', () => {
  const first = report().identity;
  first.client = {
    ...first.client,
    mode: 'centralized',
    audience: { serverId: 'server', tenantId: 'tenant', userId: 'user', repositoryId: 'repo' },
    execution: {
      configuredMode: 'centralized',
      effectiveMode: 'centralized',
      knowledgeSource: 'central-online',
      fallbackReason: null,
      connectionId: 'a'.repeat(64),
      lastSynchronizedAt: '2026-01-01T00:00:00.000Z',
    },
  };
  const second = structuredClone(first);
  second.client.execution!.lastSynchronizedAt = '2026-01-02T00:00:00.000Z';
  expect(reviewRequestKey(first)).toBe(reviewRequestKey(second));
  expect(first.client.execution!.lastSynchronizedAt).toBe('2026-01-01T00:00:00.000Z');
  second.executor.configHash = 'f'.repeat(64);
  expect(reviewRequestKey(first)).not.toBe(reviewRequestKey(second));
});

it('fences a killed OS process and merges another process without starting it', async () => {
  const f = await setup(),
    parent = await f.open();
  const row = await parent.enqueue(report().identity, 'manual');
  const children: ReturnType<typeof fork>[] = [];
  cleanups.push(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
  });
  const start = async (reason: string) => {
    const child = fork(
      new URL('../test-fixtures/review-request-process.mjs', import.meta.url),
      [],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    children.push(child);
    const response = once(child, 'message', { signal: AbortSignal.timeout(5000) });
    child.send({
      root: f.storage.dataDirectory,
      scope: f.storage.scope,
      identity: report().identity,
      now: f.now(),
      reason,
      begin: true,
      keys: [...f.values].map(([key, value]) => [key, value.toString('base64')]),
    });
    return { child, result: (await response)[0] };
  };
  const leader = await start('save');
  expect(leader.result.kind).toBe('acquired');
  const follower = await start('stage');
  expect(follower.result.kind).toBe('waiting');
  expect((await parent.get(row.key))!.reasons).toEqual(['manual', 'save', 'stage']);
  const exited = once(leader.child, 'exit');
  leader.child.kill('SIGKILL');
  await exited;
  f.advance(1001);
  expect((await parent.claim(row.key)).kind).toBe('interrupted');
  await expect(parent.heartbeat(leader.result.lease)).rejects.toMatchObject({
    code: 'request-lost',
  });
}, 15000);
it('cancelling a waiting caller does not cancel the owner or its saved result', async () => {
  const f = await setup();
  let started!: () => void, release!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = vi.fn(async (signal: AbortSignal) => {
    started();
    await pending;
    expect(signal.aborted).toBe(false);
    return report();
  });
  const input = {
    storage: f.storage,
    identity: report().identity,
    run,
    loadReport: (id: string) => f.history.getReview(id),
    saveReport: (r: ReturnType<typeof report>) => f.history.saveReview(r),
  };
  const owner = executeReviewRequest(input);
  await running;
  const controller = new AbortController();
  const waiting = executeReviewRequest({ ...input, signal: controller.signal });
  const rejected = expect(waiting).rejects.toThrow();
  controller.abort();
  await rejected;
  release();
  expect(await owner).toMatchObject({ recorded: true, reused: false });
  expect(run).toHaveBeenCalledTimes(1);
});
