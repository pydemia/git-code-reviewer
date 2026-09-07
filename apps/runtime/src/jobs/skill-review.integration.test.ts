import { randomUUID } from 'node:crypto';
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
import { executeAnalysisJob, executeSnapshotJob } from './worker.js';

const databaseUrl = process.env.GCR_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl).sequential('Worker pinned Skill snapshot and staged review', () => {
  const schema = `gcr_worker_skills_${randomUUID().replaceAll('-', '')}`;
  let root: Database, database: Database, artifacts: FilesystemArtifactStore, config: AppConfig;
  let directory: string, analysisId: string, snapshotId: string, versionId: string, userId: string;
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
                          category: 'api-compatibility',
                          priority: 'P2',
                          comment: '검증용 unit입니다. 실제 취약점 판정이 아닙니다.',
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

  it('stores the exact administrator bundle/hash when materialization creates the queued analysis', async () => {
    const run = (await database.query('select * from analysis_runs where id = $1', [analysisId]))
      .rows[0];
    expect(run).toMatchObject({
      state: 'queued',
      skill_version_id: versionId,
      skill_hash: original.hash,
      skill_bundle: { hash: original.hash },
    });
    expect(run.analysis_key).toContain(original.hash);
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

  it('uses the queued version after administrators activate another version, and persists custom categories', async () => {
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
      for (const title of [
        'Overall Summary',
        'AI Comments',
        'Analyzed File List',
        original.hash,
        'api\\\\-compatibility',
      ])
        expect(posted).toContain(title);
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
    const stored = (
      await database.query(
        'select artifact.locator from reports report join artifacts artifact on artifact.id=report.artifact_id where report.analysis_run_id=$1',
        [old.id],
      )
    ).rows[0];
    expect((await artifacts.readJson<ReviewReport>(stored.locator)).analysis).toBeUndefined();
  });
});
