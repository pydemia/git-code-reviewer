import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '@gcr/db';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { runtimeDatabase } from './database.js';
import { runWorker } from './jobs/worker.js';

describe.skipIf(!process.env.GCR_TEST_DATABASE_URL)('database interruption recovery', () => {
  const target = () => {
    const url = new URL(process.env.GCR_TEST_DATABASE_URL!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      throw Error('Use an isolated local PostgreSQL');
    return url;
  };
  it('discards a terminated idle connection and reconnects without logging credentials', async () => {
    const config = loadConfig({ DATABASE_URL: target().href, GITHUB_MODE: 'disabled' }, 'worker');
    const pool = runtimeDatabase(config, 'gcr_app', 1);
    const admin = createDatabase(target().href, 1);
    const logs: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      logs.push(String(chunk));
      return true;
    });
    try {
      expect(pool.listenerCount('error')).toBe(1);
      const pid = (await pool.query('select pg_backend_pid() as pid')).rows[0].pid;
      const disconnected = once(pool, 'error');
      expect(
        (await admin.query('select pg_terminate_backend($1) as killed', [pid])).rows[0].killed,
      ).toBe(true);
      await disconnected;
      expect(logs).toContain('{"level":"error","code":"DATABASE_IDLE_CONNECTION_LOST"}\n');
      expect(logs.join('')).not.toContain(target().password);
      const next = (await pool.query('select pg_backend_pid() as pid, 42 as value')).rows[0];
      expect(next.pid).not.toBe(pid);
      expect(next.value).toBe(42);
    } finally {
      stderr.mockRestore();
      await pool.end();
      await admin.end();
    }
  });

  it('releases the worker health port after a real startup query failure', async () => {
    const admin = createDatabase(target().href, 1);
    const schema = `gcr_worker_failure_${randomUUID().replaceAll('-', '')}`;
    const directory = await mkdtemp(path.join(tmpdir(), 'gcr-worker-db-failure-'));
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    try {
      await admin.query(`create schema ${schema}`);
      const url = target();
      url.searchParams.set('options', `-c search_path=${schema}`);
      const config = loadConfig(
        {
          DATABASE_URL: url.href,
          GITHUB_MODE: 'disabled',
          HOST: '127.0.0.1',
          WORKER_HEALTH_PORT: String(port),
          WORKSPACE_ROOT: path.join(directory, 'workspace'),
          ARTIFACT_ROOT: path.join(directory, 'artifacts'),
        },
        'worker',
      );
      await expect(
        runWorker(config, { signal: new AbortController().signal }),
      ).rejects.toMatchObject({ code: '42P01' });
      await expect(fetch(`http://127.0.0.1:${port}/health/live`)).rejects.toThrow();
    } finally {
      await admin.query(`drop schema if exists ${schema} cascade`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
