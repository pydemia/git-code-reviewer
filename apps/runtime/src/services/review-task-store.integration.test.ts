import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { FilesystemArtifactStore } from '@gcr/artifact-store';
import { loadBuiltInReviewSkills } from '@gcr/analysis-engine';
import { executeAnalysisJob } from '../jobs/worker.js';
import { loadConfig } from '../config.js';
import { registerAnalysisRoutes } from '../routes/analyses.js';
import { EventHub } from '../events/index.js';
import { AuthorizationService } from './authorization.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { buildImpactPlan, modelReviewFromText } from '@gcr/analysis-engine';
import { FixtureGitHubClient } from '@gcr/github';
import { ensureFixtureRepository, pollRepository } from './repositories.js';
import { databaseReviewTaskStore } from './review-task-store.js';
import { resumeAnalysis } from './analysis-resume.js';
import { deferModelJob } from './model-job-defer.js';
import { ModelCapacityError } from './model-admission.js';
const url = process.env.GCR_TEST_DATABASE_URL;
describe.skipIf(!url)('durable grouped review', () => {
  let root: Database, db: Database, pullId: string, snapshotId: string, userId: string;
  const schema = 'gcr_tasks_' + randomUUID().replaceAll('-', '');
  beforeAll(async () => {
    const target = new URL(url!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
      throw Error('Local test database required');
    root = createDatabase(target.href);
    await root.query(`create schema ${schema}`);
    target.searchParams.set('options', `-c search_path=${schema}`);
    db = createDatabase(target.href);
    await runMigrations(db, path.resolve('packages/db/migrations'));
    userId = (
      await db.query(
        "insert into users(oidc_subject,display_name,role) values('task-tester','Task tester','administrator') returning id",
      )
    ).rows[0].id;
    const repo = await ensureFixtureRepository(db);
    await pollRepository(db, new FixtureGitHubClient(), repo!);
    const pull = (
      await db.query(
        "select id,base_sha,head_sha from pull_requests where repository_id=$1 and state='open' limit 1",
        [repo],
      )
    ).rows[0];
    pullId = pull.id;
    const req = (
      await db.query(
        "insert into snapshot_requests(pull_request_id,base_sha,head_sha) values($1,$2,$3) on conflict(pull_request_id,base_sha,head_sha) do update set state='materialized' returning id",
        [pullId, pull.base_sha, pull.head_sha],
      )
    ).rows[0];
    snapshotId = (
      await db.query(
        "insert into snapshots(request_id,version,merge_base_sha,resolution,policy_version) values($1,1,$2,'exact','synthetic') returning id",
        [req.id, pull.base_sha],
      )
    ).rows[0].id;
  });
  afterAll(async () => {
    await db?.end();
    if (root) {
      await root.query(`drop schema ${schema} cascade`);
      await root.end();
    }
  });
  const plan = () =>
    buildImpactPlan({
      files: [
        {
          id: 'synthetic-file',
          path: 'a.py',
          status: 'added',
          previousPath: null,
          additions: 1,
          deletions: 0,
          patch: '@@ -0,0 +1 @@\n+x=1\n',
        },
      ],
      eligibleIds: new Set(['synthetic-file']),
      identity: 'frozen',
    });
  const claim = async (analysisId?: string) => {
    analysisId ??= (
      await db.query(
        "insert into analysis_runs(snapshot_id,analysis_key,state) values($1,$2,'analyzing') returning id",
        [snapshotId, randomUUID()],
      )
    ).rows[0].id;
    const job = (
      await db.query(
        "insert into jobs(type,payload,dedupe_key,state,attempt_count,lease_owner,lease_expires_at) values('analysis.run',$1::jsonb,$2,'running',1,'tester',clock_timestamp()+interval '1 hour') returning *",
        [JSON.stringify({ analysisId }), randomUUID()],
      )
    ).rows[0];
    const attempt = (
      await db.query(
        "insert into job_attempts(job_id,attempt_number,executor) values($1,1,'tester') returning id",
        [job.id],
      )
    ).rows[0];
    return { analysisId: analysisId!, job: { ...job, attempt_id: attempt.id } };
  };
  const result = (ids: string[]) =>
    modelReviewFromText(
      JSON.stringify({
        summary: 'Synthetic validated result',
        grade: 'adequate',
        file_comments: [],
        reviewed_targets: ids,
      }),
      [],
    );
  it('restores only completed tasks, rejects changed pins and fences stale attempts', async () => {
    const { analysisId, job } = await claim(),
      p = plan(),
      store = databaseReviewTaskStore(db, analysisId, job),
      task = p.tasks[0]!;
    expect((await store.initialize(p)).size).toBe(0);
    await store.start(task);
    await store.complete(task, result(task.targets.map((t) => t.id)));
    expect((await store.initialize(p)).size).toBe(1);
    await expect(store.initialize({ ...p, hash: 'f'.repeat(64) })).rejects.toThrow(
      'review_plan_input_changed',
    );
    await db.query(
      "update jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [job.id],
    );
    await expect(store.start(task)).rejects.toThrow('job_lease_lost');
    expect(
      (await db.query('select state from analysis_review_tasks where analysis_id=$1', [analysisId]))
        .rows[0].state,
    ).toBe('completed');
  });
  it('continues into one new revision, reuses exact task hashes and preserves the prior report state', async () => {
    const { analysisId, job } = await claim(),
      p = plan(),
      store = databaseReviewTaskStore(db, analysisId, job),
      task = p.tasks[0]!;
    await store.initialize(p);
    await store.start(task);
    await store.complete(task, result(task.targets.map((t) => t.id)));
    await db.query("update analysis_runs set state='partial' where id=$1", [analysisId]);
    const next = await resumeAnalysis(db, analysisId, userId);
    expect(next?.deduplicated).toBe(false);
    expect(await resumeAnalysis(db, analysisId, userId)).toEqual({ ...next, deduplicated: true });
    const nextJob = await claim(next!.analysisId);
    const restored = await databaseReviewTaskStore(db, next!.analysisId, nextJob.job).initialize(p);
    expect(restored.size).toBe(1);
    expect(
      (await db.query('select state from analysis_runs where id=$1', [analysisId])).rows[0].state,
    ).toBe('partial');
  });
  it('does not reuse results when the new plan changes and does not expose personal continuation to another user', async () => {
    const { analysisId, job } = await claim(),
      p = plan(),
      store = databaseReviewTaskStore(db, analysisId, job);
    await store.initialize(p);
    await store.start(p.tasks[0]!);
    await store.complete(p.tasks[0]!, result(p.tasks[0]!.targets.map((t) => t.id)));
    await db.query("update analysis_runs set state='partial',memory_owner_user_id=$2 where id=$1", [
      analysisId,
      userId,
    ]);
    const stranger = (
      await db.query(
        "insert into users(oidc_subject,display_name,role) values($1,'Stranger','reviewer') returning id",
        [randomUUID()],
      )
    ).rows[0].id;
    expect(await resumeAnalysis(db, analysisId, stranger)).toBeNull();
    const next = await resumeAnalysis(db, analysisId, userId),
      claimed = await claim(next!.analysisId);
    expect(
      (
        await databaseReviewTaskStore(db, next!.analysisId, claimed.job).initialize({
          ...p,
          hash: 'e'.repeat(64),
        })
      ).size,
    ).toBe(0);
  });
  it('persists a two-hour cooldown, releases the job lease, and keeps the ordinary retry budget', async () => {
    const { analysisId, job } = await claim(),
      until = new Date(Date.now() + 7200000),
      c = await db.connect();
    try {
      await c.query('begin');
      expect(await deferModelJob(c, job, new ModelCapacityError(until))).toBe(true);
      await c.query('commit');
    } finally {
      c.release();
    }
    const saved = (await db.query('select * from jobs where id=$1', [job.id])).rows[0];
    expect(saved.state).toBe('queued');
    expect(saved.available_at.getTime()).toBe(until.getTime());
    expect(saved.lease_owner).toBeNull();
    expect(saved.max_attempts - saved.model_defer_count).toBe(3);
    expect(
      (await db.query('select stage from analysis_runs where id=$1', [analysisId])).rows[0].stage,
    ).toBe('model-capacity-wait');
  });
  it('rejects continuation after the PR head changes without creating a job', async () => {
    const { analysisId, job } = await claim();
    await databaseReviewTaskStore(db, analysisId, job).initialize(plan());
    await db.query("update analysis_runs set state='partial' where id=$1", [analysisId]);
    const before = (await db.query('select head_sha from pull_requests where id=$1', [pullId]))
      .rows[0].head_sha;
    const count = Number((await db.query('select count(*) from jobs')).rows[0].count);
    try {
      await db.query('update pull_requests set head_sha=$2 where id=$1', [pullId, 'f'.repeat(40)]);
      expect(await resumeAnalysis(db, analysisId, userId)).toBeNull();
      expect(Number((await db.query('select count(*) from jobs')).rows[0].count)).toBe(count);
    } finally {
      await db.query('update pull_requests set head_sha=$2 where id=$1', [pullId, before]);
    }
  });
  it('runs the real worker and report/API pipeline for grouped inputs with a synthetic transport', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gcr-group-worker-'));
    const { analysisId, job } = await claim(),
      skills = loadBuiltInReviewSkills();
    const config = loadConfig({
      DATABASE_URL: url!,
      GITHUB_MODE: 'disabled',
      AUTH_MODE: 'development',
      MODEL_MODE: 'openai-compatible',
      MODEL_ENDPOINT: 'https://synthetic.invalid/v1/',
      MODEL_API_KEY: 'synthetic-only',
      MODEL_NAME: 'synthetic-review',
      CHAT_AGENT_ENABLED: 'false',
      ARTIFACT_ROOT: directory,
      ANALYSIS_GROUPING_THRESHOLD: '2',
    });
    const artifacts = new FilesystemArtifactStore(directory),
      files = Array.from({ length: 60 }, (_, i) => ({
        id: randomUUID(),
        path: `pkg/f${i}.py`,
        previousPath: null,
        status: 'added',
        additions: 1,
        deletions: 0,
        patch: '@@ -0,0 +1 @@\n+x=1\n',
      }));
    await db.query('update analysis_runs set skill_bundle=$2::jsonb,skill_hash=$3 where id=$1', [
      analysisId,
      JSON.stringify(skills),
      skills.hash,
    ]);
    const artifact = await artifacts.commitText(
      'owned/diff.json',
      JSON.stringify({ schemaVersion: 1, patch: files.map((f) => f.patch).join('\n'), files }),
    );
    await db.query(
      "insert into artifacts(scope_type,scope_id,artifact_type,version,checksum,byte_size,locator) values('snapshot',$1,'diff-index',1,$2,$3,$4)",
      [snapshotId, artifact.checksum, artifact.byteSize, artifact.locator],
    );
    for (const file of files)
      await db.query(
        'insert into snapshot_files(id,snapshot_id,path,status,additions,deletions) values($1,$2,$3,$4,1,0)',
        [file.id, snapshotId, file.path, file.status],
      );
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        calls++;
        const request = JSON.parse(String(init?.body));
        const payload = JSON.parse(request.messages[1].content.split('\n\n').slice(1).join('\n\n'));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'Synthetic grouped review',
                    grade: 'adequate',
                    file_comments: [],
                    reviewed_targets:
                      payload.targets?.map((t: { targetId: string }) => t.targetId) ?? [],
                  }),
                },
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const app = Fastify();
    let allowed = true;
    app.addHook('onRequest', async (request) => {
      request.user = {
        id: userId,
        subject: 'task-tester',
        displayName: 'Tester',
        role: 'administrator',
        groups: [],
        tenantIds: [],
        tenants: [],
        enabled: allowed,
      };
    });
    try {
      await executeAnalysisJob(db, artifacts, config, {
        ...job,
        payload: { analysisId, snapshotId, pullRequestId: pullId, skipPublication: true },
      });
      expect(calls).toBe(4);
      expect(
        (await db.query('select state,progress from analysis_runs where id=$1', [analysisId]))
          .rows[0],
      ).toEqual({ state: 'completed', progress: 100 });
      expect(
        (
          await db.query(
            "select count(*) from analysis_review_tasks where analysis_id=$1 and state='completed'",
            [analysisId],
          )
        ).rows[0].count,
      ).toBe('3');
      await registerAnalysisRoutes(
        app,
        db,
        new EventHub(db),
        artifacts,
        config,
        new AuthorizationService(config),
      );
      const tasks = await app.inject(`/api/v1/analyses/${analysisId}/review-tasks`);
      expect(tasks.statusCode).toBe(200);
      expect(tasks.json().filesTotal).toBe(60);
      const report = await app.inject(`/api/v1/analyses/${analysisId}`);
      expect(report.statusCode).toBe(200);
      expect(report.json().analysis.coverage.filesCompleted).toBe(60);
      expect(
        (await app.inject({ method: 'POST', url: `/api/v1/analyses/${analysisId}/resume` }))
          .statusCode,
      ).toBe(409);
      allowed = false;
      expect((await app.inject(`/api/v1/analyses/${analysisId}/review-tasks`)).statusCode).toBe(
        404,
      );
      expect(
        (await app.inject({ method: 'POST', url: `/api/v1/analyses/${analysisId}/resume` }))
          .statusCode,
      ).toBe(404);
    } finally {
      vi.unstubAllGlobals();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
