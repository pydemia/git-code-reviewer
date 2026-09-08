import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FilesystemArtifactStore } from '@gcr/artifact-store';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { FixtureGitHubClient } from '@gcr/github';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../config.js';
import { requestPullRefresh } from '../services/operations.js';
import { ensureFixtureRepository, pollRepository } from '../services/repositories.js';
import { executeSnapshotJob } from './worker.js';

const databaseUrl = process.env.GCR_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl).sequential('analysis review memory pinning', () => {
  const schema = `gcr_worker_memory_${randomUUID().replaceAll('-', '')}`;
  let root: Database;
  let database: Database;
  let artifacts: FilesystemArtifactStore;
  let config: AppConfig;
  let directory: string;
  let repositoryId: string;
  let pullRequestId: string;
  let firstUserId: string;
  let secondUserId: string;
  let collectiveAnalysisId: string;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw Error('Use an isolated local test PostgreSQL');
    }
    directory = await mkdtemp(path.join(tmpdir(), 'gcr-worker-memory-'));
    root = createDatabase(url.toString());
    await root.query(`create schema ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    database = createDatabase(url.toString());
    await runMigrations(database, path.resolve('packages/db/migrations'));
    config = loadConfig({
      DATABASE_URL: url.toString(),
      AUTH_MODE: 'development',
      GITHUB_MODE: 'fixture',
      ARTIFACT_ROOT: path.join(directory, 'artifacts'),
      WORKSPACE_ROOT: path.join(directory, 'workspaces'),
    });
    artifacts = new FilesystemArtifactStore(config.ARTIFACT_ROOT);
    for (const [subject, assign] of [
      ['synthetic:first-memory', (id: string) => (firstUserId = id)],
      ['synthetic:second-memory', (id: string) => (secondUserId = id)],
    ] as const) {
      const id = (
        await database.query(
          `insert into users(oidc_subject, display_name, role)
           values ($1,$1,'reviewer') returning id`,
          [subject],
        )
      ).rows[0].id;
      assign(id);
    }
    repositoryId = (await ensureFixtureRepository(database))!;
    await pollRepository(database, new FixtureGitHubClient(), repositoryId);
    pullRequestId = (
      await database.query(
        `select id from pull_requests where repository_id = $1 and number = 184`,
        [repositoryId],
      )
    ).rows[0].id;
    await insertActiveMemory('collective', null, '1'.repeat(64), '집단 검토 결정');
    await insertActiveMemory('personal', firstUserId, '2'.repeat(64), '개인 검토 관심사');

    const pollJob = (
      await database.query(
        `select * from jobs where type = 'snapshot.materialize'
          and payload->>'pullRequestId' = $1 order by created_at limit 1`,
        [pullRequestId],
      )
    ).rows[0];
    const completed = await executeMaterialization(pollJob);
    collectiveAnalysisId = completed.analysisId;
  });

  afterAll(async () => {
    await database?.end();
    if (root) {
      await root.query(`drop schema if exists ${schema} cascade`);
      await root.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('pins only collective memory for polling analysis', async () => {
    const analysis = (
      await database.query(
        `select memory_owner_user_id, memory_hash, memory_context, analysis_key
           from analysis_runs where id = $1`,
        [collectiveAnalysisId],
      )
    ).rows[0];
    expect(analysis.memory_owner_user_id).toBeNull();
    expect(analysis.memory_context.map(({ scope }: { scope: string }) => scope)).toEqual([
      'collective',
    ]);
    expect(analysis.analysis_key).toContain(`:collective:${analysis.memory_hash}`);
  });

  it('separates manual operations by user and pins collective memory before personal memory', async () => {
    const first = await requestPullRefresh(database, repositoryId, 184, firstUserId);
    const duplicate = await requestPullRefresh(database, repositoryId, 184, firstUserId);
    const second = await requestPullRefresh(database, repositoryId, 184, secondUserId);
    expect(duplicate).toMatchObject({ id: first!.id, deduplicated: true });
    expect(second).toMatchObject({ deduplicated: false });
    expect(second!.id).not.toBe(first!.id);

    const manualJob = (
      await database.query(
        `select * from jobs where type = 'snapshot.materialize'
          and payload->>'operationId' = $1`,
        [first!.id],
      )
    ).rows[0];
    const completed = await executeMaterialization(manualJob);
    const analysis = (
      await database.query(
        `select memory_owner_user_id, memory_hash, memory_context, analysis_key
           from analysis_runs where id = $1`,
        [completed.analysisId],
      )
    ).rows[0];
    expect(analysis.memory_owner_user_id).toBe(firstUserId);
    expect(analysis.memory_context.map(({ scope }: { scope: string }) => scope)).toEqual([
      'collective',
      'personal',
    ]);
    expect(analysis.analysis_key).toContain(`:${firstUserId}:${analysis.memory_hash}`);
    expect(analysis.analysis_key).not.toBe(
      (
        await database.query(`select analysis_key from analysis_runs where id = $1`, [
          collectiveAnalysisId,
        ])
      ).rows[0].analysis_key,
    );
  });

  async function insertActiveMemory(
    scope: 'personal' | 'collective',
    ownerUserId: string | null,
    aggregationKey: string,
    summary: string,
  ): Promise<void> {
    const tenantId = (
      await database.query(`select tenant_id from repositories where id = $1`, [repositoryId])
    ).rows[0].tenant_id;
    await database.query(
      `insert into review_memories(
         tenant_id, repository_id, scope, owner_user_id, kind, state, summary, search_text,
         aggregation_key, contributor_count, confidence, importance, source_kind, content_hash,
         created_by, reviewed_by, reviewed_at)
       values ($1,$2,$3,$4,'decision','active',$5,$5,$6,$7,0.9,5,'manual',$8,$4,$9,
         clock_timestamp())`,
      [
        tenantId,
        repositoryId,
        scope,
        ownerUserId,
        summary,
        aggregationKey,
        scope === 'collective' ? 2 : 1,
        scope === 'collective' ? '3'.repeat(64) : '4'.repeat(64),
        firstUserId,
      ],
    );
  }

  async function executeMaterialization(job: Record<string, unknown>) {
    const attemptId = (
      await database.query(
        `insert into job_attempts(job_id, attempt_number, executor)
         values ($1,1,'memory-test') returning id`,
        [job.id],
      )
    ).rows[0].id;
    await executeSnapshotJob(
      database,
      null,
      artifacts,
      config,
      path.join(directory, `workspace-${randomUUID()}`),
      { ...job, attempt_count: 1, attempt_id: attemptId } as Parameters<
        typeof executeSnapshotJob
      >[5],
    );
    const operation = (
      await database.query(`select result from operations where id = $1`, [
        (job.payload as { operationId: string }).operationId,
      ])
    ).rows[0];
    return operation.result as { snapshotId: string; analysisId: string };
  }
});
