import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  analyzeSnapshot,
  OpenAICompatibleReviewModel,
  type AnalysisFile,
  type ReviewModel,
} from '@gcr/analysis-engine';
import { FilesystemArtifactStore, type ArtifactCommit } from '@gcr/artifact-store';
import { createDatabase, type Database, type DatabaseClient } from '@gcr/db';
import {
  materializeFixtureSnapshot,
  materializeGitSnapshot,
  type SnapshotMaterialization,
} from '@gcr/git-engine';
import type { GitHubReader } from '@gcr/github';
import type { RelationshipGraph, ReviewReport } from '@gcr/review-contract';
import Fastify from 'fastify';
import type { AppConfig } from '../config.js';
import { appendEvent } from '../events/index.js';
import { createGitHubReader, getRepository } from '../services/repositories.js';

type JobPayload = {
  operationId: string;
  pullRequestId: string;
  snapshotRequestId?: string;
  analysisId?: string;
  snapshotId?: string;
};

type ClaimedJob = {
  id: string;
  type: 'snapshot.materialize' | 'analysis.run';
  payload: JobPayload;
  attempt_count: number;
  max_attempts: number;
  attempt_id: string;
};

type Logger = {
  info(value: object, message: string): void;
  error(value: object, message: string): void;
};

export async function runWorker(config: AppConfig): Promise<void> {
  await mkdir(config.WORKSPACE_ROOT, { recursive: true });
  await mkdir(config.ARTIFACT_ROOT, { recursive: true });
  const database = createDatabase(config.DATABASE_URL, Math.max(2, config.DATABASE_POOL_MAX));
  const github = await createGitHubReader(config);
  const artifacts = new FilesystemArtifactStore(config.ARTIFACT_ROOT);
  const model = createReviewModel(config);
  const executor = `${process.env.HOSTNAME ?? 'local'}:${process.pid}`;
  const health = Fastify({ logger: true });
  let lastLoopAt = Date.now();
  let stopping = false;
  const active = new Set<Promise<void>>();
  const shutdown = stopSignal().then(() => {
    stopping = true;
  });

  health.get('/health/live', async () => ({ status: 'ok' }));
  health.get('/health/ready', async (_request, reply) =>
    Date.now() - lastLoopAt < 15_000
      ? { status: 'ok' }
      : reply.code(503).send({ status: 'degraded' }),
  );
  await health.listen({ host: config.HOST, port: config.WORKER_HEALTH_PORT });

  while (!stopping) {
    lastLoopAt = Date.now();
    let claimed = false;
    while (!stopping && active.size < config.WORKER_CONCURRENCY) {
      const job = await claimJob(database, executor);
      if (!job) break;
      claimed = true;
      const task = executeJob(
        database,
        github,
        model,
        artifacts,
        config,
        executor,
        job,
        health.log,
      ).catch((error: unknown) => {
        health.log.error({ err: error, jobId: job.id }, 'worker loop failed');
      });
      active.add(task);
      void task.finally(() => active.delete(task));
    }
    if (!claimed || active.size >= config.WORKER_CONCURRENCY) {
      await Promise.race([shutdown, delay(500), ...active]);
    }
  }

  await Promise.all(active);
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
         where type in ('snapshot.materialize', 'analysis.run')
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
  model: ReviewModel | undefined,
  artifacts: FilesystemArtifactStore,
  config: AppConfig,
  executor: string,
  job: ClaimedJob,
  logger: Logger,
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
    if (job.type === 'snapshot.materialize') {
      await executeSnapshotJob(database, github, artifacts, config, workspace, job);
    } else {
      await executeAnalysisJob(database, model, artifacts, config, job);
    }
    await completeJob(database, job);
    logger.info({ jobId: job.id, type: job.type }, 'job completed');
  } catch (error) {
    await failJob(database, job, error);
    logger.error(
      {
        err: error,
        jobId: job.id,
        type: job.type,
        terminal: job.attempt_count >= job.max_attempts,
      },
      'job failed',
    );
  } finally {
    clearInterval(heartbeat);
    await rm(workspace, { recursive: true, force: true });
  }
}

async function executeSnapshotJob(
  database: Database,
  github: GitHubReader | null,
  artifacts: FilesystemArtifactStore,
  config: AppConfig,
  workspace: string,
  job: ClaimedJob,
) {
  await database.query(
    `update operations set state = 'materializing', started_at = coalesce(started_at, clock_timestamp()),
     updated_at = clock_timestamp() where id = $1`,
    [job.payload.operationId],
  );
  const materialization = await createMaterialization(database, github, config, workspace, job);
  await persistMaterialization(database, artifacts, job, materialization);
}

async function createMaterialization(
  database: Database,
  github: GitHubReader | null,
  config: AppConfig,
  workspace: string,
  job: ClaimedJob,
): Promise<SnapshotMaterialization> {
  const snapshotRequestId = requiredPayload(job, 'snapshotRequestId');
  const request = await database.query<{
    base_sha: string;
    head_sha: string;
    repository_id: string;
    number: number;
  }>(
    `select sr.base_sha, sr.head_sha, pr.repository_id, pr.number
     from snapshot_requests sr join pull_requests pr on pr.id = sr.pull_request_id
     where sr.id = $1`,
    [snapshotRequestId],
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
): Promise<void> {
  const snapshotRequestId = requiredPayload(job, 'snapshotRequestId');
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
      [snapshotRequestId],
    );
    await connection.query(
      `insert into snapshots(id, request_id, version, merge_base_sha, resolution, policy_version, manifest_checksum)
       values ($1,$2,$3,$4,$5,'snapshot-v1',$6)`,
      [
        snapshotId,
        snapshotRequestId,
        version.rows[0]!.version,
        materialization.mergeBaseSha,
        materialization.resolution,
        manifest.checksum,
      ],
    );
    await insertArtifact(
      connection,
      'snapshot',
      snapshotId,
      'snapshot-manifest',
      manifest,
      job.attempt_id,
    );
    await insertArtifact(connection, 'snapshot', snapshotId, 'diff-index', diff, job.attempt_id);
    await insertArtifact(connection, 'snapshot', snapshotId, 'commits', commits, job.attempt_id);
    for (const fileArtifact of fileArtifacts) {
      const artifactId = await insertArtifact(
        connection,
        'snapshot',
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
      snapshotRequestId,
    ]);

    let analysisId: string | null = null;
    if (materialization.resolution === 'exact') {
      const analysis = await connection.query<{ id: string }>(
        `insert into analysis_runs(snapshot_id, analysis_key, state, stage, progress, model_profile)
         values ($1, $2, 'queued', 'planning', 0, $3)
         on conflict (analysis_key) do update set analysis_key = excluded.analysis_key returning id`,
        [snapshotId, `analysis:${snapshotId}:default:v1`, 'configured-at-worker'],
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
  } catch (error) {
    await connection.query('rollback');
    throw error;
  } finally {
    connection.release();
  }
}

async function executeAnalysisJob(
  database: Database,
  model: ReviewModel | undefined,
  artifacts: FilesystemArtifactStore,
  config: AppConfig,
  job: ClaimedJob,
): Promise<void> {
  const analysisId = requiredPayload(job, 'analysisId');
  const snapshotId = requiredPayload(job, 'snapshotId');
  const existing = await database.query('select 1 from reports where analysis_run_id = $1', [
    analysisId,
  ]);
  if (existing.rowCount) return;
  await updateAnalysisState(database, job, 'analyzing', 'deterministic', 20);
  const identity = await database.query<{ base_sha: string; head_sha: string }>(
    `select sr.base_sha, sr.head_sha from snapshots s
     join snapshot_requests sr on sr.id = s.request_id where s.id = $1`,
    [snapshotId],
  );
  const row = identity.rows[0];
  if (!row) throw new Error('Analysis snapshot is unavailable');
  const locator = await database.query<{ locator: string }>(
    `select locator from artifacts where scope_type = 'snapshot' and scope_id = $1
     and artifact_type = 'diff-index' and version = 1 and state = 'available'`,
    [snapshotId],
  );
  if (!locator.rows[0]) throw new Error('Snapshot diff artifact is unavailable');
  const diff = await artifacts.readJson<{
    schemaVersion: 1;
    patch: string;
    files: Array<Omit<AnalysisFile, 'id'>>;
  }>(locator.rows[0].locator);
  const fileRows = await database.query<{
    id: string;
    path: string;
  }>('select id, path from snapshot_files where snapshot_id = $1', [snapshotId]);
  const fileIds = new Map(fileRows.rows.map((file) => [file.path, file.id]));
  const files: AnalysisFile[] = diff.files.flatMap((file) => {
    const id = fileIds.get(file.path);
    return id ? [{ id, ...file }] : [];
  });
  await updateAnalysisState(database, job, 'analyzing', 'review', 55);
  const output = await analyzeSnapshot({
    analysisId,
    snapshotId,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    patch: diff.patch,
    files,
    fixtureMode: config.GITHUB_MODE === 'fixture',
    ...(model ? { model } : {}),
    budgets: {
      maxFiles: config.ANALYSIS_MAX_FILES,
      maxBytes: config.ANALYSIS_MAX_BYTES,
      maxModelCalls: config.ANALYSIS_MAX_MODEL_CALLS,
    },
  });
  await updateAnalysisState(database, job, 'analyzing', 'persisting', 90);
  await persistAnalysis(database, artifacts, job, output.report, output.graph, output.state);
}

async function persistAnalysis(
  database: Database,
  artifacts: FilesystemArtifactStore,
  job: ClaimedJob,
  report: ReviewReport,
  graph: RelationshipGraph,
  state: 'completed' | 'partial',
) {
  const analysisId = requiredPayload(job, 'analysisId');
  const reportArtifact = await artifacts.commitText(
    `analyses/${analysisId}/report.v1.json`,
    JSON.stringify(report),
  );
  const graphArtifact = await artifacts.commitText(
    `analyses/${analysisId}/relationships.v1.json`,
    JSON.stringify(graph),
  );
  const reportId = randomUUID();
  const connection = await database.connect();
  try {
    await connection.query('begin');
    const reportArtifactId = await insertArtifact(
      connection,
      'analysis',
      analysisId,
      'report',
      reportArtifact,
      job.attempt_id,
    );
    await insertArtifact(
      connection,
      'analysis',
      analysisId,
      'relationships',
      graphArtifact,
      job.attempt_id,
    );
    await connection.query(
      `insert into reports(id, analysis_run_id, schema_version, grade, summary,
         has_critical_findings, coverage, impact, artifact_id)
       values ($1,$2,1,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
      [
        reportId,
        analysisId,
        report.grade,
        report.summary,
        report.hasCriticalFindings,
        JSON.stringify(report.coverage),
        JSON.stringify(report.impact),
        reportArtifactId,
      ],
    );
    for (const finding of report.findings) {
      await connection.query(
        `insert into findings(id, report_id, priority, category, confidence, source_kind,
           producer, rule, title, problem, impact, recommendation, anchor, evidence,
           verification, fingerprint)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16)`,
        [
          finding.id,
          reportId,
          finding.priority,
          finding.category,
          finding.confidence,
          finding.source.kind,
          finding.source.producer,
          finding.source.rule ?? null,
          finding.title,
          finding.problem,
          finding.impact,
          finding.recommendation,
          JSON.stringify(finding.anchor),
          JSON.stringify(finding.evidence),
          JSON.stringify(finding.verification),
          finding.fingerprint,
        ],
      );
    }
    for (const object of graph.objects) {
      await connection.query(
        `insert into code_objects(id, analysis_run_id, kind, qualified_name, change, definition)
         values ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          object.id,
          analysisId,
          object.kind,
          object.qualifiedName,
          object.change,
          object.definition ? JSON.stringify(object.definition) : null,
        ],
      );
    }
    for (const relation of graph.relations) {
      await connection.query(
        `insert into code_relations(id, analysis_run_id, source_object_id, target_object_id,
           kind, distance, change, confidence, evidence)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [
          relation.id,
          analysisId,
          relation.sourceObjectId,
          relation.targetObjectId,
          relation.kind,
          relation.distance,
          relation.change,
          relation.confidence,
          JSON.stringify(relation.evidence),
        ],
      );
    }
    await connection.query(
      `update analysis_runs set state = $2, stage = 'published', progress = 100,
       limitations = $3::jsonb, finished_at = clock_timestamp() where id = $1`,
      [analysisId, state, JSON.stringify(report.coverage.limitations)],
    );
    await connection.query(
      `update operations set state = 'completed', finished_at = clock_timestamp(),
       updated_at = clock_timestamp() where id = $1`,
      [job.payload.operationId],
    );
    const eventPayload = {
      analysisId,
      revision: 1,
      state,
      stage: 'published',
      progress: 100,
      reportUrl: `/api/v1/analyses/${analysisId}`,
    };
    await appendEvent(
      connection,
      'pull_request',
      job.payload.pullRequestId,
      'analysis.available',
      eventPayload,
    );
    await appendEvent(connection, 'analysis', analysisId, 'analysis.available', eventPayload);
    await connection.query('commit');
  } catch (error) {
    await connection.query('rollback');
    throw error;
  } finally {
    connection.release();
  }
}

async function updateAnalysisState(
  database: Database,
  job: ClaimedJob,
  state: 'analyzing',
  stage: string,
  progress: number,
) {
  const analysisId = requiredPayload(job, 'analysisId');
  await database.query(
    `update analysis_runs set state = $2, stage = $3, progress = $4,
     started_at = coalesce(started_at, clock_timestamp()) where id = $1`,
    [analysisId, state, stage, progress],
  );
  const payload = { analysisId, revision: 1, state, stage, progress };
  await appendEvent(database, 'pull_request', job.payload.pullRequestId, 'analysis.state', payload);
  await appendEvent(database, 'analysis', analysisId, 'analysis.state', payload);
}

async function completeJob(database: Database, job: ClaimedJob) {
  await database.query(
    `update job_attempts set ended_at = clock_timestamp(), outcome = 'completed' where id = $1`,
    [job.attempt_id],
  );
  await database.query(
    `update jobs set state = 'completed', lease_owner = null, lease_expires_at = null,
     updated_at = clock_timestamp() where id = $1`,
    [job.id],
  );
}

async function failJob(database: Database, job: ClaimedJob, error: unknown) {
  const terminal = job.attempt_count >= job.max_attempts;
  const code = job.type === 'snapshot.materialize' ? 'SNAPSHOT_FAILED' : 'ANALYSIS_FAILED';
  await database.query(
    `update job_attempts set ended_at = clock_timestamp(), outcome = $2, error_code = $3 where id = $1`,
    [job.attempt_id, terminal ? 'failed' : 'retry', code],
  );
  await database.query(
    `update jobs set state = $2, available_at = clock_timestamp() + interval '30 seconds',
     lease_owner = null, lease_expires_at = null, last_error = $3::jsonb,
     updated_at = clock_timestamp() where id = $1`,
    [
      job.id,
      terminal ? 'failed' : 'queued',
      JSON.stringify({ code, retryable: !terminal, message: errorMessage(error) }),
    ],
  );
  if (!terminal) return;
  await database.query(
    `update operations set state = 'failed', finished_at = clock_timestamp(),
     error = $2::jsonb, updated_at = clock_timestamp() where id = $1`,
    [job.payload.operationId, JSON.stringify({ code, retryable: false })],
  );
  if (job.type === 'snapshot.materialize') {
    await database.query(`update snapshot_requests set state = 'failed' where id = $1`, [
      requiredPayload(job, 'snapshotRequestId'),
    ]);
  } else {
    await database.query(
      `update analysis_runs set state = 'failed', stage = 'failed', finished_at = clock_timestamp(),
       limitations = $2::jsonb where id = $1`,
      [requiredPayload(job, 'analysisId'), JSON.stringify([errorMessage(error)])],
    );
  }
  const payload = {
    operationId: job.payload.operationId,
    analysisId: job.payload.analysisId ?? null,
    state: 'failed',
    stage: job.type === 'snapshot.materialize' ? 'snapshot' : 'analysis',
    progress: 0,
  };
  await appendEvent(database, 'pull_request', job.payload.pullRequestId, 'analysis.state', payload);
  if (job.payload.analysisId) {
    await appendEvent(database, 'analysis', job.payload.analysisId, 'analysis.state', payload);
  }
}

async function insertArtifact(
  connection: DatabaseClient,
  scopeType: 'snapshot' | 'analysis',
  scopeId: string,
  type: string,
  artifact: ArtifactCommit,
  attemptId: string,
): Promise<string> {
  const result = await connection.query<{ id: string }>(
    `insert into artifacts(scope_type, scope_id, artifact_type, version, checksum, byte_size, locator, producer_attempt_id)
     values ($1, $2, $3, 1, $4, $5, $6, $7) returning id`,
    [scopeType, scopeId, type, artifact.checksum, artifact.byteSize, artifact.locator, attemptId],
  );
  return result.rows[0]!.id;
}

function createReviewModel(config: AppConfig): ReviewModel | undefined {
  return config.MODEL_MODE === 'openai-compatible'
    ? new OpenAICompatibleReviewModel(
        config.MODEL_ENDPOINT!,
        config.MODEL_API_KEY!,
        config.MODEL_NAME!,
        config.MODEL_TIMEOUT_MS,
      )
    : undefined;
}

function requiredPayload(job: ClaimedJob, key: keyof JobPayload): string {
  const value = job.payload[key];
  if (!value) throw new Error(`Job payload is missing ${key}`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'Unknown job failure';
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
