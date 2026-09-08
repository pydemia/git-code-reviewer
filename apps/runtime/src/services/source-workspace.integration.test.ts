import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../config.js';
import { prepareLeasedWorkspace } from './source-workspace.js';

const url = process.env.GCR_TEST_DATABASE_URL;
describe.skipIf(!url).sequential('workspace DB leases and bounded cache', () => {
  let root: Database, database: Database, config: AppConfig, directory: string;
  const schema = `workspace_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    const target = new URL(url!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
      throw Error('Use isolated local PostgreSQL');
    root = createDatabase(target.href);
    await root.query(`create schema ${schema}`);
    target.searchParams.set('options', `-c search_path=${schema}`);
    database = createDatabase(target.href);
    await runMigrations(database, path.resolve('packages/db/migrations'));
    directory = await mkdtemp(path.join(os.tmpdir(), 'gcr-workspace-lease-'));
    config = loadConfig({
      DATABASE_URL: target.href,
      AUTH_MODE: 'development',
      WORKSPACE_ROOT: directory,
      GIT_WORKSPACE_MAX_BYTES: '1048576',
    });
  });
  afterAll(async () => {
    await database?.end();
    if (root) {
      await root.query(`drop schema if exists ${schema} cascade`);
      await root.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const prepare = (id: string) => async () => {
    await mkdir(path.join(directory, id), { recursive: true });
    await writeFile(path.join(directory, id, 'manifest.json'), '{}');
  };
  it('reuses immutable workspace and protects multiple active leases from TTL cleanup', async () => {
    const id = 'a'.repeat(64),
      other = 'b'.repeat(64);
    const first = await prepareLeasedWorkspace(database, config, id, prepare(id));
    const second = await prepareLeasedWorkspace(database, config, id, prepare(id));
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect((await database.query('select * from source_workspace_leases')).rowCount).toBe(2);
    await first.release();
    await utimes(first.workspace, new Date(0), new Date(0));
    const next = await prepareLeasedWorkspace(database, config, other, prepare(other));
    expect(await readFile(path.join(first.workspace, 'manifest.json'), 'utf8')).toBe('{}');
    await second.release();
    await next.release();
    await utimes(first.workspace, new Date(0), new Date(0));
    const last = await prepareLeasedWorkspace(database, config, other, prepare(other));
    await expect(readFile(path.join(first.workspace, 'manifest.json'))).rejects.toThrow();
    await last.release();
  });
  it('rejects expired leases and leaves no lease after preparation failure', async () => {
    const id = 'c'.repeat(64);
    const lease = await prepareLeasedWorkspace(database, config, id, prepare(id));
    await database.query(
      "update source_workspace_leases set expires_at=clock_timestamp()-interval '1 second'",
    );
    await expect(lease.renew()).rejects.toThrow('workspace_lease_lost');
    await lease.release();
    await expect(
      prepareLeasedWorkspace(database, config, 'd'.repeat(64), async () => {
        throw Error('synthetic');
      }),
    ).rejects.toThrow('synthetic');
    expect((await database.query('select * from source_workspace_leases')).rowCount).toBe(0);
  });
  it('rejects admission when the pod-local cache capacity is consumed', async () => {
    for (const character of ['e', 'f', '1']) {
      const location = path.join(directory, character.repeat(64));
      await mkdir(location);
      await writeFile(path.join(location, 'blob'), Buffer.alloc(1048400));
    }
    await expect(
      prepareLeasedWorkspace(database, config, '2'.repeat(64), prepare('2'.repeat(64))),
    ).rejects.toThrow('workspace_capacity_limit');
    expect((await database.query('select * from source_workspace_leases')).rowCount).toBe(0);
  });
});
