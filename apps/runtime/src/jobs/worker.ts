import { observeReport } from '../services/report-observation.js';
import {
  pinSharedKnowledge,
  readSharedKnowledgePin,
  prepareSharedAnalysisKnowledge,
  withSharedKnowledge,
  sharedCriterionContext,
} from '../services/analysis-shared-knowledge.js';
import { createHash, randomUUID } from 'node:crypto';
import { loadReviewRecurrence } from '../services/review-recurrence.js';
import { captureSnapshotChangeSource } from '../services/criterion-code-sources.js';
import { reconcileCriterionDeadlines } from '../services/criterion-recheck.js';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  analyzeSnapshot,
  validateReviewSkillBundle,
  type AnalysisFile,
} from '@gcr/analysis-engine';
import { defaultReviewSeverityLevel, type ReviewSeverityLevel } from '@gcr/contracts';
import { FilesystemArtifactStore, type ArtifactCommit } from '@gcr/artifact-store';
import type { Database, DatabaseClient } from '@gcr/db';
import { openRuntimeDatabase } from '../database.js';
import {
  materializeFixtureSnapshot,
  materializeGitSnapshot,
  type SnapshotMaterialization,
} from '@gcr/git-engine';
import { GitHubRequestError, type GitHubReader } from '@gcr/github';
import type { RelationshipGraph, ReviewReport } from '@gcr/review-contract';
import Fastify from 'fastify';
import type { AppConfig } from '../config.js';
import { identityAdministrationConfig } from '../identity/config.js';
import { KeycloakAdminClient } from '../identity/keycloak-admin.js';
import { processIdentityOperation, type IdentityAdministration } from '../identity/processor.js';
import { KeycloakSecurityClient } from '../identity/keycloak-security.js';
import {
  reconcileIdentitySecurity,
  type IdentitySecurityAdministration,
} from '../identity/security-processor.js';
import { processIdentityReactivation } from '../identity/reactivation.js';
import { appendEvent } from '../events/index.js';
import { claimAgentRun, executeAgentRun } from '../services/chat-agent.js';
import { removeExpiredKnowledgeManifests } from '../services/knowledge-manifest.js';
import { publishNextKnowledge } from '../services/knowledge-publication.js';
import { withModelBudget } from '../services/model-admission.js';
import {
  claimCriterionGeneration,
  executeCriterionGeneration,
} from '../services/criterion-generation.js';
import { assertJobLease, checkpointReviewModel } from '../services/analysis-checkpoint.js';
import { recoverExpiredJobs } from './recovery.js';
import { withAnalysisSourceContext } from '../services/analysis-source-context.js';
import {
  createReviewModel,
  deploymentAnalysisProvider,
  getActiveAnalysisProviderRow,
  resolveAnalysisProvider,
} from '../services/analysis-provider.js';
import { createGitHubReader, getRepository } from '../services/repositories.js';
import { registeredGitHubReader } from '../services/account-registry.js';
import { isFixtureRepository } from '../services/fixture-repository.js';
import {
  getEffectiveReviewSkills,
  resolvePinnedReviewSkills,
} from '../services/analysis-skills.js';
import {
  enqueueReviewPublication,
  publishReviewToGitHub,
  ReviewPublicationError,
} from '../services/review-publication.js';
import {
  createFindingReviewMemoryCandidates,
  recallReviewMemories,
} from '../services/review-memory.js';

type JobPayload = {
  operationId?: string;
  pullRequestId: string;
  snapshotRequestId?: string;
  analysisId?: string;
  snapshotId?: string;
  memoryOwnerUserId?: string;
  // 승인된 운영 재분석은 공동 report를 저장하되 GitHub에는 게시하지 않는다.
  skipPublication?: boolean;
};

type ClaimedJob = {
  id: string;
  type: 'snapshot.materialize' | 'analysis.run' | 'github.review.publish';
  payload: JobPayload;
  attempt_count: number;
  max_attempts: number;
  attempt_id: string;
};

type Logger = {
  info(value: object, message: string): void;
  error(value: object, message: string): void;
};

export async function runWorker(
  config: AppConfig,
  options: {
    readonly identityAdministration?: IdentityAdministration;
    readonly identitySecurity?: IdentitySecurityAdministration;
    readonly signal?: AbortSignal;
  } = {},
): Promise<void> {
  await mkdir(config.WORKSPACE_ROOT, { recursive: true });
  await mkdir(config.ARTIFACT_ROOT, { recursive: true });
  const database = await openRuntimeDatabase(config, Math.max(2, config.DATABASE_POOL_MAX));
  const github = await createGitHubReader(config);
  const artifacts = new FilesystemArtifactStore(config.ARTIFACT_ROOT);
  const executor = `${process.env.HOSTNAME ?? 'local'}:${process.pid}`;
  const health = Fastify({ logger: true });
  const identityConfig = identityAdministrationConfig(config);
  const identityAdmin = identityConfig
    ? (options.identityAdministration ?? new KeycloakAdminClient(identityConfig.settings))
    : undefined;
  let identityRunning = false,
    nextIdentityAt = 0;
  const identitySecurity =
    identityConfig && config.IDENTITY_SECURITY_ENABLED
      ? (options.identitySecurity ?? new KeycloakSecurityClient(identityConfig.settings))
      : undefined;
  let knowledgeRunning = false;
  let nextKnowledgeAt = 0;
  let nextManifestCleanupAt = 0;
  let lastLoopAt = Date.now();
  let stopping = false;
  const active = new Set<Promise<void>>();
  let preferChat = true;
  let preferCriteria = true;
  const startCriteria = async () => {
    if (!config.CREDENTIAL_REGISTRY_ENABLED) return false;
    const run = await claimCriterionGeneration(database, executor);
    if (!run) return false;
    const task = executeCriterionGeneration(database, config, run).catch(() =>
      health.log.error({ generationId: run.id }, 'criterion generation failed'),
    );
    active.add(task);
    void task.finally(() => active.delete(task));
    preferCriteria = false;
    return true;
  };
  let activeBatch = 0;
  let lastRecoveryAt = 0;
  const shutdown = stopSignal(options.signal).then(() => {
    stopping = true;
  });

  health.get('/health/live', async () => ({ status: 'ok' }));
  health.get('/health/ready', async (_request, reply) =>
    !stopping && Date.now() - lastLoopAt < 15_000
      ? { status: 'ok' }
      : reply.code(503).send({ status: 'degraded' }),
  );
  try {
    await health.listen({ host: config.HOST, port: config.WORKER_HEALTH_PORT });

    while (!stopping) {
      lastLoopAt = Date.now();
      if (identityConfig && identityAdmin && !identityRunning && Date.now() >= nextIdentityAt) {
        identityRunning = true;
        // One sequential pass gives provisioning, reactivation and revocation a
        // turn. Independent timers could repeatedly contend for the realm lease.
        const identityTask = (async () => {
          const phases = [
            () => processIdentityOperation(database, identityConfig.binding, identityAdmin),
            ...(identitySecurity
              ? [
                  () =>
                    processIdentityReactivation(database, identityConfig.binding, identitySecurity),
                  () =>
                    reconcileIdentitySecurity(database, identityConfig.binding, identitySecurity),
                ]
              : []),
          ];
          for (const phase of phases) {
            if (stopping) break;
            try {
              await phase();
            } catch {
              health.log.error(
                { code: 'IDENTITY_RECONCILIATION_UNAVAILABLE' },
                'identity background phase paused',
              );
            }
          }
        })().finally(() => {
          nextIdentityAt = Date.now() + 2000;
          identityRunning = false;
          active.delete(identityTask);
        });
        active.add(identityTask);
      }
      if (Date.now() - lastRecoveryAt > 10000) {
        await recoverExpiredJobs(database);
        lastRecoveryAt = Date.now();
      }
      if (
        config.KNOWLEDGE_PUBLICATION_ENABLED &&
        !knowledgeRunning &&
        Date.now() >= nextKnowledgeAt &&
        active.size - (identityRunning ? 1 : 0) < config.WORKER_CONCURRENCY
      ) {
        knowledgeRunning = true;
        const task = (async () => {
          if (Date.now() >= nextManifestCleanupAt) {
            await reconcileCriterionDeadlines(database);
            await removeExpiredKnowledgeManifests(database);
            nextManifestCleanupAt = Date.now() + 60000;
          }
          await publishNextKnowledge(database, artifacts);
        })()
          .catch(() => {
            health.log.error(
              { code: 'KNOWLEDGE_PUBLICATION_UNAVAILABLE' },
              'knowledge publication paused',
            );
          })
          .finally(() => {
            knowledgeRunning = false;
            nextKnowledgeAt = Date.now() + 2000;
            active.delete(task);
          });
        active.add(task);
      }
      let claimed = false;
      while (!stopping && active.size - (identityRunning ? 1 : 0) < config.WORKER_CONCURRENCY) {
        if (preferCriteria && (await startCriteria())) {
          claimed = true;
          continue;
        }
        const batchAvailable =
          !config.CHAT_AGENT_ENABLED ||
          config.WORKER_CONCURRENCY === 1 ||
          activeBatch < config.WORKER_CONCURRENCY - 1;
        const priorityJob =
          !preferChat && batchAvailable ? await claimJob(database, executor) : null;
        if (config.CHAT_AGENT_ENABLED && !priorityJob) {
          const run = await claimAgentRun(database, executor);
          if (run) {
            preferChat = false;
            preferCriteria = true;
            claimed = true;
            const task = executeAgentRun(database, config, run).catch(() =>
              health.log.error({ runId: run.id }, 'chat run failed'),
            );
            active.add(task);
            void task.finally(() => active.delete(task));
            continue;
          }
        }
        const job = priorityJob ?? (batchAvailable ? await claimJob(database, executor) : null);
        if (!job) {
          if (await startCriteria()) {
            claimed = true;
            continue;
          }
          break;
        }
        preferCriteria = true;
        preferChat = true;
        claimed = true;
        const task = executeJob(
          database,
          github,
          artifacts,
          config,
          executor,
          job,
          health.log,
          () => stopping,
        ).catch((error: unknown) => {
          health.log.error({ err: error, jobId: job.id }, 'worker loop failed');
        });
        active.add(task);
        activeBatch++;
        void task.finally(() => {
          active.delete(task);
          activeBatch--;
        });
      }
      if (!claimed || active.size >= config.WORKER_CONCURRENCY) {
        await Promise.race([shutdown, delay(500), ...active]);
      }
    }
  } finally {
    // A dead loop must not leave a live health server that prevents restart.
    stopping = true;
    await health.close();
    try {
      await Promise.allSettled(active);
    } finally {
      await database.end();
    }
  }
}

export async function claimJob(database: Database, executor: string): Promise<ClaimedJob | null> {
  const connection = await database.connect();
  try {
    await connection.query('begin');
    const result = await connection.query<Omit<ClaimedJob, 'attempt_id'>>(
      `with candidate as (
         select id from jobs
         where type in ('snapshot.materialize', 'analysis.run', 'github.review.publish')
           and state = 'queued' and available_at <= clock_timestamp()
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
  logger: Logger,
  draining: () => boolean,
): Promise<void> {
  const heartbeat = setInterval(
    () =>
      void database
        .query(
          `update jobs set lease_expires_at = clock_timestamp() + interval '30 seconds',
         heartbeat_at = clock_timestamp(), updated_at = clock_timestamp()
         where id = $1 and state = 'running' and lease_owner = $2 and attempt_count=$3
         and lease_expires_at>clock_timestamp()`,
          [job.id, executor, job.attempt_count],
        )
        .catch(() => undefined),
    10_000,
  );
  const workspace = path.join(config.WORKSPACE_ROOT, `job-${job.id}-${job.attempt_count}`);
  try {
    if (job.type === 'snapshot.materialize') {
      await executeSnapshotJob(database, github, artifacts, config, workspace, job);
    } else if (job.type === 'analysis.run') {
      await executeAnalysisJob(database, artifacts, config, job, draining);
    } else {
      await publishReviewToGitHub(database, github, config, job, artifacts);
    }
    await completeJob(database, job);
    logger.info({ jobId: job.id, type: job.type }, 'job completed');
  } catch (error) {
    if (error instanceof Error && error.message === 'worker_draining') {
      await database.query(
        "update jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1 and state='running' and lease_owner=$2 and attempt_count=$3",
        [job.id, executor, job.attempt_count],
      );
      return;
    }
    if (error instanceof Error && error.message === 'job_lease_lost') return;
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

export async function executeSnapshotJob(
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
  await persistMaterialization(database, artifacts, config, job, materialization);
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
  const repository = await getRepository(database, row.repository_id);
  if (!repository) throw new Error('GitHub repository is unavailable');
  if (isFixtureRepository(config.GITHUB_MODE, repository))
    return materializeFixtureSnapshot(row.base_sha, row.head_sha);
  const reader = repository.credentialId
    ? await registeredGitHubReader(
        database,
        config.CREDENTIAL_ENCRYPTION_KEY,
        repository.credentialId,
      )
    : github;
  if (!reader?.getGitCredential) throw new Error('GitHub credential is unavailable');
  return materializeGitSnapshot({
    workspace,
    webBaseUrl: repository.webBaseUrl,
    owner: repository.owner,
    repository: repository.name,
    pullNumber: row.number,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    credential: await reader.getGitCredential(repository),
  });
}

async function persistMaterialization(
  database: Database,
  artifacts: FilesystemArtifactStore,
  config: AppConfig,
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
      trees: materialization.trees ?? null,
      fileCount: materialization.files.length,
    }),
  );

  const connection = await database.connect();
  try {
    await connection.query('begin');
    await assertJobLease(connection, job);
    const version = await connection.query<{ version: number }>(
      `select coalesce(max(version), 0) + 1 as version from snapshots where request_id = $1`,
      [snapshotRequestId],
    );
    await connection.query(
      `insert into snapshots(id, request_id, version, merge_base_sha, resolution, policy_version, manifest_checksum, source_trees)
       values ($1,$2,$3,$4,$5,'snapshot-v1',$6,$7::jsonb)`,
      [
        snapshotId,
        snapshotRequestId,
        version.rows[0]!.version,
        materialization.mergeBaseSha,
        materialization.resolution,
        manifest.checksum,
        materialization.trees ? JSON.stringify(materialization.trees) : null,
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
      await captureSnapshotChangeSource(connection, fileArtifact.id, fileArtifact.file.patch);
    }
    await connection.query(`update snapshot_requests set state = 'materialized' where id = $1`, [
      snapshotRequestId,
    ]);

    let analysisId: string | null = null;
    let memoryOwnerUserId: string | null = null;
    if (materialization.resolution === 'exact') {
      const prompt = await connection.query<{
        id: string | null;
        content_hash: string | null;
        severity_level: ReviewSeverityLevel | null;
        tenant_id: string;
        repository_id: string;
        pull_title: string;
        requested_by: string | null;
        branch: string | null;
      }>(
        `select active_prompt.id, active_prompt.content_hash, active_prompt.severity_level,
                repository.tenant_id, repository.id as repository_id,
                pull_request.title as pull_title, operation.requested_by,
                case when pull_request.head_sha=request.head_sha then pull_request.head_ref else null end as branch
         from snapshot_requests request
         join pull_requests pull_request on pull_request.id = request.pull_request_id
         join repositories repository on repository.id = pull_request.repository_id
         left join operations operation on operation.id = $2
         left join lateral (
           select id, content_hash, severity_level from analysis_prompt_versions
           where tenant_id = repository.tenant_id and active order by version desc limit 1
         ) active_prompt on true
         where request.id = $1`,
        [snapshotRequestId, job.payload.operationId ?? null],
      );
      const promptVersionId = prompt.rows[0]?.id ?? null;
      const promptHash = prompt.rows[0]?.content_hash ?? 'builtin-v1';
      const severityLevel = prompt.rows[0]?.severity_level ?? defaultReviewSeverityLevel;
      const activeProvider = await getActiveAnalysisProviderRow(connection);
      const deploymentProvider = deploymentAnalysisProvider(config);
      const providerVersionId = activeProvider?.id ?? null;
      const providerHash =
        activeProvider?.configurationHash ?? deploymentProvider.configurationHash;
      const shared = await pinSharedKnowledge(connection, artifacts, {
        tenantId: prompt.rows[0]!.tenant_id,
        repositoryId: prompt.rows[0]!.repository_id,
        branch: prompt.rows[0]!.branch,
        enabled: config.KNOWLEDGE_PUBLICATION_ENABLED,
      });
      const skills =
        shared.value.status === 'ready'
          ? {
              versionId: null,
              bundle: validateReviewSkillBundle(
                (shared.value.bundles.policy as { skills: unknown }).skills,
              ),
            }
          : await getEffectiveReviewSkills(connection);
      memoryOwnerUserId = prompt.rows[0]?.requested_by ?? null;
      const memory =
        shared.value.status === 'ready' && !memoryOwnerUserId
          ? { items: [], hash: createHash('sha256').update('[]').digest('hex') }
          : await recallReviewMemories(connection, {
              tenantId: prompt.rows[0]!.tenant_id,
              repositoryId: prompt.rows[0]!.repository_id,
              ...(memoryOwnerUserId ? { ownerUserId: memoryOwnerUserId } : {}),
              filePaths: materialization.files.map(({ path: filePath }) => filePath),
              queryText: prompt.rows[0]!.pull_title,
              approvedBefore: new Date(),
            });
      const modelProfile = activeProvider
        ? activeProvider.mode === 'chatgpt-account'
          ? `chatgpt-account:${activeProvider.modelName}:${activeProvider.reasoningEffort}`
          : activeProvider.mode === 'openai-compatible' && activeProvider.modelName
            ? `openai-compatible:${activeProvider.modelName}`
            : 'disabled'
        : deploymentProvider.profile;
      const analysis = await connection.query<{ id: string }>(
        `insert into analysis_runs(
           snapshot_id, analysis_key, state, stage, progress, model_profile,
           prompt_version_id, prompt_hash, provider_version_id, provider_hash, policy_hash,
           skill_version_id, skill_bundle, skill_hash, severity_level, memory_hash,
           memory_context, memory_owner_user_id, shared_knowledge, shared_knowledge_hash
         ) values ($1, $2, 'queued', 'planning', 0, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
           $11, $12, $13, $14::jsonb, $15, $16::jsonb, $17)
         on conflict (analysis_key) do update set analysis_key = excluded.analysis_key returning id`,
        [
          snapshotId,
          `analysis:${snapshotId}:default:v10:${promptHash}:${severityLevel}:${providerHash}:${skills.bundle.hash}:${memoryOwnerUserId ?? 'collective'}:${memory.hash}:${shared.hash}`,
          modelProfile,
          promptVersionId,
          promptHash,
          providerVersionId,
          providerHash,
          `default-v7:${promptHash}:${severityLevel}:${providerHash}:${skills.bundle.hash}:${memory.hash}:${shared.hash}`,
          skills.versionId,
          JSON.stringify(skills.bundle),
          skills.bundle.hash,
          severityLevel,
          memory.hash,
          JSON.stringify(memory.items),
          memoryOwnerUserId,
          JSON.stringify(shared.value),
          shared.hash,
        ],
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
            ...(memoryOwnerUserId ? { memoryOwnerUserId } : {}),
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
        analysisId: memoryOwnerUserId ? null : analysisId,
      },
    );
    if (analysisId && !memoryOwnerUserId) {
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

export async function executeAnalysisJob(
  database: Database,
  artifacts: FilesystemArtifactStore,
  config: AppConfig,
  job: ClaimedJob,
  draining: () => boolean = () => false,
): Promise<void> {
  await assertJobLease(database, job);
  const analysisId = requiredPayload(job, 'analysisId');
  const snapshotId = requiredPayload(job, 'snapshotId');
  const existing = await database.query('select 1 from reports where analysis_run_id = $1', [
    analysisId,
  ]);
  if (existing.rowCount) return;
  await updateAnalysisState(database, job, 'analyzing', 'deterministic', 20);
  const identity = await database.query<{
    base_sha: string;
    head_sha: string;
    merge_base_sha: string;
    shared_knowledge: unknown;
    shared_knowledge_hash: string | null;
    prompt_instructions: string | null;
    prompt_version: number | null;
    prompt_hash: string;
    severity_level: ReviewSeverityLevel | null;
    provider_version_id: string | null;
    skill_version_id: string | null;
    skill_version: number | null;
    skill_bundle: unknown;
    skill_hash: string | null;
    tenantId: string;
    repositoryId: string;
    credentialId: string | null;
    installationId: string;
    memory_context: import('../services/review-memory.js').ReviewMemoryProjection[];
  }>(
    `select sr.base_sha, sr.head_sha, snapshot.merge_base_sha, analysis.shared_knowledge, analysis.shared_knowledge_hash, prompt.instructions as prompt_instructions,
            prompt.version as prompt_version, analysis.prompt_hash, analysis.severity_level,
            analysis.provider_version_id, repository.tenant_id as "tenantId", repository.id as "repositoryId",
            analysis.skill_version_id, analysis.skill_bundle, analysis.skill_hash,
            skills.version as skill_version,
            repository.credential_id as "credentialId",
            repository.installation_id as "installationId", analysis.memory_context
     from snapshots snapshot
     join snapshot_requests sr on sr.id = snapshot.request_id
     join pull_requests pr on pr.id = sr.pull_request_id
     join repositories repository on repository.id = pr.repository_id
     join analysis_runs analysis on analysis.snapshot_id = snapshot.id and analysis.id = $2
     left join analysis_prompt_versions prompt on prompt.id = analysis.prompt_version_id
     left join analysis_skill_versions skills on skills.id = analysis.skill_version_id
     where snapshot.id = $1`,
    [snapshotId, analysisId],
  );
  const row = identity.rows[0];
  if (!row) throw new Error('Analysis snapshot is unavailable');
  const skillBundle = resolvePinnedReviewSkills(row.skill_bundle, row.skill_hash);
  const provider = await resolveAnalysisProvider(database, config, row.provider_version_id);
  const baseModel = createReviewModel(provider, { database, config, tenantId: row.tenantId });
  const sourceContext =
    config.CHAT_AGENT_ENABLED && baseModel && !isFixtureRepository(config.GITHUB_MODE, row)
      ? withAnalysisSourceContext(baseModel, database, artifacts, config, analysisId, snapshotId)
      : null;
  const contextualModel = sourceContext?.model ?? baseModel;
  let model = contextualModel
    ? checkpointReviewModel(
        contextualModel,
        database,
        analysisId,
        job,
        sourceContext?.limitations,
        draining,
      )
    : undefined;
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
  const sharedPin = readSharedKnowledgePin(row.shared_knowledge, row.shared_knowledge_hash);
  if (
    sharedPin &&
    (sharedPin.repositoryId !== row.repositoryId || sharedPin.tenantId !== row.tenantId)
  )
    throw Error('shared_knowledge_scope');
  const contextLimitations: string[] = [];
  let sharedValidUntil: string | null = null;
  let sharedSelectionHash: string | null = null;
  let sharedCriteria: ReturnType<typeof sharedCriterionContext> | undefined;
  if (sharedPin && sharedPin.status !== 'disabled') {
    try {
      const selection = await prepareSharedAnalysisKnowledge(
        database,
        config,
        analysisId,
        snapshotId,
        sharedPin,
        files,
        { head: row.head_sha, mergeBase: row.merge_base_sha },
      );
      sharedValidUntil = selection.validUntil;
      sharedSelectionHash = (
        await database.query<{ context_hash: string }>(
          'select context_hash from analysis_shared_selections where analysis_id=$1',
          [analysisId],
        )
      ).rows[0]!.context_hash;
      sharedCriteria = sharedCriterionContext(
        selection,
        row.shared_knowledge_hash!,
        sharedSelectionHash,
      );
      if (model) model = withSharedKnowledge(model, selection);
    } catch {
      model = undefined;
      contextLimitations.push(
        '고정된 공용 리뷰 기준이나 동일 Git SHA의 전체 원문을 확인하지 못했습니다. 공용 기준 리뷰는 미완료입니다. 새 분석을 요청해 발행·출처·예외 시각을 다시 확인하세요.',
      );
    }
  }
  await updateAnalysisState(database, job, 'analyzing', 'review', 25);
  try {
    const output = await withModelBudget(
      {
        runKey: `analysis:${analysisId}`,
        maxCalls: config.ANALYSIS_MAX_MODEL_CALLS,
        wait: true,
        concurrency: provider.concurrency ?? 1,
      },
      () =>
        analyzeSnapshot({
          concurrency: provider.concurrency ?? 1,
          onProgress: async (stage, detail) => {
            if (draining()) throw Error('worker_draining');
            await assertJobLease(database, job);
            const progress =
              stage === 'total-summary'
                ? 85
                : 25 + Math.floor((60 * detail.filesProcessed) / Math.max(1, detail.filesTotal));
            await updateAnalysisState(database, job, 'analyzing', stage, progress, detail);
          },
          analysisId,
          snapshotId,
          baseSha: row.base_sha,
          headSha: row.head_sha,
          patch: diff.patch,
          files,
          memory: row.memory_context,
          contextLimitations,
          ...(sharedCriteria ? { sharedCriteria } : {}),
          fixtureMode: isFixtureRepository(config.GITHUB_MODE, row),
          ...(row.severity_level ? { severityLevel: row.severity_level } : {}),
          ...(model ? { model } : {}),
          ...(skillBundle
            ? {
                skills: {
                  bundle: skillBundle,
                  versionId: row.skill_version_id,
                  version: row.skill_version,
                },
              }
            : {}),
          ...(row.prompt_instructions !== null && row.prompt_version
            ? {
                prompt: {
                  instructions: row.prompt_instructions,
                  version: row.prompt_version,
                  hash: row.prompt_hash,
                },
              }
            : {}),
          budgets: {
            maxFiles: config.ANALYSIS_MAX_FILES,
            maxBytes: config.ANALYSIS_MAX_BYTES,
            maxModelCalls: config.ANALYSIS_MAX_MODEL_CALLS,
          },
        }),
    );
    if (sharedPin) {
      output.report.versions.sharedKnowledge = row.shared_knowledge_hash!;
      output.report.versions.sharedKnowledgeStatus = sharedSelectionHash
        ? 'selected'
        : sharedPin.status === 'ready'
          ? 'unavailable'
          : sharedPin.status;
      if (sharedSelectionHash) output.report.versions.sharedSelection = sharedSelectionHash;
    }
    if (sharedValidUntil && sharedValidUntil <= new Date().toISOString()) {
      output.state = 'partial';
      output.report.coverage.truncated = true;
      output.report.coverage.limitations.push(
        '검토 중 공용 기준의 예외·만료 시각에 도달했습니다. 새 분석이 필요합니다.',
      );
      output.graph.coverage.truncated = true;
      if (output.report.analysis && output.report.analysis.status === 'pass')
        output.report.analysis.status = 'incomplete';
    }
    await updateAnalysisState(database, job, 'analyzing', 'persisting', 90);
    if (sourceContext) output.report.coverage.limitations.push(...sourceContext.limitations);
    const recurrence = await loadReviewRecurrence(database, artifacts, output.report);
    if (recurrence) output.report.recurrence = recurrence;
    await persistAnalysis(
      database,
      artifacts,
      config,
      job,
      output.report,
      output.graph,
      output.state,
    );
  } finally {
    await sourceContext?.release();
  }
}

export async function persistAnalysis(
  database: Database,
  artifacts: FilesystemArtifactStore,
  config: AppConfig,
  job: ClaimedJob,
  report: ReviewReport,
  graph: RelationshipGraph,
  state: 'completed' | 'partial',
) {
  const analysisId = requiredPayload(job, 'analysisId');
  const reportContent = JSON.stringify(report);
  const graphContent = JSON.stringify(graph);
  const reportArtifact = await artifacts.commitText(
    `analyses/${analysisId}/report.${createHash('sha256').update(reportContent).digest('hex')}.v1.json`,
    reportContent,
  );
  const graphArtifact = await artifacts.commitText(
    `analyses/${analysisId}/relationships.${createHash('sha256').update(graphContent).digest('hex')}.v1.json`,
    graphContent,
  );
  const reportId = randomUUID();
  const connection = await database.connect();
  try {
    await connection.query('begin');
    await assertJobLease(connection, job);
    const locked = await connection.query<{ revision: number }>(
      'select revision from analysis_runs where id = $1 for update',
      [analysisId],
    );
    const existing = await connection.query('select 1 from reports where analysis_run_id = $1', [
      analysisId,
    ]);
    if (existing.rowCount) {
      await connection.query('commit');
      return;
    }
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
         has_critical_findings, coverage, impact, artifact_id, observation)
       values ($1,$2,1,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb)`,
      [
        reportId,
        analysisId,
        report.grade,
        report.summary,
        report.hasCriticalFindings,
        JSON.stringify(report.coverage),
        JSON.stringify(report.impact),
        reportArtifactId,
        JSON.stringify(observeReport(report)),
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
    await createFindingReviewMemoryCandidates(connection, analysisId);
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
      revision: locked.rows[0]!.revision,
      state,
      stage: 'published',
      progress: 100,
      reportUrl: `/api/v1/analyses/${analysisId}`,
    };
    if (!job.payload.memoryOwnerUserId) {
      await appendEvent(
        connection,
        'pull_request',
        job.payload.pullRequestId,
        'analysis.available',
        eventPayload,
      );
    }
    await appendEvent(connection, 'analysis', analysisId, 'analysis.available', eventPayload);
    if (!job.payload.memoryOwnerUserId && job.payload.skipPublication !== true) {
      await enqueueReviewPublication(
        connection,
        analysisId,
        requiredPayload(job, 'pullRequestId'),
        config.GITHUB_MODE === 'app',
      );
    }
    await connection.query('commit');
  } catch (error) {
    await connection.query('rollback');
    throw error;
  } finally {
    connection.release();
  }
}

async function updateAnalysisState(
  pool: Database,
  job: ClaimedJob,
  state: 'analyzing',
  stage: string,
  progress: number,
  detail?: import('@gcr/contracts').AnalysisProgress,
) {
  const database = await pool.connect();
  try {
    await database.query('begin');
    await assertJobLease(database, job);
    const analysisId = requiredPayload(job, 'analysisId');
    const updated = await database.query(
      `update analysis_runs set state = $2, stage = $3, progress = $4,
     progress_detail = case when $3 = 'deterministic' then null else coalesce($5::jsonb, progress_detail) end,
     started_at = coalesce(started_at, clock_timestamp()) where id = $1
     and state not in ('completed', 'partial')
     and not exists (select 1 from reports where analysis_run_id = $1) returning revision`,
      [analysisId, state, stage, progress, detail ? JSON.stringify(detail) : null],
    );
    if (!updated.rowCount) {
      await database.query('commit');
      return;
    }
    const payload = {
      analysisId,
      revision: updated.rows[0]!.revision,
      state,
      stage,
      progress,
      progressDetail: detail,
    };
    if (!job.payload.memoryOwnerUserId) {
      await appendEvent(
        database,
        'pull_request',
        job.payload.pullRequestId,
        'analysis.state',
        payload,
      );
    }
    await appendEvent(database, 'analysis', analysisId, 'analysis.state', payload);
    await database.query('commit');
  } catch (error) {
    await database.query('rollback');
    throw error;
  } finally {
    database.release();
  }
}

async function completeJob(database: Database, job: ClaimedJob) {
  const client = await database.connect();
  try {
    await client.query('begin');
    await assertJobLease(client, job);
    await client.query(
      `update job_attempts set ended_at = clock_timestamp(), outcome = 'completed' where id = $1`,
      [job.attempt_id],
    );
    await client.query(
      `update jobs set state = 'completed', lease_owner = null, lease_expires_at = null,
     updated_at = clock_timestamp() where id = $1`,
      [job.id],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function failJob(database: Database, job: ClaimedJob, error: unknown) {
  if (job.type === 'analysis.run') {
    const published = await database.query('select 1 from reports where analysis_run_id = $1', [
      job.payload.analysisId,
    ]);
    if (published.rowCount) {
      await completeJob(database, job);
      return;
    }
  }
  const client = await database.connect();
  try {
    await client.query('begin');
    await assertJobLease(client, job);
    await recordJobFailure(client, job, error);
    await client.query('commit');
  } catch (failure) {
    await client.query('rollback');
    throw failure;
  } finally {
    client.release();
  }
}

async function recordJobFailure(database: DatabaseClient, job: ClaimedJob, error: unknown) {
  const retryable =
    error instanceof GitHubRequestError
      ? error.retryable
      : error instanceof ReviewPublicationError
        ? error.retryable
        : true;
  const terminal = job.attempt_count >= job.max_attempts || !retryable;
  const code =
    job.type === 'snapshot.materialize'
      ? 'SNAPSHOT_FAILED'
      : job.type === 'analysis.run'
        ? 'ANALYSIS_FAILED'
        : error instanceof GitHubRequestError && error.status === 403
          ? 'GITHUB_REVIEW_PERMISSION_DENIED'
          : 'GITHUB_REVIEW_PUBLISH_FAILED';
  const retryAfterSeconds =
    error instanceof GitHubRequestError && error.retryAfterSeconds
      ? error.retryAfterSeconds
      : Math.min(300, 15 * 2 ** Math.max(0, job.attempt_count - 1));
  await database.query(
    `update job_attempts set ended_at = clock_timestamp(), outcome = $2, error_code = $3 where id = $1`,
    [job.attempt_id, terminal ? 'failed' : 'retry', code],
  );
  await database.query(
    `update jobs set state = $2, available_at = clock_timestamp() + ($4 * interval '1 second'),
     lease_owner = null, lease_expires_at = null, last_error = $3::jsonb,
     updated_at = clock_timestamp() where id = $1`,
    [
      job.id,
      terminal ? 'failed' : 'queued',
      JSON.stringify({ code, retryable: !terminal, message: errorMessage(error) }),
      retryAfterSeconds,
    ],
  );
  if (job.type === 'github.review.publish') {
    const analysisId = job.payload.analysisId ?? null;
    const pullRequestId = job.payload.pullRequestId ?? null;
    if (pullRequestId) {
      await database.query(
        `update github_review_publications publication set
           state = case when exists (
             select 1 from pull_requests pull_request
             join repositories repository on repository.id = pull_request.repository_id
             join github_instances instance on instance.id = repository.instance_id
             where pull_request.id = publication.pull_request_id and repository.enabled
               and repository.review_publishing_enabled and instance.enabled
           ) then $2 else 'disabled' end,
           last_error_code = $3,
           last_error_message = $4, updated_at = clock_timestamp()
         where pull_request_id = $1
           and ($5::uuid is null or target_analysis_run_id = $5::uuid)`,
        [pullRequestId, terminal ? 'failed' : 'pending', code, errorMessage(error), analysisId],
      );
      await appendEvent(database, 'pull_request', pullRequestId, 'github.review.failed', {
        analysisId,
        code,
        retryable: !terminal,
      });
    }
    return;
  }
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

function requiredPayload(
  job: ClaimedJob,
  key: Exclude<keyof JobPayload, 'skipPublication'>,
): string {
  const value = job.payload[key];
  if (!value) throw new Error(`Job payload is missing ${key}`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'Unknown job failure';
}

let signalPromise: Promise<void> | undefined;
function stopSignal(signal?: AbortSignal): Promise<void> {
  if (signal)
    return new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  signalPromise ??= new Promise((resolve) => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
  return signalPromise;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
