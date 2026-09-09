import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { FilesystemArtifactStore } from '@gcr/artifact-store';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { loadConfig, type AppConfig } from '../config.js';
import {
  claimAgentRun,
  executeAgentRun,
  reviewAgentInstructions,
  type AgentRun,
} from './chat-agent.js';
import { AuthorizationService } from './authorization.js';
import { registerChatRunRoutes } from '../routes/chat-runs.js';
import { registerChatRoutes } from '../routes/chat.js';
import { EventHub } from '../events/index.js';
import { admittedFetch, ModelCapacityError, withModelBudget } from './model-admission.js';
import type { AuthUser } from '../auth/index.js';
import { claimJob } from '../jobs/worker.js';
import { recoverExpiredJobs } from '../jobs/recovery.js';
import { assertJobLease, checkpointReviewModel } from './analysis-checkpoint.js';
import { legacyAnalysisReportSchema } from '@gcr/review-contract';
import {
  analyzeSnapshot,
  loadBuiltInReviewSkills,
  modelReviewFromText,
} from '@gcr/analysis-engine';

const mocks = vi.hoisted(() => ({ turn: vi.fn(), source: vi.fn() }));
vi.mock('./account-registry.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveChatAccountSelection: async () => ({
    accountId: 'test',
    accountName: 'Test',
    modelName: 'test',
    modelDisplayName: 'Test',
    reasoningEffort: 'medium',
    credentialVersion: 1,
    model: { name: 'test', generate: vi.fn(), turn: mocks.turn },
  }),
}));
vi.mock('./source-workspace.js', () => ({
  acquireSourceWorkspace: async () => ({ workspaceId: 'test', workspace: '/fixture' }),
  executeSourceTool: mocks.source,
}));

const url = process.env.GCR_TEST_DATABASE_URL;
describe.skipIf(!url).sequential('durable review agent and shared admission', () => {
  const schema = `gcr_agent_${randomUUID().replaceAll('-', '')}`;
  let root: Database;
  let database: Database;
  let config: AppConfig;
  let app: FastifyInstance;
  let user: AuthUser;
  let analysisId: string;
  let snapshotId: string;
  let temporary: string;
  beforeAll(async () => {
    const target = new URL(url!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
      throw Error('Use an isolated local PostgreSQL');
    root = createDatabase(target.href);
    await root.query(`create schema ${schema}`);
    target.searchParams.set('options', `-c search_path=${schema}`);
    database = createDatabase(target.href);
    await runMigrations(database, path.resolve('packages/db/migrations'));
    const tenant = (
      await database.query(
        "insert into tenants(slug,display_name) values('agent','Agent') returning id",
      )
    ).rows[0].id;
    const owner = (
      await database.query(
        "insert into users(oidc_subject,display_name,role) values('agent-user','Agent','administrator') returning id",
      )
    ).rows[0].id;
    user = {
      id: owner,
      subject: 'agent-user',
      displayName: 'Agent',
      role: 'administrator',
      enabled: true,
      groups: [],
      tenantIds: [tenant],
      tenants: [],
    };
    const instance = (
      await database.query(
        "insert into github_instances(name,api_base_url,web_base_url) values('agent','https://example.invalid/api/v3/','https://example.invalid/') returning id",
      )
    ).rows[0].id;
    const repo = (
      await database.query(
        "insert into repositories(tenant_id,instance_id,github_id,installation_id,owner,name) values($1,$2,1,'1','test','agent') returning id",
        [tenant, instance],
      )
    ).rows[0].id;
    const pull = (
      await database.query(
        "insert into pull_requests(repository_id,github_id,number,title,state,draft,author_login,html_url,base_ref,base_sha,head_ref,head_sha,github_updated_at) values($1,1,1,'Agent','open',false,'fixture','https://example.invalid/pull/1','main',$2,'feat',$3,clock_timestamp()) returning id",
        [repo, 'a'.repeat(40), 'b'.repeat(40)],
      )
    ).rows[0].id;
    const request = (
      await database.query(
        'insert into snapshot_requests(pull_request_id,base_sha,head_sha) values($1,$2,$3) returning id',
        [pull, 'a'.repeat(40), 'b'.repeat(40)],
      )
    ).rows[0].id;
    snapshotId = (
      await database.query(
        "insert into snapshots(request_id,version,resolution,policy_version,merge_base_sha) values($1,1,'exact','test',$2) returning id",
        [request, 'a'.repeat(40)],
      )
    ).rows[0].id;
    analysisId = (
      await database.query(
        "insert into analysis_runs(snapshot_id,analysis_key,state) values($1,'agent-test','completed') returning id",
        [snapshotId],
      )
    ).rows[0].id;
    config = loadConfig({
      DATABASE_URL: target.href,
      AUTH_MODE: 'development',
      CHAT_AGENT_ENABLED: 'true',
    });
    temporary = await mkdtemp(path.join(os.tmpdir(), 'gcr-agent-api-'));
    const coverage = {
      filesChanged: 0,
      filesExamined: 0,
      objectsExamined: 0,
      relationsExamined: 0,
      truncated: false,
      limitations: [],
    };
    const artifact = await new FilesystemArtifactStore(temporary).commitText(
      'synthetic-report.json',
      JSON.stringify({
        schemaVersion: 1,
        compatibility: {
          commitDefenderSchemaVersion: 1,
          baselineRevision: '47dabfea718729b0ccc685ae173857476040d6ea',
        },
        analysisRevisionId: analysisId,
        snapshotId,
        summary: '검증 report',
        grade: 'adequate',
        hasCriticalFindings: false,
        perFileSummaries: [],
        findings: [],
        impact: { summary: '', affectedAreas: [], coverage, confidence: 'high' },
        coverage,
        versions: { model: 'synthetic' },
        durationMs: 1,
      }),
    );
    await database.query(
      `insert into artifacts(scope_type,scope_id,artifact_type,version,checksum,byte_size,locator)
      values('analysis',$1,'report',1,$2,$3,$4)`,
      [analysisId, artifact.checksum, artifact.byteSize, artifact.locator],
    );
    app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.user = request.headers['x-other-user'] ? { ...user, id: randomUUID() } : user;
    });
    await registerChatRunRoutes(
      app,
      database,
      new FilesystemArtifactStore(temporary),
      config,
      new AuthorizationService(config),
    );
    await registerChatRoutes(
      app,
      database,
      new EventHub(database),
      new FilesystemArtifactStore(temporary),
      { ...config, CHAT_MODEL_MODE: 'registry' },
      null,
      new AuthorizationService(config),
    );
  });
  afterAll(async () => {
    await app?.close();
    await database?.end();
    if (root) {
      await root.query(`drop schema if exists ${schema} cascade`);
      await root.end();
    }
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await database.query('delete from chat_sessions');
    mocks.turn.mockReset();
    mocks.source.mockReset();
  });
  it('recovers expired jobs with bounded attempts and fences stale model checkpoints', async () => {
    const id = (
      await database.query(
        "insert into jobs(type,payload,max_attempts,dedupe_key) values('analysis.run',$1::jsonb,1,gen_random_uuid()::text) returning id",
        [JSON.stringify({ analysisId, snapshotId })],
      )
    ).rows[0].id;
    const first = (await claimJob(database, 'first-worker'))!;
    expect(first.id).toBe(id);
    const report = legacyAnalysisReportSchema.parse({
      schema_version: 1,
      staged_files: [],
      duration_ms: 0,
      exit_code: 0,
      lint_findings: [],
      review: {
        summary: '합성 checkpoint 검증',
        grade: 'adequate',
        blocking: false,
        is_error: false,
        file_comments: [],
      },
    });
    const review = vi.fn(async () => ({ report, truncated: false }));
    const model = { profile: 'synthetic', review };
    await checkpointReviewModel(model, database, analysisId, first).review('diff', []);
    expect(review).toHaveBeenCalledTimes(1);
    await database.query(
      "update jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [id],
    );
    await Promise.all([recoverExpiredJobs(database), recoverExpiredJobs(database)]);
    const second = (await claimJob(database, 'second-worker'))!;
    expect(second.attempt_count).toBe(2);
    await expect(assertJobLease(database, first)).rejects.toThrow('job_lease_lost');
    await checkpointReviewModel(model, database, analysisId, second).review('diff', []);
    expect(review).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 3; index++) {
      await database.query(
        "update jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
        [id],
      );
      await recoverExpiredJobs(database);
      if (index < 2) expect(await claimJob(database, `recovery-${index}`)).not.toBeNull();
    }
    expect(
      (await database.query('select state,recovery_count from jobs where id=$1', [id])).rows[0],
    ).toEqual({ state: 'failed', recovery_count: 3 });
    expect(
      (
        await database.query('select * from job_attempts where job_id=$1 and ended_at is null', [
          id,
        ])
      ).rowCount,
    ).toBe(0);
    await database.query("update analysis_runs set state='completed' where id=$1", [analysisId]);
  });
  it('rejects a result arriving after its Worker lease expires', async () => {
    const id = (
      await database.query(
        "insert into jobs(type,payload,dedupe_key) values('analysis.run',$1::jsonb,gen_random_uuid()::text) returning id",
        [JSON.stringify({ analysisId, snapshotId })],
      )
    ).rows[0].id;
    const job = (await claimJob(database, 'stale-result'))!;
    const review = async () => {
      await database.query(
        "update jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
        [id],
      );
      return {
        report: legacyAnalysisReportSchema.parse({
          schema_version: 1,
          staged_files: [],
          duration_ms: 0,
          exit_code: 0,
          lint_findings: [],
          review: {
            summary: '늦은 합성 응답',
            grade: 'adequate',
            blocking: false,
            is_error: false,
            file_comments: [],
          },
        }),
        truncated: false,
      };
    };
    await expect(
      checkpointReviewModel({ profile: 'late', review }, database, analysisId, job).review(
        'late',
        [],
      ),
    ).rejects.toThrow('job_lease_lost');
    expect(
      (
        await database.query(
          "select * from analysis_model_checkpoints where result->'report'->'review'->>'summary'='늦은 합성 응답'",
        )
      ).rowCount,
    ).toBe(0);
    await database.query("update jobs set state='failed' where id=$1", [id]);
  });

  it('resumes a 25-file review twice without spending its cumulative 128-call budget again', async () => {
    const jobId = (
      await database.query(
        "insert into jobs(type,payload,dedupe_key) values('analysis.run',$1::jsonb,gen_random_uuid()::text) returning id",
        [JSON.stringify({ analysisId, snapshotId })],
      )
    ).rows[0].id;
    const runKey = `analysis:${randomUUID()}`;
    const quotaKey = randomUUID();
    let sent = 0;
    const fetcher = admittedFetch(database, quotaKey, async () => {
      sent++;
      return Response.json({ summary: '합성 검토 완료', grade: 'adequate', file_comments: [] });
    });
    const model = {
      profile: 'resume-budget-regression',
      review: async (_diff: string, files: string[]) => {
        // 실제 원격 호출 없이 DB admission과 누적 사용량을 검증한다.
        const response = await fetcher('https://synthetic.invalid/responses', {
          method: 'POST',
          body: '{}',
        });
        const output = modelReviewFromText(await response.text(), files);
        // 90회 단위 테스트에서 60 RPM 대기만 제거한다. 누적 ledger 행은 삭제하지 않는다.
        if (sent === 50)
          await database.query(
            "update model_request_ledger set created_at=clock_timestamp()-interval '2 minutes' where run_key=$1",
            [runKey],
          );
        return output;
      },
    };
    const files = Array.from({ length: 25 }, (_, n) => {
      const lines = n < 14 ? 161 : 81;
      return {
        id: randomUUID(),
        path: `resume-${n}.ts`,
        previousPath: null,
        status: 'added',
        additions: lines,
        deletions: 0,
        patch:
          `@@ -0,0 +1,${lines} @@\n` +
          Array.from({ length: lines }, (_, line) => `+value${line}();`).join('\n') +
          '\n',
      };
    });
    const skills = { bundle: loadBuiltInReviewSkills(), versionId: null, version: null };
    for (const stopAfter of [30, 60, Infinity]) {
      const job = (await claimJob(database, `resume-worker-${stopAfter}`))!;
      expect(job.id).toBe(jobId);
      const execute = () =>
        withModelBudget({ runKey, maxCalls: 128, wait: false }, () =>
          analyzeSnapshot({
            analysisId,
            snapshotId,
            baseSha: 'a'.repeat(40),
            headSha: 'b'.repeat(40),
            patch: '',
            files,
            fixtureMode: false,
            skills,
            budgets: { maxModelCalls: 128 },
            model: checkpointReviewModel(
              model,
              database,
              analysisId,
              job,
              undefined,
              () => sent >= stopAfter,
            ),
          }),
        );
      if (Number.isFinite(stopAfter)) {
        await expect(execute()).rejects.toThrow('worker_draining');
        expect(sent).toBe(stopAfter);
        await database.query(
          "update jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
          [jobId],
        );
        await recoverExpiredJobs(database);
      } else {
        const result = await execute();
        expect(result.state).toBe('completed');
        expect(result.report.analysis?.coverage).toMatchObject({
          filesCompleted: 25,
          windowsPlanned: 64,
          windowsReviewed: 64,
          modelCalls: 90,
        });
        expect(sent).toBe(90);
      }
    }
    expect(
      (
        await database.query(
          'select count(*)::int as count from model_request_ledger where run_key=$1',
          [runKey],
        )
      ).rows[0].count,
    ).toBe(90);
    await database.query("update jobs set state='completed' where id=$1", [jobId]);
  });
  async function createRun() {
    const session = (
      await database.query(
        'insert into chat_sessions(analysis_run_id,user_id) values($1,$2) returning id',
        [analysisId, user.id],
      )
    ).rows[0].id;
    const message = (
      await database.query(
        "insert into chat_messages(session_id,role,status,content) values($1,'assistant','pending','') returning id",
        [session],
      )
    ).rows[0].id;
    return (
      await database.query<AgentRun>(
        'insert into chat_runs(session_id,assistant_message_id,idempotency_key,configuration,checkpoint) values($1,$2,$3,$4::jsonb,$5::jsonb) returning *',
        [
          session,
          message,
          randomUUID(),
          JSON.stringify({
            snapshotId,
            ownerId: user.id,
            accountId: randomUUID(),
            modelName: 'test',
            effort: 'medium',
            instructions: reviewAgentInstructions,
            maxModelCalls: 8,
            maxToolCalls: 24,
            maxContextBytes: 131072,
          }),
          JSON.stringify({
            messages: [{ role: 'user', content: '기존 retry와 재시작을 확인해 주세요.' }],
            pendingTools: [],
            evidence: [],
            instructions: [],
          }),
        ],
      )
    ).rows[0]!;
  }
  it('pins the selected model and effort per question while preserving the same session history', async () => {
    const original = await createRun();
    for (const [modelName, reasoningEffort] of [
      ['model-a', 'low'],
      ['model-b', 'high'],
    ]) {
      const session = await app.inject({
        method: 'POST',
        url: `/api/v1/analyses/${analysisId}/chat-sessions`,
        payload: { accountId: randomUUID(), modelName, reasoningEffort },
      });
      expect(session.statusCode).toBe(200);
      expect(session.json().id).toBe(original.session_id);
    }
    expect((await database.query('select count(*)::int as n from chat_sessions')).rows[0].n).toBe(
      1,
    );
    await database.query("update chat_runs set status='completed' where id=$1", [original.id]);
    await database.query(
      "update chat_messages set status='completed',content='이전 답변' where id=$1",
      [original.assistant_message_id],
    );
    const selection = {
      accountId: randomUUID(),
      modelName: 'selected-model',
      reasoningEffort: 'high',
    };
    const payload = {
      content: '다른 모델로 설명해 주세요.',
      idempotencyKey: randomUUID(),
      selection,
    };
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/chat-sessions/${original.session_id}/runs`,
      payload,
    });
    expect(response.statusCode).toBe(202);
    const next = (
      await database.query<AgentRun>('select * from chat_runs where id=$1', [response.json().id])
    ).rows[0]!;
    expect(next.configuration).toMatchObject({
      accountId: selection.accountId,
      modelName: 'selected-model',
      effort: 'high',
    });
    expect(JSON.stringify(next.checkpoint.messages)).toContain('이전 답변');
    expect(next.session_id).toBe(original.session_id);
    const previous = (
      await database.query<AgentRun>('select * from chat_runs where id=$1', [original.id])
    ).rows[0]!;
    expect(previous.configuration.modelName).toBe('test');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/chat-sessions/${original.session_id}/runs`,
          payload,
        })
      ).json().id,
    ).toBe(next.id);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/chat-sessions/${original.session_id}/runs`,
          headers: { 'x-other-user': '1' },
          payload,
        })
      ).statusCode,
    ).toBe(404);
  });
  it('paginates owned history and restores answered questions and immutable source', async () => {
    const original = await createRun();
    const message = (
      await database.query(
        "insert into chat_messages(session_id,role,status,content) values($1,'user','completed','과거 사용자 결정') returning id",
        [original.session_id],
      )
    ).rows[0].id;
    await database.query("update chat_runs set user_message_id=$2,status='completed' where id=$1", [
      original.id,
      message,
    ]);
    const metadata = {
      id: 'a'.repeat(24),
      revision: 'base',
      sha: 'b'.repeat(40),
      blob: 'c'.repeat(40),
      hash: 'd'.repeat(64),
      path: 'src/old.ts',
      startLine: 1,
      endLine: 1,
      truncated: false,
    };
    await database.query(
      'insert into chat_source_evidence(run_id,unit_id,metadata,content,model_step) values($1,$2,$3::jsonb,$4,1)',
      [original.id, metadata.id, JSON.stringify(metadata), 'old revision content'],
    );
    await database.query(
      "insert into chat_questions(run_id,call_id,question,options,answer) values($1,'old-question','업무 기준?', '[]','재시도 금지')",
      [original.id],
    );
    for (let index = 0; index < 31; index++)
      await database.query(
        "insert into chat_runs(session_id,user_message_id,idempotency_key,status,configuration) values($1,$2,$3,'completed',$4::jsonb)",
        [original.session_id, message, randomUUID(), JSON.stringify(original.configuration)],
      );
    const history = (
      await app.inject({ url: `/api/v1/chat-sessions/${original.session_id}/run-history` })
    ).json();
    expect(history.items).toHaveLength(30);
    const next = (
      await app.inject({
        url: `/api/v1/chat-sessions/${original.session_id}/run-history?before=${history.nextCursor}`,
      })
    ).json();
    expect(next.items).toHaveLength(2);
    expect(next.nextCursor).toBeNull();
    expect(
      (await app.inject({ url: `/api/v1/chat-runs/${original.id}` })).json().questions[0].answer,
    ).toBe('재시도 금지');
    expect(
      (await app.inject({ url: `/api/v1/chat-runs/${original.id}/context/${metadata.id}` })).json(),
    ).toMatchObject({ ...metadata, content: 'old revision content' });
    expect(
      (
        await app.inject({
          url: `/api/v1/chat-sessions/${original.session_id}/run-history`,
          headers: { 'x-other-user': 'yes' },
        })
      ).statusCode,
    ).toBe(404);
  });
  it('only one worker acquires a run and fences expired attempts', async () => {
    const run = await createRun();
    const claims = await Promise.all([
      claimAgentRun(database, 'one'),
      claimAgentRun(database, 'two'),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find(Boolean)!;
    await database.query(
      "update chat_runs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [run.id],
    );
    const second = await claimAgentRun(database, 'three');
    expect(Number(second!.fence)).toBe(Number(first.fence) + 1);
    await executeAgentRun(database, config, first);
    expect(mocks.turn).not.toHaveBeenCalled();
  });
  it('preserves partial output and charges a timed-out transmitted model request', async () => {
    const run = await createRun();
    mocks.turn.mockImplementationOnce(async (request) => {
      const fetcher = admittedFetch(database, randomUUID(), async () => {
        await request.onDelta('확인한 중간 결과');
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      });
      return fetcher('https://example.invalid/responses', { method: 'POST', body: '{}' });
    });
    await executeAgentRun(database, config, (await claimAgentRun(database, 'timeout-worker'))!);
    const result = (await database.query('select * from chat_runs where id=$1', [run.id])).rows[0];
    expect(result.status).toBe('partial');
    expect(result.content).toBe('확인한 중간 결과');
    expect(result.error_code).toBe('model_request_timeout');
    expect(result.model_calls).toBe(1);
    const ledger = (
      await database.query('select state from model_request_ledger where run_key=$1', [
        `chat-run:${run.id}`,
      ])
    ).rows;
    expect(ledger).toEqual([{ state: 'interrupted' }]);
  });
  it('reads source, asks the user, releases its lease and resumes with source evidence', async () => {
    const run = await createRun();
    const evidence = {
      id: 'e'.repeat(24),
      revision: 'base',
      sha: 'a'.repeat(40),
      path: 'unchanged.ts',
      startLine: 1,
      endLine: 2,
      blob: 'b'.repeat(40),
      hash: 'c'.repeat(64),
      content: 'return retryCount;',
      truncated: false,
    };
    mocks.source.mockResolvedValue(evidence);
    const sourceCall = {
      call_id: 'source-1',
      name: 'read_file',
      arguments: '{"path":"unchanged.ts","revision":"base"}',
    };
    const questionCall = {
      call_id: 'question-1',
      name: 'ask_user',
      arguments: '{"question":"재시작 후 횟수를 유지해야 하나요?","options":["유지","초기화"]}',
    };
    mocks.turn
      .mockResolvedValueOnce({
        content: '',
        output: [{ type: 'function_call', ...sourceCall }],
        calls: [sourceCall],
      })
      .mockResolvedValueOnce({
        content: '',
        output: [{ type: 'function_call', ...questionCall }],
        calls: [questionCall],
      })
      .mockImplementationOnce(async (input) => {
        expect(JSON.stringify(input.input)).toContain('유지');
        expect(JSON.stringify(input.input)).toContain('retryCount');
        await input.onDelta('분석 결과');
        return {
          content: `횟수를 유지해야 합니다. [source:${evidence.id}]`,
          output: [],
          calls: [],
        };
      });
    await executeAgentRun(database, config, (await claimAgentRun(database, 'one'))!);
    const waiting = (
      await database.query('select status,lease_expires_at from chat_runs where id=$1', [run.id])
    ).rows[0];
    expect(waiting.status).toBe('awaiting_input');
    expect(waiting.lease_expires_at).toBeNull();
    const question = (
      await database.query('select id from chat_questions where run_id=$1', [run.id])
    ).rows[0].id;
    const reply = await app.inject({
      method: 'POST',
      url: `/api/v1/chat-runs/${run.id}/questions/${question}/responses`,
      payload: { answer: '유지' },
    });
    expect(reply.statusCode).toBe(202);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/chat-runs/${run.id}/questions/${question}/responses`,
          payload: { answer: '유지' },
        })
      ).statusCode,
    ).toBe(200);
    await executeAgentRun(database, config, (await claimAgentRun(database, 'replacement'))!);
    const completed = await app.inject(`/api/v1/chat-runs/${run.id}`);
    expect(completed.json().status).toBe('completed');
    expect(completed.json().evidence).toHaveLength(1);
    expect(
      (await app.inject(`/api/v1/chat-runs/${run.id}/context/${evidence.id}`)).json().content,
    ).toBe('return retryCount;');
    expect(
      (
        await app.inject({
          url: `/api/v1/chat-runs/${run.id}`,
          headers: { 'x-other-user': 'true' },
        })
      ).statusCode,
    ).toBe(404);
    expect(mocks.turn).toHaveBeenCalledTimes(3);
  });
  it('persists cancellation without calling a model', async () => {
    const run = await createRun();
    await app.inject({ method: 'POST', url: `/api/v1/chat-runs/${run.id}/cancel`, payload: {} });
    await executeAgentRun(database, config, (await claimAgentRun(database, 'cancel'))!);
    expect((await app.inject(`/api/v1/chat-runs/${run.id}`)).json().status).toBe('cancelled');
    expect(mocks.turn).not.toHaveBeenCalled();
  });
  it('consumes instructions arriving while the final answer is streaming', async () => {
    const run = await createRun();
    mocks.turn
      .mockImplementationOnce(async () => {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/chat-runs/${run.id}/instructions`,
          payload: { idempotencyKey: randomUUID(), content: '기존 테스트도 설명해 주세요.' },
        });
        expect(response.statusCode).toBe(202);
        return {
          content: '첫 답변',
          output: [{ role: 'assistant', content: '첫 답변' }],
          calls: [],
        };
      })
      .mockImplementationOnce(async (input) => {
        expect(JSON.stringify(input.input)).toContain('기존 테스트도');
        return { content: '추가 지시까지 반영했습니다.', output: [], calls: [] };
      });
    await executeAgentRun(database, config, (await claimAgentRun(database, 'instructions'))!);
    expect(mocks.turn).toHaveBeenCalledTimes(2);
    expect((await app.inject(`/api/v1/chat-runs/${run.id}`)).json().content).toContain('추가 지시');
    expect(
      (await database.query('select * from chat_run_steps where run_id=$1', [run.id])).rowCount,
    ).toBeGreaterThan(0);
  });
  it('expires abandoned questions and releases pending message limits', async () => {
    const run = await createRun();
    await database.query(
      "update chat_runs set status='awaiting_input',expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [run.id],
    );
    expect(await claimAgentRun(database, 'expiry')).toBeNull();
    expect(
      (
        await database.query('select status from chat_messages where id=$1', [
          run.assistant_message_id,
        ])
      ).rows[0].status,
    ).toBe('failed');
  });
  it('shares upstream account capacity and charges retries to the same run', async () => {
    const quota = randomUUID();
    const transport = vi.fn(async () => new Response('ok'));
    const fetcher = admittedFetch(database, quota, transport as typeof fetch);
    const budget = { runKey: randomUUID(), maxCalls: 2 };
    const first = await withModelBudget(budget, () => fetcher('https://example.invalid'));
    await expect(
      withModelBudget(budget, () => fetcher('https://example.invalid')),
    ).rejects.toBeInstanceOf(ModelCapacityError);
    expect(transport).toHaveBeenCalledTimes(1);
    await first.text();
    await (await withModelBudget(budget, () => fetcher('https://example.invalid'))).text();
    await expect(withModelBudget(budget, () => fetcher('https://example.invalid'))).rejects.toThrow(
      'model_call_budget_exhausted',
    );
  });
  it('persists 429 cooldown and releases the account slot', async () => {
    const quota = randomUUID();
    const transport = vi.fn(
      async () => new Response('', { status: 429, headers: { 'retry-after': '30' } }),
    );
    const fetcher = admittedFetch(database, quota, transport as typeof fetch);
    await expect(
      withModelBudget({ runKey: randomUUID(), maxCalls: 8 }, () =>
        fetcher('https://example.invalid'),
      ),
    ).rejects.toBeInstanceOf(ModelCapacityError);
    const capacity = (
      await database.query('select * from model_account_capacity where quota_key=$1', [quota])
    ).rows[0];
    expect(capacity.reservation_id).toBeNull();
    expect(capacity.cooldown_until.getTime()).toBeGreaterThan(Date.now());
  });
  it('serves chat in its reserved slot while a batch response is still open', async () => {
    const order: string[] = [];
    const quota = randomUUID();
    const fetcher = admittedFetch(database, quota, async (_input, init) => {
      order.push(String(init?.body));
      return new Response('ok');
    });
    const batch = { runKey: randomUUID(), maxCalls: 3, wait: true };
    const chat = { runKey: randomUUID(), maxCalls: 2 };
    const initial = await withModelBudget(batch, () =>
      fetcher('https://example.invalid', { body: 'batch-first' }),
    );
    const nextBatch = withModelBudget(batch, () =>
      fetcher('https://example.invalid', { body: 'batch-next', signal: AbortSignal.timeout(5000) }),
    );
    const priority = await withModelBudget(chat, () =>
      fetcher('https://example.invalid', { body: 'chat' }),
    );
    await priority.text();
    await initial.text();
    await (await nextBatch).text();
    expect(order).toEqual(['batch-first', 'chat', 'batch-next']);
  });
});
