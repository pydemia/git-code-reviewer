import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FilesystemArtifactStore } from '@gcr/artifact-store';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { retention } from './commands.js';
import { loadConfig, type AppConfig } from './config.js';

const url = process.env.GCR_TEST_DATABASE_URL;
describe.skipIf(!url).sequential('merged review retention', () => {
  const schema = `retention_${randomUUID().replaceAll('-', '')}`;
  let root: Database;
  let database: Database;
  let directory: string;
  let config: AppConfig;
  let userId: string;
  let firstRepository: string;
  let secondRepository: string;

  beforeAll(async () => {
    const target = new URL(url!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
      throw Error('Use isolated local PostgreSQL');
    root = createDatabase(target.href);
    await root.query(`create schema ${schema}`);
    target.searchParams.set('options', `-c search_path=${schema}`);
    database = createDatabase(target.href);
    await runMigrations(database, path.resolve('packages/db/migrations'));
    directory = await mkdtemp(path.join(os.tmpdir(), 'gcr-merged-retention-'));
    config = loadConfig(
      {
        DATABASE_URL: target.href,
        AUTH_MODE: 'development',
        WORKSPACE_ROOT: path.join(directory, 'workspaces'),
        ARTIFACT_ROOT: path.join(directory, 'artifacts'),
        RETENTION_DELETE_GRACE_HOURS: '0',
      },
      'retention',
    );
    const tenantId = (
      await database.query<{ id: string }>(
        "insert into tenants(slug,display_name) values('retention','Retention') returning id",
      )
    ).rows[0]!.id;
    userId = (
      await database.query<{ id: string }>(
        "insert into users(oidc_subject,display_name,role) values('retention-user','Retention','reviewer') returning id",
      )
    ).rows[0]!.id;
    const instanceId = (
      await database.query<{ id: string }>(
        "insert into github_instances(name,api_base_url,web_base_url) values('retention','https://example.invalid/api/','https://example.invalid/') returning id",
      )
    ).rows[0]!.id;
    for (const name of ['first', 'second']) {
      const repositoryId = (
        await database.query<{ id: string }>(
          `insert into repositories(tenant_id,instance_id,github_id,installation_id,owner,name)
         values($1,$2,$3,'1','fixture',$4) returning id`,
          [tenantId, instanceId, name === 'first' ? 1 : 2, name],
        )
      ).rows[0]!.id;
      if (name === 'first') firstRepository = repositoryId;
      else secondRepository = repositoryId;
    }
  });

  afterAll(async () => {
    await database?.end();
    if (root) {
      await root.query(`drop schema if exists ${schema} cascade`);
      await root.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function review(
    repositoryId: string,
    number: number,
    mergedAt: Date | null,
    state: 'open' | 'closed' = 'closed',
  ) {
    const pullId = (
      await database.query<{ id: string }>(
        `insert into pull_requests(repository_id,github_id,number,title,state,merged_at,draft,
       author_login,html_url,base_ref,base_sha,head_ref,head_sha,github_updated_at)
       values($1,$2,$3,'Review',$4,$5,false,'fixture','https://example.invalid/pr',
       'main',$6,'feature',$7,clock_timestamp()) returning id`,
        [repositoryId, number, number, state, mergedAt, 'a'.repeat(40), 'b'.repeat(40)],
      )
    ).rows[0]!.id;
    const requestId = (
      await database.query<{ id: string }>(
        'insert into snapshot_requests(pull_request_id,base_sha,head_sha) values($1,$2,$3) returning id',
        [pullId, 'a'.repeat(40), 'b'.repeat(40)],
      )
    ).rows[0]!.id;
    const snapshotId = (
      await database.query<{ id: string }>(
        "insert into snapshots(request_id,version,resolution,policy_version,merge_base_sha) values($1,1,'exact','test',$2) returning id",
        [requestId, 'a'.repeat(40)],
      )
    ).rows[0]!.id;
    const analysisId = (
      await database.query<{ id: string }>(
        `insert into analysis_runs(snapshot_id,analysis_key,state,finished_at)
       values($1,$2,'completed',clock_timestamp()) returning id`,
        [snapshotId, `retention-${randomUUID()}`],
      )
    ).rows[0]!.id;
    return { pullId, analysisId, snapshotId };
  }

  it('deletes merged results older than seven days or outside the newest thirty per repository', async () => {
    const recent = Array.from(
      { length: 31 },
      (_, index) => new Date(Date.now() - (31 - index) * 60_000),
    );
    const merged = [];
    for (let index = 0; index < recent.length; index++)
      merged.push(await review(firstRepository, index + 1, recent[index]!));
    const old = await review(firstRepository, 32, new Date(Date.now() - 8 * 86400_000));
    const closedUnmerged = await review(firstRepository, 33, null);
    const open = await review(firstRepository, 34, null, 'open');
    const otherRepository = await review(secondRepository, 1, recent[0]!);

    const sessionId = (
      await database.query<{ id: string }>(
        'insert into chat_sessions(analysis_run_id,user_id) values($1,$2) returning id',
        [old.analysisId, userId],
      )
    ).rows[0]!.id;
    await database.query(
      "insert into chat_messages(session_id,role,status,content) values($1,'assistant','pending','')",
      [sessionId],
    );
    const store = new FilesystemArtifactStore(config.ARTIFACT_ROOT);
    const locator = `analysis/${old.analysisId}/report.json`;
    const artifact = await store.commitText(locator, '{}');
    await database.query(
      `insert into artifacts(scope_type,scope_id,artifact_type,version,checksum,byte_size,locator)
       values('analysis',$1,'report',1,$2,$3,$4)`,
      [old.analysisId, artifact.checksum, artifact.byteSize, locator],
    );

    await retention(config, false);
    const remaining = new Set(
      (await database.query<{ id: string }>('select id from analysis_runs')).rows.map(
        (row) => row.id,
      ),
    );
    expect(remaining.has(merged[0]!.analysisId)).toBe(false);
    expect(remaining.has(merged[1]!.analysisId)).toBe(true);
    expect(remaining.has(old.analysisId)).toBe(true);
    expect(remaining.has(closedUnmerged.analysisId)).toBe(true);
    expect(remaining.has(open.analysisId)).toBe(true);
    expect(remaining.has(otherRepository.analysisId)).toBe(true);
    expect(
      (await database.query('select id from snapshots where id=$1', [merged[0]!.snapshotId]))
        .rowCount,
    ).toBe(0);
    expect(await readFile(path.join(config.ARTIFACT_ROOT, locator), 'utf8')).toBe('{}');

    await database.query("update chat_messages set status='completed' where session_id=$1", [
      sessionId,
    ]);
    await retention(config, false);
    expect(
      (await database.query('select id from chat_sessions where id=$1', [sessionId])).rowCount,
    ).toBe(0);
    expect(
      (await database.query('select id from analysis_runs where id=$1', [old.analysisId])).rowCount,
    ).toBe(0);
    await expect(readFile(path.join(config.ARTIFACT_ROOT, locator))).rejects.toThrow();
  });

  it('waits for an active PR operation and a dependent analysis before deleting history', async () => {
    const old = await review(secondRepository, 2, new Date(Date.now() - 9 * 86400_000));
    const operationId = (
      await database.query<{ id: string }>(
        `insert into operations(type,scope_type,scope_id,state,dedupe_key)
       values('pr_refresh','pull_request',$1,'queued',$2) returning id`,
        [old.pullId, `retention-operation-${randomUUID()}`],
      )
    ).rows[0]!.id;
    const successorId = (
      await database.query<{ id: string }>(
        `insert into analysis_runs(snapshot_id,analysis_key,state,finished_at,resume_from_analysis_id)
       values($1,$2,'completed',clock_timestamp(),$3) returning id`,
        [old.snapshotId, `retention-successor-${randomUUID()}`, old.analysisId],
      )
    ).rows[0]!.id;
    await retention(config, false);
    expect(
      (await database.query('select id from analysis_runs where id=$1', [old.analysisId])).rowCount,
    ).toBe(1);
    expect(
      (await database.query('select id from analysis_runs where id=$1', [successorId])).rowCount,
    ).toBe(1);
    await database.query("update operations set state='completed' where id=$1", [operationId]);
    await retention(config, false);
    expect(
      (await database.query('select id from analysis_runs where id=$1', [successorId])).rowCount,
    ).toBe(0);
    await retention(config, false);
    expect(
      (await database.query('select id from analysis_runs where id=$1', [old.analysisId])).rowCount,
    ).toBe(0);
  });

  it('restores claimed artifacts when a PR reopens during the deletion grace period', async () => {
    const old = await review(secondRepository, 3, new Date(Date.now() - 9 * 86400_000));
    const store = new FilesystemArtifactStore(config.ARTIFACT_ROOT);
    const locator = `analysis/${old.analysisId}/reopened.json`;
    const committed = await store.commitText(locator, '{}');
    const artifactId = (
      await database.query<{ id: string }>(
        `insert into artifacts(scope_type,scope_id,artifact_type,version,checksum,byte_size,locator)
       values('analysis',$1,'report',1,$2,$3,$4) returning id`,
        [old.analysisId, committed.checksum, committed.byteSize, locator],
      )
    ).rows[0]!.id;
    await retention({ ...config, RETENTION_DELETE_GRACE_HOURS: 1 }, false);
    expect(
      (
        await database.query<{ state: string }>('select state from artifacts where id=$1', [
          artifactId,
        ])
      ).rows[0]?.state,
    ).toBe('deleting');
    await database.query("update pull_requests set state='open', merged_at=null where id=$1", [
      old.pullId,
    ]);
    await retention(config, false);
    expect(
      (
        await database.query<{ state: string }>('select state from artifacts where id=$1', [
          artifactId,
        ])
      ).rows[0]?.state,
    ).toBe('available');
    expect(
      (await database.query('select id from analysis_runs where id=$1', [old.analysisId])).rowCount,
    ).toBe(1);
    expect(await readFile(path.join(config.ARTIFACT_ROOT, locator), 'utf8')).toBe('{}');
  });
});
