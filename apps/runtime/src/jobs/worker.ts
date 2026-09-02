import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { FilesystemArtifactStore, type ArtifactCommit } from '@gcr/artifact-store';
import { createDatabase, type Database, type DatabaseClient } from '@gcr/db';
import {
  materializeFixtureSnapshot,
  materializeGitSnapshot,
  type SnapshotMaterialization,
} from '@gcr/git-engine';
import type { GitHubReader } from '@gcr/github';
import Fastify from 'fastify';
import type { AppConfig } from '../config.js';
import { appendEvent } from '../events/index.js';
import { createGitHubReader, getRepository } from '../services/repositories.js';

type ClaimedJob = {
  id: string;
  type: string;
  payload: { operationId: string; snapshotRequestId: string; pullRequestId: string };
  attempt_count: number;
  max_attempts: number;
  attempt_id: string;
};

export async function runWorker(config: AppConfig): Promise<void> {
  await mkdir(config.WORKSPACE_ROOT, { recursive: true });
  await mkdir(config.ARTIFACT_ROOT, { recursive: true });
  const database = createDatabase(config.DATABASE_URL, Math.max(2, config.DATABASE_POOL_MAX));
  const github = await createGitHubReader(config);
  const artifacts = new FilesystemArtifactStore(config.ARTIFACT_ROOT);
  const executor = `${process.env.HOSTNAME ?? 'local'}:${process.pid}`;
  const health = Fastify({ logger: true });
  let lastLoopAt = Date.now();
  let stopping = false;
  let active: Promise<void> | null = null;

  health.get('/health/live', async () => ({ status: 'ok' }));
  health.get('/health/ready', async (_request, reply) =>
    Date.now() - lastLoopAt < 15_000
      ? { status: 'ok' }
      : reply.code(503).send({ status: 'degraded' }),
  );
  await health.listen({ host: config.HOST, port: config.WORKER_HEALTH_PORT });

  while (!stopping) {
    lastLoopAt = Date.now();
    const job = await claimJob(database, executor);
    if (!job) {
      await Promise.race([delay(500), stopSignal().then(() => (stopping = true))]);
      continue;
    }
    active = executeJob(database, github, artifacts, config, executor, job, health.log);
    await active;
    active = null;
  }

  if (active) await active;
  await health.close();
  await database.end();
}

async function claimJob(database: Database, executor: string): Promise<ClaimedJob | null> {
  const connection = await database.connect();
  try {
    await connection.query('begin');
    const result = await connection.query<Omit<ClaimedJob, 'attempt_id'>>(
      `with candidate as (
         select id from jobs
         where type = 'snapshot.materialize'
           and ((state = 'queued' and available_at <= clock_timestamp())
             or (state = 'running' and lease_expires_at < clock_timestamp()))
           and attempt_count < max_attempts
         order by priority, available_at, created_at
         for update skip locked limit 1
       )
       update jobs j set state = 'running', lease_owner = $1,
         lease_expires_at = clock_timestamp() + interval '30 seconds',
         heartbeat_at = clock_timestamp(), attempt_count = attempt_count + 1,
         updated_at = clock_timestamp()
       from candidate where j.id = candidate.id
       returning j.id, j.type, j.payload, j.attempt_count, j.max_attempts`,
      [executor],
    );
    const job = result.rows[0];
    if (!job) {
      await connection.query('commit');
      return null;
    }
    const attempt = await connection.query<{ id: string }>(
      `insert into job_attempts(job_id, attempt_number, executor)
       values ($1, $2, $3) returning id`,
      [job.id, job.attempt_count, executor],
    );
    await connection.query('commit');
    return { ...job, attempt_id: attempt.rows[0]!.id };
  } catch (error) {
    await connection.query('rollback');
    throw error;
  } finally {
    connection.release();
  }
}

async function executeJob(
  database: Database,
  github: GitHubReader | null,
  artifacts: FilesystemArtifactStore,
  config: AppConfig,
  executor: string,
  job: ClaimedJob,
  logger: {
    info(value: object, message: string): void;
    error(value: object, message: string): void;
  },
): Promise<void> {
  const heartbeat = setInterval(
    () =>
      void database.query(
        `update jobs set lease_expires_at = clock_timestamp() + interval '30 seconds',
         heartbeat_at = clock_timestamp(), updated_at = clock_timestamp()
         where id = $1 and state = 'running' and lease_owner = $2`,
        [job.id, executor],
      ),
    10_000,
  );
  const workspace = path.join(config.WORKSPACE_ROOT, `job-${job.id}-${job.attempt_count}`);
  try {
    await database.query(
      `update operations set state = 'materializing', started_at = coalesce(started_at, clock_timestamp()),
       updated_at = clock_timestamp() where id = $1`,
      [job.payload.operationId],
    );
    const materialization = await createMaterialization(database, github, config, workspace, job);
    const result = await persistMaterialization(database, artifacts, job, materialization);
    await database.query(
      `update job_attempts set ended_at = clock_timestamp(), outcome = 'completed' where id = $1`,
      [job.attempt_id],
    );
    await database.query(
      `update jobs set state = 'completed', lease_owner = null, lease_expires_at = null,
       updated_at = clock_timestamp() where id = $1`,
      [job.id],
    );
    logger.info({ jobId: job.id, snapshotId: result.snapshotId }, 'snapshot materialized');
  } catch (error) {
    const terminal = job.attempt_count >= job.max_attempts;
    await database.query(
      `update job_attempts set ended_at = clock_timestamp(), outcome = $2, error_code = 'SNAPSHOT_FAILED'
       where id = $1`,
      [job.attempt_id, terminal ? 'failed' : 'retry'],
    );
    await database.query(
      `update jobs set state = $2, available_at = clock_timestamp() + interval '30 seconds',
       lease_owner = null, lease_expires_at = null,
       last_error = '{"code":"SNAPSHOT_FAILED","retryable":true}'::jsonb,
       updated_at = clock_timestamp() where id = $1`,
      [job.id, terminal ? 'failed' : 'queued'],
    );
    if (terminal) {
      await database.query(
        `update operations set state = 'failed', finished_at = clock_timestamp(),
         error = '{"code":"SNAPSHOT_FAILED","retryable":false}'::jsonb,
         updated_at = clock_timestamp() where id = $1`,
        [job.payload.operationId],
      );
      await database.query(`update snapshot_requests set state = 'failed' where id = $1`, [
        job.payload.snapshotRequestId,
      ]);
      await appendEvent(database, 'pull_request', job.payload.pullRequestId, 'analysis.state', {
        operationId: job.payload.operationId,
        state: 'failed',
        stage: 'snapshot',
        progress: 0,
      });
    }
    logger.error({ err: error, jobId: job.id, terminal }, 'snapshot job failed');
  } finally {
    clearInterval(heartbeat);
    await rm(workspace, { recursive: true, force: true });
  }
}

async function createMaterialization(
  database: Database,
  github: GitHubReader | null,
  config: AppConfig,
  workspace: string,
  job: ClaimedJob,
): Promise<SnapshotMaterialization> {
  const request = await database.query<{
    base_sha: string;
    head_sha: string;
    repository_id: string;
    number: number;
  }>(
    `select sr.base_sha, sr.head_sha, pr.repository_id, pr.number
     from snapshot_requests sr join pull_requests pr on pr.id = sr.pull_request_id
     where sr.id = $1`,
    [job.payload.snapshotRequestId],
  );
  const row = request.rows[0];
  if (!row) throw new Error('Snapshot request is unavailable');
  if (config.GITHUB_MODE === 'fixture')
    return materializeFixtureSnapshot(row.base_sha, row.head_sha);
  const repository = await getRepository(database, row.repository_id);
  if (!repository || !github?.getGitCredential) throw new Error('GitHub repository is unavailable');
  return materializeGitSnapshot({
    workspace,
    webBaseUrl: repository.webBaseUrl,
    owner: repository.owner,
    repository: repository.name,
    pullNumber: row.number,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    credential: await github.getGitCredential(repository),
  });
}

async function persistMaterialization(
  database: Database,
  artifacts: FilesystemArtifactStore,
  job: ClaimedJob,
  materialization: SnapshotMaterialization,
): Promise<{ snapshotId: string; analysisId: string | null }> {
  const snapshotId = randomUUID();
  const prefix = `snapshots/${snapshotId}`;
  const fileArtifacts = await Promise.all(
    materialization.files.map(async (file) => ({
      id: randomUUID(),
      file,
      commit: await artifacts.commitText(`${prefix}/diffs/${randomUUID()}.patch`, file.patch),
    })),
  );
  const diff = await artifacts.commitText(
    `${prefix}/diff-index.v1.json`,
    JSON.stringify({
      schemaVersion: 1,
      patch: materialization.patch,
      files: materialization.files,
    }),
  );
  const commits = await artifacts.commitText(
    `${prefix}/commits.v1.json`,
    JSON.stringify({ schemaVersion: 1, commits: materialization.commits }),
  );
  const manifest = await artifacts.commitText(
    `${prefix}/snapshot-manifest.v1.json`,
    JSON.stringify({
      schemaVersion: 1,
      snapshotId,
      baseSha: materialization.baseSha,
      headSha: materialization.headSha,
      mergeBaseSha: materialization.mergeBaseSha,
      resolution: materialization.resolution,
      fileCount: materialization.files.length,
    }),
  );

  const connection = await database.connect();
  try {
    await connection.query('begin');
    const version = await connection.query<{ version: number }>(
      `select coalesce(max(version), 0) + 1 as version from snapshots where request_id = $1`,
      [job.payload.snapshotRequestId],
    );
    const snapshotVersion = version.rows[0]!.version;
    await connection.query(
      `insert into snapshots(id, request_id, version, merge_base_sha, resolution, policy_version, manifest_checksum)
       values ($1,$2,$3,$4,$5,'snapshot-v1',$6)`,
      [
        snapshotId,
        job.payload.snapshotRequestId,
        snapshotVersion,
        materialization.mergeBaseSha,
        materialization.resolution,
        manifest.checksum,
      ],
    );
    const manifestId = await insertArtifact(
      connection,
      snapshotId,
      'snapshot-manifest',
      manifest,
      job.attempt_id,
    );
    void manifestId;
    await insertArtifact(connection, snapshotId, 'diff-index', diff, job.attempt_id);
    await insertArtifact(connection, snapshotId, 'commits', commits, job.attempt_id);
    for (const fileArtifact of fileArtifacts) {
      const artifactId = await insertArtifact(
        connection,
        snapshotId,
        `file-patch:${fileArtifact.id}`,
        fileArtifact.commit,
        job.attempt_id,
      );
      await connection.query(
        `insert into snapshot_files(id, snapshot_id, path, previous_path, status, additions, deletions, patch_artifact_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          fileArtifact.id,
          snapshotId,
          fileArtifact.file.path,
          fileArtifact.file.previousPath,
          fileArtifact.file.status,
          fileArtifact.file.additions,
          fileArtifact.file.deletions,
          artifactId,
        ],
      );
    }
    await connection.query(`update snapshot_requests set state = 'materialized' where id = $1`, [
      job.payload.snapshotRequestId,
    ]);

    let analysisId: string | null = null;
    if (materialization.resolution === 'exact') {
      const analysis = await connection.query<{ id: string }>(
        `insert into analysis_runs(snapshot_id, analysis_key, state, stage, progress)
         values ($1, $2, 'queued', 'planning', 0)
         on conflict (analysis_key) do update set analysis_key = excluded.analysis_key returning id`,
        [snapshotId, `analysis:${snapshotId}:default:v1`],
      );
      analysisId = analysis.rows[0]!.id;
      await connection.query(
        `insert into jobs(type, payload, priority, dedupe_key)
         values ('analysis.run', $1::jsonb, 100, $2) on conflict do nothing`,
        [
          JSON.stringify({
            operationId: job.payload.operationId,
            analysisId,
            snapshotId,
            pullRequestId: job.payload.pullRequestId,
          }),
          `analysis.run:${analysisId}`,
        ],
      );
    }
    await connection.query(
      `update operations set state = $2, result = $3::jsonb,
         finished_at = case when $2 = 'completed' then clock_timestamp() else null end,
         updated_at = clock_timestamp() where id = $1`,
      [
        job.payload.operationId,
        analysisId ? 'analyzing' : 'completed',
        JSON.stringify({ snapshotChanged: true, snapshotId, analysisId }),
      ],
    );
    await appendEvent(
      connection,
      'pull_request',
      job.payload.pullRequestId,
      'snapshot.materialized',
      {
        operationId: job.payload.operationId,
        snapshotId,
        resolution: materialization.resolution,
        analysisId,
      },
    );
    if (analysisId) {
      await appendEvent(connection, 'pull_request', job.payload.pullRequestId, 'analysis.state', {
        analysisId,
        revision: 1,
        state: 'queued',
        stage: 'planning',
        progress: 0,
      });
    }
    await connection.query('commit');
    return { snapshotId, analysisId };
  } catch (error) {
    await connection.query('rollback');
    throw error;
  } finally {
    connection.release();
  }
}

async function insertArtifact(
  connection: DatabaseClient,
  snapshotId: string,
  type: string,
  artifact: ArtifactCommit,
  attemptId: string,
): Promise<string> {
  const result = await connection.query<{ id: string }>(
    `insert into artifacts(scope_type, scope_id, artifact_type, version, checksum, byte_size, locator, producer_attempt_id)
     values ('snapshot', $1, $2, 1, $3, $4, $5, $6) returning id`,
    [snapshotId, type, artifact.checksum, artifact.byteSize, artifact.locator, attemptId],
  );
  return result.rows[0]!.id;
}

let signalPromise: Promise<void> | undefined;
function stopSignal(): Promise<void> {
  signalPromise ??= new Promise((resolve) => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
  return signalPromise;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
