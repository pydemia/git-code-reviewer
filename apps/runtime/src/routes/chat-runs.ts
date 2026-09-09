import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '@gcr/db';
import type { FilesystemArtifactStore } from '@gcr/artifact-store';
import { createChatRunSchema } from '@gcr/contracts';
import { z } from 'zod';
import { requireUser } from '../auth/index.js';
import type { AppConfig } from '../config.js';
import type { AuthorizationService } from '../services/authorization.js';
import { buildChatReviewContext } from '../services/chat-answer.js';
import { readPersonalPrompt } from '../services/personal-prompt.js';
import {
  agentRunAuthorized,
  reviewAgentInstructions,
  type AgentRun,
} from '../services/chat-agent.js';
import { appendEvent, type EventRow, formatServerSentEvent } from '../events/index.js';
import { ownedSession, readChatMemoryContext, readReport } from './chat.js';
import { readConversationContext } from '../services/conversation-context.js';
import { resolveChatAccountSelection } from '../services/account-registry.js';

const runParams = z.object({ runId: z.string().uuid() });
const sessionParams = z.object({ sessionId: z.string().uuid() });
async function readableRun(
  database: Database,
  config: AppConfig,
  request: FastifyRequest,
  runId: string,
) {
  const result = await database.query<AgentRun>(
    'select cr.* from chat_runs cr join chat_sessions cs on cs.id=cr.session_id where cr.id=$1 and cs.user_id=$2',
    [runId, request.user!.id],
  );
  return result.rows[0] && (await agentRunAuthorized(database, config, runId))
    ? result.rows[0]
    : null;
}
export async function chatRunView(database: Database, run: AgentRun) {
  const questions = await database.query<{
    id: string;
    question: string;
    options: string[];
    answer: string | null;
    expires_at: Date;
  }>('select * from chat_questions where run_id=$1 order by expires_at desc,id desc limit 32', [
    run.id,
  ]);
  const events = await database.query<EventRow>(
    "select id::text,type,payload from event_log where scope='chat_run' and scope_id=$1 and type <> 'response.output_text.delta' order by id desc limit 60",
    [run.id],
  );
  const question = questions.rows[0];
  return {
    id: run.id,
    sessionId: run.session_id,
    assistantMessageId: run.assistant_message_id,
    status: run.status,
    phase: run.phase,
    content: run.content,
    model: { name: run.configuration.modelName, effort: run.configuration.effort },
    error: run.error_code,
    modelCalls: run.model_calls,
    toolCalls: run.tool_calls,
    contextBytes: run.context_bytes,
    question: question
      ? {
          id: question.id,
          question: question.question,
          options: question.options,
          answer: question.answer,
          expiresAt: question.expires_at.toISOString(),
        }
      : null,
    questions: questions.rows.map((item) => ({
      id: item.id,
      question: item.question,
      options: item.options,
      answer: item.answer,
      expiresAt: item.expires_at.toISOString(),
    })),
    resumeAfter: run.resume_after?.toISOString() ?? null,
    evidence: run.checkpoint.evidence,
    timeline: events.rows.reverse().map((event) => ({
      id: event.id,
      type: event.type,
      label: String(event.payload.label ?? event.type),
    })),
  };
}
export async function registerChatRunRoutes(
  app: FastifyInstance,
  database: Database,
  artifacts: FilesystemArtifactStore,
  config: AppConfig,
  authorization: AuthorizationService,
) {
  const enabledFor = (request: FastifyRequest) =>
    config.CHAT_AGENT_ENABLED &&
    (!config.CHAT_AGENT_ALLOWED_USER_IDS ||
      config.CHAT_AGENT_ALLOWED_USER_IDS.split(',').includes(request.user!.id));
  app.get('/api/v1/chat-agent/config', { preHandler: requireUser }, async (request) => ({
    enabled: enabledFor(request),
  }));
  app.post(
    '/api/v1/chat-sessions/:sessionId/runs',
    { preHandler: requireUser },
    async (request, reply) => {
      if (!enabledFor(request))
        return reply.code(503).send({
          error: { code: 'AGENT_DISABLED', message: 'Interactive Chat이 활성화되지 않았습니다.' },
        });
      const { sessionId } = sessionParams.parse(request.params);
      const body = createChatRunSchema.parse(request.body);
      const session = await ownedSession(database, authorization, request, sessionId);
      if (!session) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      const existing = await database.query<AgentRun>(
        'select * from chat_runs where session_id=$1 and idempotency_key=$2',
        [sessionId, body.idempotencyKey],
      );
      if (existing.rows[0]) return chatRunView(database, existing.rows[0]);
      const chosen = body.selection ?? {
        accountId: session.chat_account_id,
        modelName: session.model_name,
        reasoningEffort: session.reasoning_effort,
      };
      if (!chosen.accountId || !chosen.modelName || !chosen.reasoningEffort)
        return reply.code(400).send({
          error: {
            code: 'AGENT_ACCOUNT_REQUIRED',
            message: '등록된 ChatGPT 계정을 선택해 주세요.',
          },
        });
      const selection = await resolveChatAccountSelection(
        database,
        config,
        request.user!.id,
        chosen.accountId,
        chosen.modelName,
        chosen.reasoningEffort,
      );
      if (!selection)
        return reply.code(403).send({
          error: {
            code: 'CHAT_SELECTION_UNAVAILABLE',
            message:
              '이 account, model 또는 effort를 사용할 수 없습니다. 계정 목록을 새로고침해 주세요.',
          },
        });
      const report = await readReport(database, artifacts, session.analysis_id);
      if (!report) return reply.code(409).send({ error: { code: 'REPORT_UNAVAILABLE' } });
      const files = await database.query<{ id: string; path: string }>(
        'select id,path from snapshot_files where snapshot_id=$1',
        [report.snapshotId],
      );
      const context = buildChatReviewContext(report, files.rows, body.scope);
      const [memory, history, personal] = await Promise.all([
        readChatMemoryContext(
          database,
          session.analysis_id,
          request.user!.id,
          files.rows.map((file) => file.path),
          body.content,
        ),
        readConversationContext(database, sessionId),
        readPersonalPrompt(database, request.user!.id),
      ]);
      const checkpoint = {
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              kind: 'untrusted_review_context',
              excerpt: Buffer.from(JSON.stringify(context.context))
                .subarray(0, 80000)
                .toString('utf8'),
              excerptTruncated: Buffer.byteLength(JSON.stringify(context.context)) > 80000,
              memory,
              personal,
            }),
          },
          { role: 'user', content: JSON.stringify(history) },
          { role: 'user', content: body.content },
        ],
        pendingTools: [],
        evidence: [],
        instructions: [],
      };
      const client = await database.connect();
      try {
        await client.query('begin');
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [request.user!.id]);
        const duplicate = await client.query<AgentRun>(
          'select * from chat_runs where session_id=$1 and idempotency_key=$2',
          [sessionId, body.idempotencyKey],
        );
        if (duplicate.rows[0]) {
          await client.query('commit');
          return chatRunView(database, duplicate.rows[0]);
        }
        const active = await client.query(
          "select 1 from chat_runs where session_id=$1 and status in ('queued','running','awaiting_input','waiting_capacity','cancelling')",
          [sessionId],
        );
        if (active.rowCount) {
          await client.query('rollback');
          return reply.code(409).send({
            error: {
              code: 'RUN_ALREADY_ACTIVE',
              message: '진행 중인 대화에 응답하거나 중단해 주세요.',
            },
          });
        }
        const usage = await client.query<{ hourly: string; pending: string; session: string }>(
          `select (select count(*)::text from chat_messages m join chat_sessions s on s.id=m.session_id where s.user_id=$1 and m.role='user' and m.created_at>clock_timestamp()-interval '1 hour') as hourly,(select count(*)::text from chat_messages m join chat_sessions s on s.id=m.session_id where s.user_id=$1 and m.role='assistant' and m.status='pending') as pending,(select count(*)::text from chat_messages where session_id=$2 and role='user') as session`,
          [request.user!.id, sessionId],
        );
        const count = usage.rows[0]!;
        if (
          Number(count.hourly) >= config.CHAT_HOURLY_LIMIT ||
          Number(count.pending) >= config.CHAT_CONCURRENCY_LIMIT ||
          Number(count.session) >= config.CHAT_SESSION_MESSAGE_LIMIT
        ) {
          await client.query('rollback');
          return reply.code(429).send({ error: { code: 'CHAT_LIMIT_EXCEEDED' } });
        }
        const user = await client.query<{ id: string }>(
          "insert into chat_messages(session_id,role,status,content,completed_at) values($1,'user','completed',$2,clock_timestamp()) returning id",
          [sessionId, body.content],
        );
        const assistant = await client.query<{ id: string }>(
          "insert into chat_messages(session_id,role,status,content) values($1,'assistant','pending','') returning id",
          [sessionId],
        );
        const result = await client.query<AgentRun>(
          'insert into chat_runs(session_id,user_message_id,assistant_message_id,idempotency_key,configuration,checkpoint) values($1,$2,$3,$4,$5::jsonb,$6::jsonb) returning *',
          [
            sessionId,
            user.rows[0]!.id,
            assistant.rows[0]!.id,
            body.idempotencyKey,
            JSON.stringify({
              snapshotId: report.snapshotId,
              ownerId: request.user!.id,
              accountId: chosen.accountId,
              modelName: chosen.modelName,
              effort: chosen.reasoningEffort,
              instructions: reviewAgentInstructions,
              maxModelCalls: config.CHAT_AGENT_MAX_MODEL_CALLS,
              modelTimeoutMs: config.CHAT_AGENT_MODEL_TIMEOUT_MS,
              maxToolCalls: config.CHAT_AGENT_MAX_TOOL_CALLS,
              maxContextBytes: config.CHAT_AGENT_CONTEXT_BYTES,
            }),
            JSON.stringify(checkpoint),
          ],
        );
        await appendEvent(client, 'chat_run', result.rows[0]!.id, 'run.queued', {
          label: '분석 대기',
        });
        await client.query('update chat_sessions set updated_at=clock_timestamp() where id=$1', [
          sessionId,
        ]);
        await client.query('commit');
        return reply.code(202).send(await chatRunView(database, result.rows[0]!));
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  );
  app.get(
    '/api/v1/chat-sessions/:sessionId/run-history',
    { preHandler: requireUser },
    async (request, reply) => {
      const { sessionId } = sessionParams.parse(request.params);
      if (!(await ownedSession(database, authorization, request, sessionId)))
        return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      const { before } = z.object({ before: z.string().uuid().optional() }).parse(request.query);
      const result = await database.query<{
        id: string;
        status: string;
        created_at: Date;
        question: string;
        snapshotId: string;
      }>(
        `select r.id,r.status,r.created_at,left(m.content,160) as question,r.configuration->>'snapshotId' as "snapshotId"
         from chat_runs r join chat_messages m on m.id=r.user_message_id
         where r.session_id=$1 and ($2::uuid is null or (r.created_at,r.id)<(select created_at,id from chat_runs where id=$2 and session_id=$1))
         order by r.created_at desc,r.id desc limit 31`,
        [sessionId, before ?? null],
      );
      return {
        items: result.rows
          .slice(0, 30)
          .map(({ created_at, ...item }) => ({ ...item, createdAt: created_at.toISOString() })),
        nextCursor: result.rows.length > 30 ? result.rows[29]!.id : null,
      };
    },
  );
  app.get(
    '/api/v1/chat-sessions/:sessionId/runs',
    { preHandler: requireUser },
    async (request, reply) => {
      const { sessionId } = sessionParams.parse(request.params);
      if (!(await ownedSession(database, authorization, request, sessionId)))
        return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      const result = await database.query<AgentRun>(
        'select * from chat_runs where session_id=$1 order by created_at desc limit 1',
        [sessionId],
      );
      return { run: result.rows[0] ? await chatRunView(database, result.rows[0]) : null };
    },
  );
  app.get('/api/v1/chat-runs/:runId', { preHandler: requireUser }, async (request, reply) => {
    const run = await readableRun(database, config, request, runParams.parse(request.params).runId);
    return run
      ? chatRunView(database, run)
      : reply.code(404).send({ error: { code: 'NOT_FOUND' } });
  });
  app.post(
    '/api/v1/chat-runs/:runId/cancel',
    { preHandler: requireUser },
    async (request, reply) => {
      const run = await readableRun(
        database,
        config,
        request,
        runParams.parse(request.params).runId,
      );
      if (!run) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      await database.query(
        "update chat_runs set status='cancelling',resume_after=null where id=$1 and status in ('queued','running','awaiting_input','waiting_capacity')",
        [run.id],
      );
      return reply.code(202).send({ id: run.id });
    },
  );
  app.post(
    '/api/v1/chat-runs/:runId/questions/:questionId/responses',
    { preHandler: requireUser },
    async (request, reply) => {
      const params = z
        .object({ runId: z.string().uuid(), questionId: z.string().uuid() })
        .parse(request.params);
      const body = z.object({ answer: z.string().trim().min(1).max(4000) }).parse(request.body);
      const run = await readableRun(database, config, request, params.runId);
      if (!run) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      const client = await database.connect();
      try {
        await client.query('begin');
        await client.query('select id from chat_runs where id=$1 for update', [run.id]);
        const answered = await client.query<{ answer: string }>(
          'select answer from chat_questions where id=$1 and run_id=$2 and answer is not null',
          [params.questionId, run.id],
        );
        if (answered.rows[0]?.answer === body.answer) {
          await client.query('commit');
          return { accepted: true };
        }
        const result = await client.query(
          `update chat_questions set answer=$3,answered_at=clock_timestamp() where id=$1 and run_id=$2 and answer is null and expires_at>clock_timestamp() and exists(select 1 from chat_runs where id=$2 and status='awaiting_input') returning id`,
          [params.questionId, run.id, body.answer],
        );
        if (!result.rowCount) {
          await client.query('rollback');
          return reply.code(409).send({ error: { code: 'QUESTION_STALE' } });
        }
        await client.query(
          "update chat_runs set status='queued',phase='resuming',resume_after=null where id=$1",
          [run.id],
        );
        await client.query(
          "insert into chat_messages(session_id,role,status,content,completed_at) values($1,'user','completed',$2,clock_timestamp())",
          [run.session_id, body.answer],
        );
        await appendEvent(client, 'chat_run', run.id, 'question.answered', {
          label: '사용자 응답 후 분석 재개',
        });
        await client.query('commit');
        return reply.code(202).send({ accepted: true });
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  );
  app.get(
    '/api/v1/chat-runs/:runId/context/:unitId',
    { preHandler: requireUser },
    async (request, reply) => {
      const params = z
        .object({ runId: z.string().uuid(), unitId: z.string().regex(/^[a-f0-9]{24}$/) })
        .parse(request.params);
      if (!(await readableRun(database, config, request, params.runId)))
        return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      const result = await database.query<{ metadata: Record<string, unknown>; content: string }>(
        'select metadata,content from chat_source_evidence where run_id=$1 and unit_id=$2',
        [params.runId, params.unitId],
      );
      return result.rows[0]
        ? { ...result.rows[0].metadata, content: result.rows[0].content }
        : reply.code(404).send({ error: { code: 'EVIDENCE_EXPIRED' } });
    },
  );
  app.post(
    '/api/v1/chat-runs/:runId/instructions',
    { preHandler: requireUser },
    async (request, reply) => {
      const { runId } = runParams.parse(request.params);
      const body = z
        .object({ idempotencyKey: z.string().uuid(), content: z.string().trim().min(1).max(4000) })
        .parse(request.body);
      const run = await readableRun(database, config, request, runId);
      if (!run) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      const client = await database.connect();
      try {
        await client.query('begin');
        const active = await client.query(
          "select id from chat_runs where id=$1 and status in ('queued','running','waiting_capacity') for update",
          [runId],
        );
        if (!active.rowCount) {
          await client.query('rollback');
          return reply
            .code(409)
            .send({ error: { code: 'RUN_NOT_ACTIVE', message: '새 질문으로 보내 주세요.' } });
        }
        const count = await client.query<{ count: string }>(
          'select count(*)::text from chat_run_instructions where run_id=$1',
          [runId],
        );
        if (Number(count.rows[0]?.count) >= 16) {
          await client.query('rollback');
          return reply.code(429).send({ error: { code: 'INSTRUCTION_LIMIT' } });
        }
        const inserted = await client.query(
          'insert into chat_run_instructions(id,run_id,content) values($1,$2,$3) on conflict do nothing returning id',
          [body.idempotencyKey, runId, body.content],
        );
        if (inserted.rowCount) {
          await client.query(
            "insert into chat_messages(session_id,role,status,content,completed_at) values($1,'user','completed',$2,clock_timestamp())",
            [run.session_id, body.content],
          );
          await appendEvent(client, 'chat_run', runId, 'instruction.queued', {
            label: '추가 지시를 다음 조회 단계에 반영합니다.',
          });
        }
        await client.query('commit');
        return reply.code(202).send({ accepted: true });
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  );
  app.get(
    '/api/v1/chat-runs/:runId/events',
    { preHandler: requireUser },
    async (request, reply) => {
      const { runId } = runParams.parse(request.params);
      if (!(await readableRun(database, config, request, runId)))
        return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      const query = z
        .object({
          after: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        })
        .parse(request.query);
      let cursor = query.after ?? Number(request.headers['last-event-id'] ?? 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      });
      let busy = false;
      const timer = setInterval(() => {
        if (busy) return;
        busy = true;
        void (async () => {
          if (!(await readableRun(database, config, request, runId))) {
            reply.raw.end();
            return;
          }
          const events = await database.query<EventRow>(
            "select id::text,scope,scope_id,type,payload,created_at from event_log where scope='chat_run' and scope_id=$1 and id>$2 order by id limit 100",
            [runId, cursor],
          );
          for (const event of events.rows) {
            if (reply.raw.writableLength > 262144) {
              reply.raw.end();
              return;
            }
            reply.raw.write(formatServerSentEvent({ ...event, type: 'change' }));
            cursor = Number(event.id);
          }
          if (!events.rowCount) reply.raw.write(': keepalive\n\n');
        })()
          .catch(() => reply.raw.end())
          .finally(() => {
            busy = false;
          });
      }, 700);
      reply.raw.on('close', () => clearInterval(timer));
      reply.raw.write(': connected\n\n');
    },
  );
}
