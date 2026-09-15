import { canonicalKnowledgeJson } from '@gcr/client-contract';
import { observeReport } from '../services/report-observation.js';
import { chromium } from 'playwright';
import { createServer } from '../../../web/src/review-criteria-test-server.js';
import * as sourceWorkspace from '../services/source-workspace.js';
import { claimKnowledgePublication, publishKnowledge } from '../services/knowledge-publication.js';
import {
  createCriterion,
  lockCriterion,
  evaluateCriterion,
  actOnCriterion,
} from '../services/review-criteria.js';
import {
  criterionCreateSchema,
  criterionEvaluationCreateSchema,
  analysisSharedKnowledgeSchema,
} from '@gcr/contracts';
import { randomUUID, createHash } from 'node:crypto';
import { listSnapshotChangeSources } from '../services/criterion-code-sources.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createReviewSkillBundle, loadBuiltInReviewSkills } from '@gcr/analysis-engine';
import { FilesystemArtifactStore } from '@gcr/artifact-store';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { FixtureGitHubClient } from '@gcr/github';
import type { GitHubReader, GitHubReviewPublisher } from '@gcr/github';
import { reportViewSchema, analysisStatusSchema } from '@gcr/contracts';
import Fastify from 'fastify';
import type { AuthUser } from '../auth/index.js';
import { EventHub } from '../events/index.js';
import { registerAnalysisRoutes } from '../routes/analyses.js';
import { AuthorizationService } from '../services/authorization.js';
import { publishReviewToGitHub } from '../services/review-publication.js';
import type { ReviewReport } from '@gcr/review-contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig, type AppConfig } from '../config.js';
import { ensureFixtureRepository, pollRepository } from '../services/repositories.js';
import { executeAnalysisJob, executeSnapshotJob, persistAnalysis } from './worker.js';
import { queueIncompleteAnalysisReanalysis } from '../services/analysis-reanalysis.js';

const databaseUrl = process.env.GCR_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl).sequential('Worker pinned Skill snapshot and staged review', () => {
  const schema = `gcr_worker_skills_${randomUUID().replaceAll('-', '')}`;
  let root: Database, database: Database, artifacts: FilesystemArtifactStore, config: AppConfig;
  let directory: string, analysisId: string, snapshotId: string, versionId: string, userId: string;
  let promptId: string, tenantId: string;
  const builtin = loadBuiltInReviewSkills();
  const original = createReviewSkillBundle([
    ...builtin.skills.map((skill) => skill.markdown),
    builtin.skills[0]!.markdown.replace('name: correctness', 'name: api-compatibility') +
      '\nOriginal Skill marker\n',
  ]);
  const updated = createReviewSkillBundle(
    original.skills.map((skill) =>
      skill.markdown.replace('Original Skill marker', 'Updated Skill marker'),
    ),
  );
  const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  let analysisJob: Parameters<typeof executeAnalysisJob>[3];

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw Error('Use an isolated local test PostgreSQL');
    directory = await mkdtemp(path.join(tmpdir(), 'gcr-worker-skills-'));
    root = createDatabase(url.toString());
    await root.query(`create schema ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    database = createDatabase(url.toString());
    await runMigrations(database, path.resolve('packages/db/migrations'));
    config = loadConfig({
      DATABASE_URL: url.toString(),
      AUTH_MODE: 'development',
      GITHUB_MODE: 'fixture',
      MODEL_MODE: 'openai-compatible',
      MODEL_ENDPOINT: 'https://models.example.test/v1/',
      MODEL_API_KEY: 'synthetic-only',
      MODEL_NAME: 'synthetic-review',
      ARTIFACT_ROOT: path.join(directory, 'artifacts'),
      WORKSPACE_ROOT: path.join(directory, 'workspaces'),
    });
    artifacts = new FilesystemArtifactStore(config.ARTIFACT_ROOT);
    userId = (
      await database.query(
        "insert into users(oidc_subject, display_name, role) values ('synthetic:worker', '검증 관리자', 'administrator') returning id",
      )
    ).rows[0].id;
    versionId = (
      await database.query(
        'insert into analysis_skill_versions(version, bundle, content_hash, active, created_by, activated_by, activated_at) values (1,$1::jsonb,$2,true,$3,$3,clock_timestamp()) returning id',
        [JSON.stringify(original), original.hash, userId],
      )
    ).rows[0].id;
    await ensureFixtureRepository(database);
    tenantId = (await database.query('select tenant_id from repositories limit 1')).rows[0]
      .tenant_id;
    promptId = (
      await database.query(
        `insert into analysis_prompt_versions(tenant_id,version,instructions,severity_level,content_hash,active,created_by,activated_by,activated_at)
       values ($1,1,'','rigorous',$2,true,$3,$3,clock_timestamp()) returning id`,
        [tenantId, 'a'.repeat(64), userId],
      )
    ).rows[0].id;
    const repositoryId = (await database.query('select id from repositories limit 1')).rows[0].id;
    await pollRepository(database, new FixtureGitHubClient(), repositoryId);
    const job = (
      await database.query("select * from jobs where type = 'snapshot.materialize' limit 1")
    ).rows[0];
    const attempt = (
      await database.query(
        "insert into job_attempts(job_id, attempt_number, executor) values ($1,1,'synthetic') returning id",
        [job.id],
      )
    ).rows[0];
    await database.query(
      "update jobs set state='running',attempt_count=1,lease_owner='synthetic',lease_expires_at=clock_timestamp()+interval '1 hour' where id=$1",
      [job.id],
    );
    await executeSnapshotJob(database, null, artifacts, config, path.join(directory, 'workspace'), {
      ...job,
      attempt_count: 1,
      attempt_id: attempt.id,
    });
    const run = (await database.query('select * from analysis_runs limit 1')).rows[0];
    analysisId = run.id;
    snapshotId = run.snapshot_id;
    const queued = (
      await database.query(
        "select * from jobs where type = 'analysis.run' and payload->>'analysisId' = $1",
        [analysisId],
      )
    ).rows[0];
    const analysisAttempt = (
      await database.query(
        "insert into job_attempts(job_id, attempt_number, executor) values ($1,1,'synthetic') returning id",
        [queued.id],
      )
    ).rows[0];
    analysisJob = { ...queued, attempt_count: 1, attempt_id: analysisAttempt.id };
    await database.query(
      "update jobs set state='running',attempt_count=1,lease_owner='synthetic',lease_expires_at=clock_timestamp()+interval '1 hour' where id=$1",
      [queued.id],
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push(body);
        const instructions = body.messages[0].content as string;
        const data = body.messages[1].content as string;
        const unitStage = instructions.includes('Current analysis stage: unit-comment-block');
        const file = /File: ([^\n]+)/.exec(data)?.[1];
        const side = /side=(head|mergeBase)/.exec(data)?.[1];
        const line = Number(/must be in (\d+)/.exec(data)?.[1]);
        const sharedLine = instructions.split('\n').find((line) => line.startsWith('{"items":'));
        const sharedItems = sharedLine
          ? (JSON.parse(sharedLine).items as Array<{
              component: string;
              kind: string;
              id: string;
              revision: number;
              hash: string;
              targets: Array<{ path: string; side: string }>;
            }>)
          : [];
        const rule = sharedItems.find(
          (item) =>
            item.component === 'policy' &&
            item.kind === 'policy' &&
            item.targets.some(
              (target) =>
                target.path === file && target.side === (side === 'head' ? 'source' : 'base'),
            ),
        );
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: '검증용 응답: code segment의 호환성을 확인했습니다.',
                  grade: 'adequate',
                  file_comments: unitStage
                    ? [
                        {
                          file,
                          side,
                          line,
                          end_line: line,
                          category:
                            /Allowed perspective names: ([^.]+)/
                              .exec(instructions)?.[1]
                              ?.split(',')[0]
                              ?.trim() ?? 'api-compatibility',
                          priority: 'P2',
                          comment: '검증용 unit입니다. 실제 취약점 판정이 아닙니다.',
                          ...(rule
                            ? {
                                criterion_assessments: [
                                  {
                                    id: rule.id,
                                    revision: rule.revision,
                                    hash: rule.hash,
                                    outcome: 'uncertain',
                                    rationale: '합성 코드에서 추가 확인이 필요한 조건입니다.',
                                    counterEvidence: {
                                      status: 'not-reviewed',
                                      explanation: '실제 caller 실행은 관측하지 않았습니다.',
                                    },
                                  },
                                ],
                              }
                            : {}),
                        },
                      ]
                    : [],
                }),
              },
            },
          ],
        });
      }),
    );
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await database?.end();
    if (root) {
      await root.query(`drop schema if exists ${schema} cascade`);
      await root.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('captures criterion code sources from the materialized snapshot and its exact patch artifacts', async () => {
    const repository = (
      await database.query(
        'select p.repository_id from snapshots s join snapshot_requests r on r.id=s.request_id join pull_requests p on p.id=r.pull_request_id where s.id=$1',
        [snapshotId],
      )
    ).rows[0].repository_id;
    const sources = await listSnapshotChangeSources(database, repository);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source.codeChange!.snapshotId).toBe(snapshotId);
      const artifact = (
        await database.query(
          'select a.locator from snapshot_files f join artifacts a on a.id=f.patch_artifact_id where f.id=$1',
          [source.id],
        )
      ).rows[0];
      expect(source.content).toBe(await artifacts.readText(artifact.locator));
      expect(source.codeChange!.validation).toBe('not-observed');
    }
  });
  it('stores the exact administrator bundle/hash when materialization creates the queued analysis', async () => {
    const run = (await database.query('select * from analysis_runs where id = $1', [analysisId]))
      .rows[0];
    expect(run).toMatchObject({
      state: 'queued',
      skill_version_id: versionId,
      skill_hash: original.hash,
      skill_bundle: { hash: original.hash },
      prompt_version_id: promptId,
      severity_level: 'rigorous',
    });
    expect(run.analysis_key).toContain(original.hash);
    expect(run.analysis_key).toContain(':rigorous:');
    await expect(
      database.query("update analysis_runs set severity_level='lean' where id=$1", [analysisId]),
    ).rejects.toThrow('immutable');
    await expect(
      database.query('update analysis_runs set skill_bundle=$2::jsonb, skill_hash=$3 where id=$1', [
        analysisId,
        JSON.stringify(updated),
        updated.hash,
      ]),
    ).rejects.toThrow('immutable');
  });

  it('serves queued analysis metadata before a report exists', async () => {
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.user = {
        id: userId,
        subject: 'synthetic:worker',
        displayName: 'Admin',
        role: 'administrator',
        enabled: true,
        tenantIds: [],
        tenants: [],
        groups: [],
      };
    });
    await registerAnalysisRoutes(
      app,
      database,
      new EventHub(database),
      artifacts,
      config,
      new AuthorizationService(config),
    );
    try {
      const response = await app.inject(`/api/v1/analyses/${analysisId}/status`);
      expect(response.statusCode).toBe(200);
      expect(analysisStatusSchema.parse(response.json()).analysis).toMatchObject({
        id: analysisId,
        snapshotId,
        state: 'queued',
      });
      expect((await app.inject(`/api/v1/analyses/${analysisId}`)).statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('retains immutable orphan artifacts after a database rollback without blocking the next attempt', async () => {
    await database.query(`create function reject_analysis_object() returns trigger language plpgsql as $$
      begin raise exception 'synthetic database write failure'; end; $$`);
    await database.query(
      'create trigger reject_analysis_object before insert on code_objects for each row execute function reject_analysis_object()',
    );
    try {
      await expect(
        executeAnalysisJob(
          database,
          artifacts,
          { ...config, GITHUB_MODE: 'disabled' },
          analysisJob,
        ),
      ).rejects.toThrow('synthetic database write failure');
      expect(
        (await database.query('select 1 from reports where analysis_run_id=$1', [analysisId]))
          .rowCount,
      ).toBe(0);
      const orphans = (await artifacts.list()).filter((entry) =>
        entry.locator.startsWith(`analyses/${analysisId}/`),
      );
      expect(orphans).toHaveLength(2);
      await artifacts.commitText(
        `analyses/${analysisId}/report.v1.json`,
        'legacy interrupted attempt',
      );
    } finally {
      await database.query('drop trigger reject_analysis_object on code_objects');
      await database.query('drop function reject_analysis_object()');
    }
  });

  it('uses the queued version after administrators activate another version, and persists custom categories', async () => {
    const transmittedBeforeRecovery = calls.length;
    await database.query('update analysis_prompt_versions set active=false where active');
    await database.query(
      `insert into analysis_prompt_versions(tenant_id,version,instructions,severity_level,content_hash,active,created_by,activated_by,activated_at)
       values ($1,2,'New tenant guidance','lean',$2,true,$3,$3,clock_timestamp())`,
      [tenantId, 'b'.repeat(64), userId],
    );
    await database.query('update analysis_skill_versions set active=false where active');
    await database.query(
      'insert into analysis_skill_versions(version,bundle,content_hash,active,created_by,activated_by,activated_at) values (2,$1::jsonb,$2,true,$3,$3,clock_timestamp())',
      [JSON.stringify(updated), updated.hash, userId],
    );
    await executeAnalysisJob(
      database,
      artifacts,
      { ...config, GITHUB_MODE: 'disabled' },
      analysisJob,
    );
    const instructions = calls.map((call) => call.messages[0]!.content);
    expect(calls.length).toBe(transmittedBeforeRecovery);
    expect(
      (
        await database.query(
          'select count(*)::int as count from analysis_model_checkpoints where analysis_id=$1',
          [analysisId],
        )
      ).rows[0].count,
    ).toBeGreaterThan(0);
    expect(instructions.every((value) => value.includes('Severity Level): rigorous'))).toBe(true);
    expect(instructions.some((value) => value.includes('New tenant guidance'))).toBe(false);
    expect(instructions.some((value) => value.includes('Original Skill marker'))).toBe(true);
    expect(instructions.some((value) => value.includes('Updated Skill marker'))).toBe(false);
    for (const stage of ['unit-comment-block', 'overall-summary', 'total-summary'])
      expect(instructions.some((value) => value.includes(`Current analysis stage: ${stage}`))).toBe(
        true,
      );
    const stored = (
      await database.query(
        'select report.id, artifact.locator from reports report join artifacts artifact on artifact.id=report.artifact_id where report.analysis_run_id=$1',
        [analysisId],
      )
    ).rows[0];
    const report = await artifacts.readJson<ReviewReport>(stored.locator);
    expect(
      (
        await database.query('select observation from reports where analysis_run_id=$1', [
          report.analysisRevisionId,
        ])
      ).rows[0].observation,
    ).toEqual(observeReport(report));
    expect(report.versions.severity).toBe('rigorous');
    expect(report.versions.prompt).toBe(`tenant-v1:${'a'.repeat(12)}`); // 빈 지침도 version 고정
    expect(report.analysis?.skills).toMatchObject({
      bundleHash: original.hash,
      versionId,
      version: 1,
    });
    expect(report.analysis?.units.length).toBeGreaterThan(0);
    expect(report.analysis?.units.every((unit) => unit.skill.name === 'api-compatibility')).toBe(
      true,
    );
    const persisted = await database.query('select category from findings where report_id=$1', [
      stored.id,
    ]);
    expect(persisted.rows.every((row) => row.category === 'api-compatibility')).toBe(true);
    expect(
      (await database.query('select state from analysis_runs where id=$1', [analysisId])).rows[0]
        .state,
    ).toBe('completed');
    const progress = (
      await database.query('select progress, progress_detail from analysis_runs where id=$1', [
        analysisId,
      ])
    ).rows[0];
    expect(progress.progress).toBe(100);
    expect(progress.progress_detail.filesProcessed).toBe(progress.progress_detail.filesTotal);
    expect(progress.progress_detail.filesReviewed).toBeGreaterThan(0);
    const before = calls.length;
    await executeAnalysisJob(
      database,
      artifacts,
      { ...config, GITHUB_MODE: 'disabled' },
      analysisJob,
    );
    expect(calls.length).toBe(before); // Published report is immutable/idempotent.
    expect(await artifacts.readText(`analyses/${analysisId}/report.v1.json`)).toBe(
      'legacy interrupted attempt',
    );
  });

  it('serializes concurrent publication and retains the winning immutable report', async () => {
    const stored = (
      await database.query(
        "select locator, artifact_type from artifacts where scope_id=$1 and scope_type='analysis'",
        [analysisId],
      )
    ).rows;
    const originalReport = await artifacts.readJson<ReviewReport>(
      stored.find((row) => row.artifact_type === 'report').locator,
    );
    const graph = await artifacts.readJson<import('@gcr/review-contract').RelationshipGraph>(
      stored.find((row) => row.artifact_type === 'relationships').locator,
    );
    const nextId = (
      await database.query(
        "insert into analysis_runs(snapshot_id, analysis_key, state) values ($1,$2,'analyzing') returning id",
        [snapshotId, randomUUID()],
      )
    ).rows[0].id;
    const report = {
      ...originalReport,
      analysisRevisionId: nextId,
      findings: [],
      analysis: undefined,
    };
    const nextGraph = { ...graph, analysisRevisionId: nextId, objects: [], relations: [] };
    const job = { ...analysisJob, payload: { ...analysisJob.payload, analysisId: nextId } };
    await Promise.all([
      persistAnalysis(database, artifacts, config, job, report, nextGraph, 'completed'),
      persistAnalysis(
        database,
        artifacts,
        config,
        job,
        { ...report, summary: 'Another valid result' },
        nextGraph,
        'completed',
      ),
    ]);
    const rows = (
      await database.query(
        'select reports.summary, artifacts.locator from reports join artifacts on artifacts.id=reports.artifact_id where analysis_run_id=$1',
        [nextId],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    const winner = await artifacts.readJson<ReviewReport>(rows[0].locator);
    expect(winner.summary).toBe(rows[0].summary);
    expect(
      (await database.query('select 1 from artifacts where scope_id=$1', [nextId])).rowCount,
    ).toBe(2);
  });

  it('creates one new revision with pinned inputs and never auto-publishes a verification run', async () => {
    await expect(
      queueIncompleteAnalysisReanalysis(database, analysisId, randomUUID()),
    ).rejects.toThrow('reanalysis_requires_incomplete_shared_analysis');
    const originalReports = (
      await database.query('select * from reports where analysis_run_id=$1', [analysisId])
    ).rows;
    await database.query("update analysis_runs set state='partial' where id=$1", [analysisId]);
    const requestId = randomUUID();
    try {
      const [first, second] = await Promise.all([
        queueIncompleteAnalysisReanalysis(database, analysisId, requestId),
        queueIncompleteAnalysisReanalysis(database, analysisId, requestId),
      ]);
      expect(first).toEqual(second);
      expect(first.revision).toBe(2);
      const pins = `snapshot_id, profile, model_profile, prompt_version_id, prompt_hash,
        provider_version_id, provider_hash, policy_hash, skill_version_id, skill_bundle,
        skill_hash, severity_level, memory_hash, memory_context, memory_owner_user_id, shared_knowledge, shared_knowledge_hash`;
      expect(
        (await database.query(`select ${pins} from analysis_runs where id=$1`, [first.analysisId]))
          .rows,
      ).toEqual(
        (await database.query(`select ${pins} from analysis_runs where id=$1`, [analysisId])).rows,
      );
      const queued = (
        await database.query("select * from jobs where payload->>'analysisId'=$1", [
          first.analysisId,
        ])
      ).rows[0];
      expect(queued.payload.skipPublication).toBe(true);
      const attempt = (
        await database.query(
          "insert into job_attempts(job_id,attempt_number,executor) values($1,1,'synthetic-reanalysis') returning id",
          [queued.id],
        )
      ).rows[0];
      await database.query(
        "update jobs set state='running',attempt_count=1,lease_owner='synthetic-reanalysis',lease_expires_at=clock_timestamp()+interval '1 hour' where id=$1",
        [queued.id],
      );
      await database.query('update repositories set review_publishing_enabled=true');
      await executeAnalysisJob(
        database,
        artifacts,
        { ...config, GITHUB_MODE: 'disabled', KNOWLEDGE_PUBLICATION_ENABLED: true },
        {
          ...queued,
          attempt_count: 1,
          attempt_id: attempt.id,
        },
      );
      expect(
        (
          await database.query('select count(*)::int as n from reports where analysis_run_id=$1', [
            first.analysisId,
          ])
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await database.query(
            "select 1 from jobs where type='github.review.publish' and payload->>'analysisId'=$1",
            [first.analysisId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await database.query(
            "select payload->>'revision' as revision from event_log where scope='analysis' and scope_id=$1 and type in ('analysis.state','analysis.available')",
            [first.analysisId],
          )
        ).rows.every((row) => row.revision === '2'),
      ).toBe(true);
      expect(await queueIncompleteAnalysisReanalysis(database, analysisId, requestId)).toEqual(
        first,
      );
      expect(
        (await database.query('select * from reports where analysis_run_id=$1', [analysisId])).rows,
      ).toEqual(originalReports);
    } finally {
      await database.query("update analysis_runs set state='completed' where id=$1", [analysisId]);
    }
  });

  it('serves the pinned report in API/JSON/Markdown and publishes the artifact hierarchy', async () => {
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.user = {
        id: userId,
        subject: 'synthetic:worker',
        displayName: '검증 관리자',
        role: 'administrator',
        enabled: true,
        tenantIds: [],
        tenants: [],
        groups: [],
      } as AuthUser;
    });
    await registerAnalysisRoutes(
      app,
      database,
      new EventHub(database),
      artifacts,
      config,
      new AuthorizationService(config),
    );
    try {
      const response = await app.inject(`/api/v1/analyses/${analysisId}`);
      expect(response.statusCode, response.body).toBe(200);
      const view = reportViewSchema.parse(response.json());
      expect(view.analysis?.skills.versionId).toBe(versionId);
      const mergeBase = (
        await database.query('select merge_base_sha from snapshots where id=$1', [snapshotId])
      ).rows[0].merge_base_sha;
      for (const finding of view.findings.filter((item) => item.anchor.side === 'mergeBase')) {
        expect(finding.links.find((item) => item.rel === 'ghes')?.href).toContain(
          `/blob/${mergeBase}/`,
        );
      }
      const json = await app.inject(`/api/v1/analyses/${analysisId}/export?format=json`);
      expect(reportViewSchema.parse(json.json()).analysis).toEqual(view.analysis);
      const markdown = await app.inject(`/api/v1/analyses/${analysisId}/export?format=markdown`);
      expect(markdown.body).toContain('## Overall Summary');
      expect(markdown.body).toContain('## AI Comments');
      expect(markdown.body).toContain('## Analyzed File List');
      const upsertPullRequestComment = vi.fn(async () => ({
        commentId: 42,
        commentUrl: 'https://github.example/synthetic',
        outcome: 'created' as const,
      }));
      await database.query('update repositories set review_publishing_enabled=true');
      const pullRequestId = (await database.query('select id from pull_requests limit 1')).rows[0]
        .id;
      const publisher = { upsertPullRequestComment } as unknown as GitHubReader &
        GitHubReviewPublisher;
      await publishReviewToGitHub(
        database,
        publisher,
        config,
        { id: randomUUID(), payload: { analysisId, pullRequestId } },
        artifacts,
      );
      const posted = JSON.stringify(upsertPullRequestComment.mock.calls);
      for (const title of ['AI Comments', '파일 요약', original.hash, 'api\\\\-compatibility'])
        expect(posted).toContain(title);
      expect(posted).not.toContain('Analyzed File List');
      expect(posted).not.toContain('## Overall Summary');
    } finally {
      await app.close();
    }
  });

  it('does not reinterpret a pre-migration null Skill binding using the current administrator version', async () => {
    const old = (
      await database.query(
        "insert into analysis_runs(snapshot_id, analysis_key, state) values ($1,$2,'queued') returning id",
        [snapshotId, `legacy:${randomUUID()}`],
      )
    ).rows[0];
    const before = calls.length;
    await executeAnalysisJob(
      database,
      artifacts,
      { ...config, GITHUB_MODE: 'disabled' },
      { ...analysisJob, payload: { ...analysisJob.payload, analysisId: old.id } },
    );
    expect(calls.length).toBe(before + 1);
    expect(calls.at(-1)!.messages[0]!.content).not.toContain('Active Review Skills');
    expect(calls.at(-1)!.messages[0]!.content).not.toContain('Severity Level');
    const stored = (
      await database.query(
        'select artifact.locator from reports report join artifacts artifact on artifact.id=report.artifact_id where report.analysis_run_id=$1',
        [old.id],
      )
    ).rows[0];
    expect((await artifacts.readJson<ReviewReport>(stored.locator)).analysis).toBeUndefined();
    expect(
      (await artifacts.readJson<ReviewReport>(stored.locator)).versions.severity,
    ).toBeUndefined();
  });
  it('carries published public criteria from queue through actual worker model inputs and report provenance', async () => {
    const repositoryId = (await database.query('select id from repositories limit 1')).rows[0].id;
    // Earlier tests activate lean; this fixture needs its P2 comment retained for linkage assertions.
    await database.query('update analysis_prompt_versions set active=false where tenant_id=$1', [
      tenantId,
    ]);
    await database.query(
      `insert into analysis_prompt_versions(tenant_id,version,instructions,severity_level,content_hash,active,created_by,activated_by,activated_at)
      values($1,3,'Owned shared criterion fixture','rigorous',$2,true,$3,$3,clock_timestamp())`,
      [tenantId, 'c'.repeat(64), userId],
    );
    const c = await database.connect();
    let criterion: string;
    try {
      await c.query('begin');
      criterion = await createCriterion(
        c,
        repositoryId,
        userId,
        criterionCreateSchema.parse({
          document: {
            title: 'Shared public criterion',
            topicKey: 'test.shared',
            requirement: 'PUBLIC_CRITERION_MARKER: inspect caller',
            rationale: 'Do not generalize past findings',
            severity: 'P2',
            appliesTo: {},
            counterEvidence: ['Caller may prevent the condition'],
            reviewSteps: ['Read current caller'],
          },
          decision: {
            outcome: 'design-decision',
            reasoning: 'Synthetic central publication',
            sources: [{ kind: 'manual', content: 'RAW_SOURCE_MUST_NOT_REACH_MODEL' }],
          },
        }),
      );
      let version = 1;
      await evaluateCriterion(
        c,
        await lockCriterion(c, repositoryId, criterion, version),
        userId,
        criterionEvaluationCreateSchema.parse({
          expectedVersion: version,
          note: 'Synthetic evaluation',
          cases: ['defect', 'fixed', 'normal', 'counter-evidence'].map((kind) => ({
            kind,
            name: kind,
            source: 'fixture',
            observed: kind === 'defect' ? 'finding' : 'clear',
            evidence: 'Synthetic observation',
          })),
        }),
      );
      version++;
      for (const action of ['evaluate', 'shadow', 'activate'] as const) {
        await actOnCriterion(c, await lockCriterion(c, repositoryId, criterion, version), userId, {
          expectedVersion: version,
          action,
          note: 'Synthetic approval',
        });
        version++;
      }
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
    const publish = async (component: string) => {
      const id = (
        await database.query('select request_review_knowledge($1,$2,null,$3) as id', [
          repositoryId,
          component,
          'worker-proof',
        ])
      ).rows[0].id;
      await database.query(
        "update review_knowledge_scopes set retry_after='infinity' where id<>$1",
        [id],
      );
      const claim = await claimKnowledgePublication(database);
      expect(claim?.id).toBe(id);
      expect(await publishKnowledge(database, artifacts, claim!)).not.toBe('failed');
    };
    await publish('policy');
    await publish('collective');
    const originalJob = (
      await database.query("select * from jobs where type='snapshot.materialize' limit 1")
    ).rows[0];
    const job = (
      await database.query(
        "insert into jobs(type,payload,priority,dedupe_key,state,attempt_count,lease_owner,lease_expires_at) values('snapshot.materialize',$1::jsonb,1,$2,'running',1,'shared-proof',clock_timestamp()+interval '1 hour') returning *",
        [JSON.stringify(originalJob.payload), 'shared-proof:' + randomUUID()],
      )
    ).rows[0];
    const attempt = (
      await database.query(
        "insert into job_attempts(job_id,attempt_number,executor) values($1,1,'shared-proof') returning id",
        [job.id],
      )
    ).rows[0].id;
    await executeSnapshotJob(
      database,
      null,
      artifacts,
      { ...config, KNOWLEDGE_PUBLICATION_ENABLED: true },
      path.join(directory, 'shared-snapshot'),
      { ...job, attempt_id: attempt },
    );
    const run = (
      await database.query(
        "select * from analysis_runs where shared_knowledge->>'status'='ready' order by created_at desc limit 1",
      )
    ).rows[0];
    expect(run).toBeDefined();
    expect(run.memory_context).toEqual([]);
    expect(run.memory_owner_user_id).toBeNull();
    const pinned = structuredClone(run.shared_knowledge);
    await expect(
      database.query("update analysis_runs set shared_knowledge='{}' where id=$1", [run.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await database.query("update review_rules set state='retired' where id=$1", [criterion]);
    await publish('policy');
    expect(
      (await database.query('select shared_knowledge from analysis_runs where id=$1', [run.id]))
        .rows[0].shared_knowledge,
    ).toEqual(pinned);
    const queued = (
      await database.query("select * from jobs where payload->>'analysisId'=$1", [run.id])
    ).rows[0];
    const runAttempt = (
      await database.query(
        "insert into job_attempts(job_id,attempt_number,executor) values($1,1,'shared-model') returning id",
        [queued.id],
      )
    ).rows[0].id;
    await database.query(
      "update jobs set state='running',attempt_count=1,lease_owner='shared-model',lease_expires_at=clock_timestamp()+interval '1 hour' where id=$1",
      [queued.id],
    );
    const identity = (
      await database.query(
        'select r.head_sha,s.merge_base_sha from snapshots s join snapshot_requests r on r.id=s.request_id where s.id=$1',
        [run.snapshot_id],
      )
    ).rows[0];
    const lease = { release: async () => {} };
    const workspace = vi
      .spyOn(sourceWorkspace, 'acquireSourceWorkspace')
      .mockResolvedValue(
        lease as Awaited<ReturnType<typeof sourceWorkspace.acquireSourceWorkspace>>,
      );
    const text = 'export function load() { return contract; }\n',
      hash = createHash('sha256').update(text).digest('hex');
    const blob = createHash('sha1')
      .update(`blob ${Buffer.byteLength(text)}\0`)
      .update(text)
      .digest('hex');
    const reader = vi
      .spyOn(sourceWorkspace, 'executeSourceTool')
      .mockImplementation(async (_config, _workspace, input) => ({
        id: hash.slice(0, 24),
        path: input.path,
        revision: input.revision,
        sha: input.revision === 'head' ? identity.head_sha : identity.merge_base_sha,
        startLine: 1,
        endLine: 2,
        content: text,
        hash,
        blob,
        truncated: false,
      }));
    const before = calls.length;
    try {
      await executeAnalysisJob(
        database,
        artifacts,
        { ...config, GITHUB_MODE: 'disabled', KNOWLEDGE_PUBLICATION_ENABLED: true },
        { ...queued, attempt_count: 1, attempt_id: runAttempt },
      );
    } finally {
      workspace.mockRestore();
      reader.mockRestore();
    }
    const messages = JSON.stringify(calls.slice(before));
    expect(messages).toContain('PUBLIC_CRITERION_MARKER');
    expect(messages).not.toContain('RAW_SOURCE_MUST_NOT_REACH_MODEL');
    expect(messages).toContain('Caller may prevent the condition');
    expect(
      JSON.stringify(
        calls
          .slice(before)
          .filter((call) =>
            call.messages[0]!.content.includes('Current analysis stage: overall-summary'),
          ),
      ),
    ).not.toContain('criterion_assessments');
    const selection = (
      await database.query('select * from analysis_shared_selections where analysis_id=$1', [
        run.id,
      ])
    ).rows[0];
    expect(selection.context.selection.items.some((i: { id: string }) => i.id === criterion)).toBe(
      true,
    );
    const saved = (
      await database.query(
        'select a.locator from reports r join artifacts a on a.id=r.artifact_id where r.analysis_run_id=$1',
        [run.id],
      )
    ).rows[0];
    const report = await artifacts.readJson<ReviewReport>(saved.locator);
    expect(report.versions.sharedKnowledge).toBe(run.shared_knowledge_hash);
    expect(report.versions.sharedSelection).toBe(selection.context_hash);
    expect(report.findings.length, JSON.stringify(report.coverage)).toBeGreaterThan(0);
    const linked = report.findings.find((finding) => finding.criteria?.status === 'linked');
    expect(linked?.criteria?.items[0]).toMatchObject({
      id: criterion,
      revision: 1,
      title: 'Shared public criterion',
      outcome: 'uncertain',
      pinHash: run.shared_knowledge_hash,
      contextHash: selection.context_hash,
      evaluator: 'model',
      validation: 'pinned-target',
    });
    const failed = (
      await database.query(
        "insert into analysis_runs(snapshot_id,analysis_key,state,shared_knowledge,shared_knowledge_hash,skill_bundle,skill_hash) select snapshot_id,$2,'queued',shared_knowledge,shared_knowledge_hash,skill_bundle,skill_hash from analysis_runs where id=$1 returning id",
        [run.id, 'source-unavailable:' + randomUUID()],
      )
    ).rows[0];
    const unavailable = vi
      .spyOn(sourceWorkspace, 'acquireSourceWorkspace')
      .mockRejectedValue(Error('Synthetic unavailable source'));
    const priorCalls = calls.length;
    try {
      await executeAnalysisJob(
        database,
        artifacts,
        { ...config, GITHUB_MODE: 'disabled', KNOWLEDGE_PUBLICATION_ENABLED: true },
        {
          ...queued,
          payload: { ...queued.payload, analysisId: failed.id },
          attempt_count: 1,
          attempt_id: runAttempt,
        },
      );
    } finally {
      unavailable.mockRestore();
    }
    expect(calls.length).toBeGreaterThan(priorCalls);
    expect(JSON.stringify(calls.slice(priorCalls))).not.toContain(
      'Pinned published review criteria',
    );
    const failedRow = (
      await database.query(
        'select r.state,a.locator from analysis_runs r join reports report on report.analysis_run_id=r.id join artifacts a on a.id=report.artifact_id where r.id=$1',
        [failed.id],
      )
    ).rows[0];
    expect(failedRow.state).toBe('completed');
    const failedReport = await artifacts.readJson<ReviewReport>(failedRow.locator);
    expect(failedReport.versions.sharedKnowledgeStatus).toBe('unavailable');
    expect(failedReport.coverage.limitations.join(' ')).not.toContain('model review가 비활성화');
    expect(failedReport.findings.some((finding) => finding.criteria?.status === 'linked')).toBe(
      false,
    );
    // Missing, damaged and foreign optional bundles cannot suppress the base review.
    const missingPin = {
      ...pinned,
      status: 'unavailable',
      reason: 'Publication missing',
      releases: [],
      bundles: {},
    };
    const foreignPin = { ...pinned, repositoryId: randomUUID() };
    for (const [name, value, damaged] of [
      ['missing-publication', missingPin, false],
      ['damaged-hash', pinned, true],
      ['foreign-scope', foreignPin, false],
    ] as const) {
      const hash = damaged
        ? '0'.repeat(64)
        : createHash('sha256').update(canonicalKnowledgeJson(value)).digest('hex');
      const baseOnly = (
        await database.query(
          "insert into analysis_runs(snapshot_id,analysis_key,state,shared_knowledge,shared_knowledge_hash,skill_bundle,skill_hash) select snapshot_id,$2,'queued',$3::jsonb,$4,skill_bundle,skill_hash from analysis_runs where id=$1 returning id",
          [run.id, name + ':' + randomUUID(), JSON.stringify(value), hash],
        )
      ).rows[0];
      const prior = calls.length;
      await executeAnalysisJob(
        database,
        artifacts,
        { ...config, GITHUB_MODE: 'disabled', KNOWLEDGE_PUBLICATION_ENABLED: true },
        {
          ...queued,
          attempt_count: 1,
          attempt_id: runAttempt,
          payload: { ...queued.payload, analysisId: baseOnly.id },
        },
      );
      expect(calls.length, name).toBeGreaterThan(prior);
      expect(JSON.stringify(calls.slice(prior)), name).not.toContain(
        'Pinned published review criteria',
      );
      const saved = (
        await database.query(
          'select r.state,a.locator from analysis_runs r join reports report on report.analysis_run_id=r.id join artifacts a on a.id=report.artifact_id where r.id=$1',
          [baseOnly.id],
        )
      ).rows[0];
      expect(saved.state, name).toBe('completed');
      const report = await artifacts.readJson<ReviewReport>(saved.locator);
      expect(report.versions.sharedKnowledgeStatus, name).toBe('unavailable');
      expect(report.versions.sharedSelection, name).toBeUndefined();
      expect(
        report.findings.some((finding) => finding.criteria?.status === 'linked'),
        name,
      ).toBe(false);
    }
    const originalState = (
      await database.query('select state from analysis_runs where id=$1', [run.id])
    ).rows[0].state;
    await database.query("update analysis_runs set state='partial' where id=$1", [run.id]);
    const retry = await queueIncompleteAnalysisReanalysis(database, run.id, randomUUID());
    expect(
      (
        await database.query(
          'select shared_knowledge,shared_knowledge_hash from analysis_runs where id=$1',
          [retry.analysisId],
        )
      ).rows,
    ).toEqual(
      (
        await database.query(
          'select shared_knowledge,shared_knowledge_hash from analysis_runs where id=$1',
          [run.id],
        )
      ).rows,
    );
    expect(
      (
        await database.query(
          'select context_hash from analysis_shared_selections where analysis_id=$1',
          [retry.analysisId],
        )
      ).rows[0].context_hash,
    ).toBe(selection.context_hash);
    await database.query('update analysis_runs set state=$2 where id=$1', [run.id, originalState]);
    let viewerEnabled = true,
      viewerPresent = true;
    const app = Fastify();
    app.decorateRequest('user', null);
    app.addHook('onRequest', async (request) => {
      if (!viewerPresent) return;
      request.user = {
        id: userId,
        subject: 'synthetic:worker',
        displayName: 'Fixture',
        role: 'administrator',
        enabled: viewerEnabled,
        tenantIds: [],
        tenants: [],
        groups: [],
      };
    });
    await registerAnalysisRoutes(
      app,
      database,
      new EventHub(database),
      artifacts,
      config,
      new AuthorizationService(config),
    );
    try {
      const response = await app.inject({ url: `/api/v1/analyses/${run.id}/shared-knowledge` });
      expect(response.statusCode, response.body).toBe(200);
      const view = analysisSharedKnowledgeSchema.parse(response.json());
      expect(view.status).toBe('selected');
      expect(view.selection!.hash).toBe(selection.context_hash);
      const reportResponse = await app.inject({ url: `/api/v1/analyses/${run.id}` });
      expect(reportResponse.statusCode).toBe(200);
      expect(
        reportResponse.json().findings.find((f: { id: string }) => f.id === linked!.id).criteria,
      ).toEqual(linked!.criteria);
      const incomplete = await app.inject({
        url: `/api/v1/analyses/${failed.id}/shared-knowledge`,
      });
      expect(incomplete.json().status).toBe('unavailable');
      viewerEnabled = false;
      expect(
        (await app.inject({ url: `/api/v1/analyses/${run.id}/shared-knowledge` })).statusCode,
      ).toBe(404);
      viewerEnabled = true;
      viewerPresent = false;
      expect(
        (await app.inject({ url: `/api/v1/analyses/${run.id}/shared-knowledge` })).statusCode,
      ).toBe(401);
      viewerPresent = true;

      expect(response.body).not.toContain('RAW_SOURCE_MUST_NOT_REACH_MODEL');
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw Error('Owned server required');
      const vite = await createServer({
        root: path.resolve('apps/web'),
        server: {
          host: '127.0.0.1',
          port: 0,
          proxy: { '/api': `http://127.0.0.1:${address.port}` },
        },
        plugins: [
          {
            name: 'owned-shared-component',
            configureServer(server) {
              server.middlewares.use('/__shared-proof', async (_request, response) => {
                response.setHeader('content-type', 'text/html');
                response.end(
                  await server.transformIndexHtml(
                    '/__shared-proof',
                    `<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="root"></main><script type="module">import React from 'react';import {createRoot} from 'react-dom/client';import {SharedKnowledgePanel} from '/src/SharedKnowledgePanel.tsx';import {FindingCriteria} from '/src/FindingCriteria.tsx';import '/src/styles.css';const report=await fetch('/api/v1/analyses/${run.id}').then(r=>r.json());createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,React.createElement(SharedKnowledgePanel,{analysisId:'${run.id}'}),...report.findings.filter(f=>f.criteria?.status==='linked').map(f=>React.createElement(FindingCriteria,{key:f.id,criteria:f.criteria}))));</script></body></html>`,
                  ),
                );
              });
            },
          },
        ],
      });
      let browser;
      try {
        await vite.listen();
        const web = vite.httpServer!.address();
        if (!web || typeof web === 'string') throw Error('Owned browser server required');
        browser = await chromium.launch({ channel: 'chrome', headless: true });
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${web.port}/__shared-proof`);
        await page.getByText('공용 리뷰 기준 버전', { exact: true }).click();
        await page.getByText('집단 Memory · 발행', { exact: false }).waitFor();
        await page.getByText('검토 기준 · Shared public criterion · v1', { exact: true }).click();
        expect(await page.locator('body').innerText()).toContain(criterion);
        await page.getByText('공용 기준 판단 · 1개', { exact: true }).first().click();
        await page
          .getByText('Shared public criterion · v1 · 판단 미완료', { exact: true })
          .first()
          .waitFor();
        expect(await page.locator('body').innerText()).toContain(
          '실제 caller 실행은 관측하지 않았습니다.',
        );
        await page.getByText('기준·원문 식별 정보', { exact: true }).first().click();
        expect(await page.locator('body').innerText()).toContain(selection.context_hash);
        expect(await page.locator('body').innerText()).not.toContain(
          'RAW_SOURCE_MUST_NOT_REACH_MODEL',
        );
        for (const width of [1360, 420]) {
          await page.setViewportSize({ width, height: 900 });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ).toBe(true);
          if (process.env.GCR_SHARED_PROOF_DIR) {
            await import('node:fs/promises').then((fs) =>
              fs.mkdir(process.env.GCR_SHARED_PROOF_DIR!, { recursive: true }),
            );
            await page.screenshot({
              path: path.join(process.env.GCR_SHARED_PROOF_DIR, `shared-${width}.png`),
              fullPage: true,
            });
          }
        }
      } finally {
        await browser?.close();
        await vite.close();
      }
    } finally {
      await app.close();
    }
  }, 60000);
});
