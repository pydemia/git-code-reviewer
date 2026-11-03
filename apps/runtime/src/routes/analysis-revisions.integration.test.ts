import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { FilesystemArtifactStore } from '@gcr/artifact-store';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthUser } from '../auth/index.js';
import { loadConfig } from '../config.js';
import { EventHub } from '../events/index.js';
import { AuthorizationService } from '../services/authorization.js';
import { ensureFixtureRepository } from '../services/repositories.js';
import { registerSnapshotRoutes } from './snapshots.js';
import { registerAnalysisRoutes } from './analyses.js';

const databaseUrl = process.env.GCR_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl).sequential('durable PR analysis history', () => {
  const schema = `gcr_test_${randomUUID().replaceAll('-', '')}`;
  let root: Database, db: Database, app: FastifyInstance;
  let repositoryId: string, pullId: string, snapshotId: string, owner: string, other: string;
  let directory: string;
  let legacy: { id: string; revision: number }[];

  async function snapshot(head: string) {
    const request = await db.query(
      `insert into snapshot_requests(pull_request_id,base_sha,head_sha)
       values($1,$2,$3) returning id`,
      [pullId, 'a'.repeat(40), head.repeat(40)],
    );
    return (
      await db.query(
        `insert into snapshots(request_id,version,resolution,policy_version)
       values($1,1,'exact','test') returning id`,
        [request.rows[0].id],
      )
    ).rows[0].id as string;
  }
  async function run(target: string, user: string | null = null, revision = 1, key = randomUUID()) {
    const inserted = await db.query(
      `insert into analysis_runs(snapshot_id,analysis_key,state,revision,memory_owner_user_id)
       values($1,$2,'queued',$3,$4)
       on conflict(analysis_key) do update set analysis_key=excluded.analysis_key returning id`,
      [target, key, revision, user],
    );
    return (
      await db.query('select id, revision, pull_revision from analysis_runs where id=$1', [
        inserted.rows[0].id,
      ])
    ).rows[0] as { id: string; revision: number; pull_revision: number };
  }
  const history = (headers: Record<string, string> = {}, cursor?: string) =>
    app.inject({
      url: `/api/v1/repositories/${repositoryId}/pulls/1/analyses${cursor ? `?cursor=${cursor}` : ''}`,
      headers,
    });

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw Error('Local test DB required');
    root = createDatabase(url.toString());
    await root.query(`create schema ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    db = createDatabase(url.toString());
    directory = await mkdtemp(path.join(os.tmpdir(), 'gcr-revisions-'));
    const migrations = path.resolve('packages/db/migrations');
    for (const file of await readdir(migrations)) {
      if (file.endsWith('.sql') && file !== '0060_pull_analysis_revisions.sql')
        await copyFile(path.join(migrations, file), path.join(directory, file));
    }
    await runMigrations(db, directory);
    repositoryId = (await ensureFixtureRepository(db))!;
    const users = await db.query(
      `insert into users(oidc_subject,display_name,role) values
       ('owner','Owner','administrator'),('other','Other','administrator') returning id,oidc_subject`,
    );
    owner = users.rows.find((row) => row.oidc_subject === 'owner').id;
    other = users.rows.find((row) => row.oidc_subject === 'other').id;
    await db.query(
      "insert into repository_grants(repository_id,subject_or_group,role) values($1,$2,'reviewer')",
      [repositoryId, 'owner'],
    );
    pullId = (
      await db.query(
        `insert into pull_requests(repository_id,github_id,number,title,state,author_login,html_url,
       base_ref,base_sha,head_ref,head_sha,github_updated_at)
       values($1,1,1,'History','open','test','https://github.example/org/repo/pull/1',
       'main',$2,'branch',$3,clock_timestamp()) returning id`,
        [repositoryId, 'a'.repeat(40), 'b'.repeat(40)],
      )
    ).rows[0].id;
    snapshotId = await snapshot('b');
    await db.query(
      `insert into analysis_runs(snapshot_id,analysis_key,state,revision) values
      ($1,'legacy-1','partial',1),($1,'legacy-2','failed',2)`,
      [snapshotId],
    );
    legacy = (await db.query('select id,revision from analysis_runs order by created_at,id')).rows;
    await runMigrations(db, migrations);
    const tenantId = (
      await db.query('select tenant_id from repositories where id=$1', [repositoryId])
    ).rows[0].tenant_id;
    const admin: AuthUser = {
      id: owner,
      subject: 'owner',
      displayName: 'Owner',
      role: 'administrator',
      enabled: true,
      groups: [],
      tenantIds: [tenantId],
      tenants: [],
    };
    const config = loadConfig({
      DATABASE_URL: 'postgresql://localhost/unused',
      AUTH_MODE: 'development',
      GITHUB_MODE: 'fixture',
    });
    const auth = new AuthorizationService(config);
    app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.user = request.headers['x-denied']
        ? { ...admin, role: 'reviewer', tenantIds: [] }
        : request.headers['x-other']
          ? { ...admin, id: other, subject: 'other' }
          : request.headers['x-reviewer']
            ? { ...admin, role: 'reviewer' }
            : admin;
    });
    const events = new EventHub(db),
      artifacts = new FilesystemArtifactStore(directory);
    await registerSnapshotRoutes(app, db, events, artifacts, auth);
    await registerAnalysisRoutes(app, db, events, artifacts, config, auth);
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    await db?.end();
    if (root) {
      await root.query(`drop schema if exists ${schema} cascade`);
      await root.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('backfills PR sequence without renumbering legacy snapshot/artifact revisions', async () => {
    expect(
      (await db.query('select id,revision from analysis_runs order by created_at,id')).rows,
    ).toEqual(legacy);
    expect(
      (await history()).json().items.map((item: { pullRevision: number }) => item.pullRevision),
    ).toEqual([2, 1]);
  });
  it('advances across new push snapshots and same-snapshot reruns, with no increment on retry', async () => {
    const next = await snapshot('c');
    const first = await run(next, null, 1, 'new-push');
    expect(first).toMatchObject({ revision: 1, pull_revision: 3 });
    expect(await run(next, null, 1, 'new-push')).toEqual(first);
    expect(await run(next, null, 2)).toMatchObject({ revision: 2, pull_revision: 4 });
    const status = await app.inject({ url: `/api/v1/analyses/${first.id}/status` });
    expect(status.statusCode).toBe(200);
    expect(status.json().analysis).toMatchObject({
      revision: 1,
      pullRevision: 3,
      revisionScope: 'collective',
    });
  });
  it('separates private sequences and hides other users analyses in list and direct lookup', async () => {
    const mine = await run(snapshotId, owner);
    const theirs = await run(snapshotId, other);
    expect(mine.pull_revision).toBe(1);
    expect(theirs.pull_revision).toBe(1);
    const list = (await history()).json().items;
    expect(list.find((item: { id: string }) => item.id === mine.id)).toMatchObject({
      revisionScope: 'personal',
      pullRevision: 1,
    });
    expect(list.some((item: { id: string }) => item.id === theirs.id)).toBe(false);
    expect(
      (
        await app.inject({
          url: `/api/v1/analyses/${theirs.id}/status`,
          headers: { 'x-reviewer': '1' },
        })
      ).statusCode,
    ).toBe(404);
    // Existing administrator direct-access policy is preserved; the history list stays scoped.
    expect((await app.inject({ url: `/api/v1/analyses/${theirs.id}/status` })).statusCode).toBe(
      200,
    );
    expect(
      (await history({ 'x-other': '1' }))
        .json()
        .items.some((item: { id: string }) => item.id === mine.id),
    ).toBe(false);
    expect((await history({ 'x-denied': '1' })).statusCode).toBe(404);
    expect((await run(snapshotId)).pull_revision).toBe(5);
  });
  it('serializes concurrent inserts and never reuses a retained-away number', async () => {
    const runs = await Promise.all(Array.from({ length: 8 }, () => run(snapshotId)));
    expect(runs.map((item) => item.pull_revision).sort((a, b) => a - b)).toEqual([
      6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    await db.query('delete from analysis_runs where id=$1', [
      runs.find((item) => item.pull_revision === 13)!.id,
    ]);
    expect((await run(snapshotId)).pull_revision).toBe(14);
  });
  it('paginates beyond the old 20-item limit without leaking private runs', async () => {
    for (let i = 0; i < 105; i++) await run(snapshotId);
    const first = (await history()).json();
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();
    const second = (await history({}, first.nextCursor)).json();
    expect(second.items.length).toBeGreaterThan(0);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((item: { id: string }) => item.id);
    const expected = await db.query(
      'select id from analysis_runs where memory_owner_user_id is null or memory_owner_user_id=$1',
      [owner],
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(expected.rows.map((item) => item.id).sort());
    expect(ids).toContain(legacy[0]!.id);
  });
});
