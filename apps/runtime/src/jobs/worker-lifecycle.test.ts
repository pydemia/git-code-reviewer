import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { runWorker } from './worker.js';

const fixture = vi.hoisted(() => ({
  apps: [] as FastifyInstance[],
  recover: vi.fn(),
  end: vi.fn(),
  query: vi.fn(),
}));
vi.mock('fastify', async (original) => {
  const actual = await original<typeof import('fastify')>();
  return {
    ...actual,
    default: () => {
      const app = actual.default({ logger: false });
      fixture.apps.push(app);
      return app;
    },
  };
});
vi.mock('../database.js', () => ({
  openRuntimeDatabase: async () => ({
    connect: async () => ({ query: fixture.query, release: vi.fn() }),
    end: fixture.end,
  }),
}));
vi.mock('./recovery.js', () => ({ recoverExpiredJobs: fixture.recover }));

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'gcr-worker-lifecycle-'));
  fixture.apps.length = 0;
  fixture.end.mockReset().mockResolvedValue(undefined);
  fixture.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  fixture.recover.mockReset().mockResolvedValue(0);
});
afterEach(async () => {
  // Also closes the leaked health server when running this regression against old code.
  for (const app of fixture.apps) await app.close();
  await rm(directory, { recursive: true, force: true });
});
const config = () => ({
  ...loadConfig(
    { GITHUB_MODE: 'disabled', DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1/fixture' },
    'worker',
  ),
  HOST: '127.0.0.1',
  WORKER_HEALTH_PORT: 0,
  WORKSPACE_ROOT: path.join(directory, 'workspace'),
  ARTIFACT_ROOT: path.join(directory, 'artifacts'),
});

it('closes the real health listener and pool when startup recovery fails', async () => {
  fixture.recover.mockRejectedValueOnce(
    Object.assign(Error('database is starting up'), { code: '57P03' }),
  );
  await expect(runWorker(config(), { signal: new AbortController().signal })).rejects.toMatchObject(
    { code: '57P03' },
  );
  expect(fixture.apps).toHaveLength(1);
  expect(fixture.apps[0]!.server.listening).toBe(false);
  expect(fixture.end).toHaveBeenCalledTimes(1);
});

it('closes the health listener when a later claim query fails', async () => {
  fixture.query.mockRejectedValueOnce(Error('connection lost while claiming'));
  await expect(runWorker(config(), { signal: new AbortController().signal })).rejects.toThrow(
    'connection lost while claiming',
  );
  expect(fixture.apps[0]!.server.listening).toBe(false);
  expect(fixture.end).toHaveBeenCalledTimes(1);
});

it('remains ready after a successful iteration and closes on requested shutdown', async () => {
  const stop = new AbortController();
  const running = runWorker(config(), { signal: stop.signal });
  try {
    await vi.waitFor(() => expect(fixture.query).toHaveBeenCalled());
    expect((await fixture.apps[0]!.inject('/health/ready')).statusCode).toBe(200);
  } finally {
    stop.abort();
    await running;
  }
  expect(fixture.apps[0]!.server.listening).toBe(false);
  expect(fixture.end).toHaveBeenCalledTimes(1);
});
