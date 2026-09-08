import {
  githubPrMemorySourceStateSchema,
  reviewMemoryCandidateCreateSchema,
  reviewMemoryReviewSchema,
  schemaVersion,
} from '@gcr/contracts';
import type { Database, DatabaseClient } from '@gcr/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAdministrator, requireUser } from '../auth/index.js';
import type { AuthorizationService } from '../services/authorization.js';
import {
  buildReviewMemorySearchText,
  createPersonalReviewMemoryCandidate,
  emptyReviewMemoryHash,
  refreshCollectiveReviewMemoryCandidate,
  reviewMemoryColumns,
  reviewMemoryContentHash,
  type ReviewMemoryProjection,
  type ReviewMemoryRecord,
} from '../services/review-memory.js';
import { canReadRepository } from './worklist.js';

const analysisParams = z.object({ analysisId: z.string().uuid() });
const memoryParams = z.object({ memoryId: z.string().uuid() });
const pullParams = z.object({
  repoId: z.string().uuid(),
  number: z.coerce.number().int().positive(),
});
const sourceParams = pullParams.extend({ sourceId: z.string().uuid() });
const adminListQuery = z.object({
  tenantId: z.string().uuid().optional(),
  repositoryId: z.string().uuid().optional(),
  scope: z.enum(['personal', 'collective']).optional(),
  state: z.enum(['candidate', 'active', 'rejected', 'superseded', 'retired']).optional(),
});

type AnalysisMemoryContext = {
  tenantId: string;
  repositoryId: string;
  memoryOwnerUserId: string | null;
  memoryHash: string;
  memoryContext: ReviewMemoryProjection[];
  baseSha: string;
  headSha: string;
};

export async function registerReviewMemoryRoutes(
  app: FastifyInstance,
  database: Database,
  authorization: AuthorizationService,
): Promise<void> {
  app.get(
    '/api/v1/repositories/:repoId/pulls/:number/review-memory-sources',
    { preHandler: requireUser },
    async (request, reply) => {
      const { repoId, number } = pullParams.parse(request.params);
      if (!(await canReadRepository(database, authorization, request, repoId, 'view'))) {
        return hiddenNotFound(request, reply);
      }
      const result = await database.query<GitHubPrMemorySourceRow>(
        `select message.id, message.pull_request_id as "pullRequestId", message.kind,
                message.author_login as "authorLogin", message.author_type as "authorType",
                message.body, message.content_hash as "contentHash", message.path,
                message.line, message.side,
                message.commit_sha as "commitSha",
                message.in_reply_to_github_id::text as "inReplyToGithubId",
                message.html_url as "htmlUrl", message.github_created_at as "githubCreatedAt",
                message.github_updated_at as "githubUpdatedAt",
                coalesce(user_state.state, 'available') as state
           from github_pr_messages message
           join pull_requests pull_request on pull_request.id = message.pull_request_id
           left join github_pr_message_user_states user_state
             on user_state.message_id = message.id and user_state.user_id = $3
          where message.repository_id = $1 and pull_request.number = $2
          order by coalesce(user_state.state, 'available') = 'ignored',
                   message.github_created_at, message.github_id`,
        [repoId, number, request.user!.id],
      );
      return {
        schemaVersion,
        repositoryId: repoId,
        pullNumber: number,
        items: result.rows.map(githubSourceView),
      };
    },
  );

  app.patch(
    '/api/v1/repositories/:repoId/pulls/:number/review-memory-sources/:sourceId',
    { preHandler: requireUser },
    async (request, reply) => {
      const { repoId, number, sourceId } = sourceParams.parse(request.params);
      const body = githubPrMemorySourceStateSchema.parse(request.body);
      if (!(await canReadRepository(database, authorization, request, repoId, 'view'))) {
        return hiddenNotFound(request, reply);
      }
      const updated = await database.query<{ id: string }>(
        `insert into github_pr_message_user_states(message_id, user_id, state)
         select message.id, $4, $5 from github_pr_messages message
         join pull_requests pull_request on pull_request.id = message.pull_request_id
         where message.id = $3 and message.repository_id = $1 and pull_request.number = $2
         on conflict (message_id, user_id) do update set
           state = excluded.state, updated_at = clock_timestamp()
         returning message_id as id`,
        [repoId, number, sourceId, request.user!.id, body.state],
      );
      if (!updated.rows[0]) return hiddenNotFound(request, reply);
      return { schemaVersion, id: sourceId, state: body.state };
    },
  );

  app.get(
    '/api/v1/analyses/:analysisId/review-memories',
    { preHandler: requireUser },
    async (request, reply) => {
      const { analysisId } = analysisParams.parse(request.params);
      const context = await authorizedAnalysisContext(database, authorization, request, analysisId);
      if (!context) return hiddenNotFound(request, reply);
      const personal = await database.query<ReviewMemoryRecord>(
        `select ${reviewMemoryColumns} from review_memories
          where tenant_id = $1 and repository_id = $2 and scope = 'personal'
            and owner_user_id = $3 and state in ('candidate', 'active')
          order by state = 'active' desc, updated_at desc, id`,
        [context.tenantId, context.repositoryId, request.user!.id],
      );
      return {
        schemaVersion,
        analysisId,
        memoryHash: context.memoryHash || emptyReviewMemoryHash,
        pinned: context.memoryContext,
        personal: personal.rows.map(memoryView),
      };
    },
  );

  app.post(
    '/api/v1/analyses/:analysisId/review-memory-candidates',
    { preHandler: requireUser },
    async (request, reply) => {
      const { analysisId } = analysisParams.parse(request.params);
      const body = reviewMemoryCandidateCreateSchema.parse(request.body);
      const context = await authorizedAnalysisContext(database, authorization, request, analysisId);
      if (!context) return hiddenNotFound(request, reply);
      const source = await candidateSource(database, request.user!.id, analysisId, body);
      if (!source) return hiddenNotFound(request, reply);
      const connection = await database.connect();
      try {
        await connection.query('begin');
        const memory = await createPersonalReviewMemoryCandidate(connection, {
          tenantId: context.tenantId,
          repositoryId: context.repositoryId,
          ownerUserId: request.user!.id,
          kind: body.kind,
          summary: body.summary,
          detail: body.detail,
          recommendation: body.recommendation,
          categories: body.categories,
          filePaths: body.filePaths,
          symbols: body.symbols,
          confidence: body.confidence,
          importance: body.importance,
          sourceKind: source.kind,
          sourceAnalysisRunId: analysisId,
          ...(source.findingId ? { sourceFindingId: source.findingId } : {}),
          ...(source.chatMessageId ? { sourceChatMessageId: source.chatMessageId } : {}),
          ...(source.githubMessageId ? { sourceGithubPrMessageId: source.githubMessageId } : {}),
          ...(source.githubMessageContentHash
            ? { sourceGithubPrMessageContentHash: source.githubMessageContentHash }
            : {}),
          sourceBaseSha: context.baseSha,
          sourceHeadSha: context.headSha,
          sourceAnchor: source.anchor,
          ...(source.fingerprint ? { sourceFingerprint: source.fingerprint } : {}),
        });
        if (source.githubMessageId) {
          await connection.query(
            `insert into github_pr_message_user_states(message_id, user_id, state)
             values ($1,$2,'saved') on conflict (message_id, user_id) do update set
               state = 'saved', updated_at = clock_timestamp()`,
            [source.githubMessageId, request.user!.id],
          );
        }
        await writeAudit(connection, request, 'review-memory.candidate.create', memory.id, {
          analysisId,
          scope: 'personal',
        });
        await connection.query('commit');
        return reply.code(201).send({ schemaVersion, memory: memoryView(memory) });
      } catch (error) {
        await connection.query('rollback');
        throw error;
      } finally {
        connection.release();
      }
    },
  );

  app.post(
    '/api/v1/review-memories/:memoryId/review',
    { preHandler: requireUser },
    async (request, reply) => {
      const { memoryId } = memoryParams.parse(request.params);
      const body = reviewMemoryReviewSchema.parse(request.body);
      const connection = await database.connect();
      try {
        await connection.query('begin');
        const current = await lockMemory(connection, memoryId);
        if (!current || current.scope !== 'personal' || current.ownerUserId !== request.user!.id) {
          await connection.query('rollback');
          return hiddenNotFound(request, reply);
        }
        const nextState = personalTransition(current, body.action);
        if (!nextState) {
          await connection.query('rollback');
          return invalidTransition(request, reply);
        }
        const edited = editableMemory(current, body, current.state === 'candidate');
        const updated = await updateReviewedMemory(
          connection,
          edited,
          nextState,
          request.user!.id,
          body.note,
        );
        await writeMemoryEvent(connection, updated, request.user!.id, current.state, body.note);
        if (nextState === 'active') {
          await refreshCollectiveReviewMemoryCandidate(
            connection,
            updated.repositoryId,
            updated.aggregationKey,
          );
        }
        await writeAudit(connection, request, `review-memory.${body.action}`, memoryId, {
          scope: 'personal',
          state: nextState,
        });
        await connection.query('commit');
        return { schemaVersion, memory: memoryView(updated) };
      } catch (error) {
        await connection.query('rollback');
        if (isUniqueViolation(error)) return duplicateMemory(request, reply);
        throw error;
      } finally {
        connection.release();
      }
    },
  );

  app.get(
    '/api/v1/admin/review-memories',
    { preHandler: requireAdministrator },
    async (request) => {
      const query = adminListQuery.parse(request.query);
      const result = await database.query<ReviewMemoryRecord>(
        `select ${reviewMemoryColumns} from review_memories
          where ($1::uuid is null or tenant_id = $1)
            and ($2::uuid is null or repository_id = $2)
            and ($3::text is null or scope = $3)
            and ($4::text is null or state = $4)
          order by scope = 'collective' desc, state = 'candidate' desc, updated_at desc
          limit 500`,
        [
          query.tenantId ?? null,
          query.repositoryId ?? null,
          query.scope ?? null,
          query.state ?? null,
        ],
      );
      return { schemaVersion, items: result.rows.map(memoryView) };
    },
  );

  app.post(
    '/api/v1/admin/review-memories/:memoryId/review',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      const { memoryId } = memoryParams.parse(request.params);
      const body = reviewMemoryReviewSchema.parse(request.body);
      const connection = await database.connect();
      try {
        await connection.query('begin');
        const current = await lockMemory(connection, memoryId);
        if (!current || current.scope !== 'collective') {
          await connection.query('rollback');
          return hiddenNotFound(request, reply);
        }
        const nextState = collectiveTransition(current, body.action);
        if (!nextState) {
          await connection.query('rollback');
          return invalidTransition(request, reply);
        }
        if (nextState === 'active' && current.supersedesId) {
          const superseded = await connection.query<ReviewMemoryRecord>(
            `update review_memories set state = 'superseded', reviewed_by = $2,
               reviewed_at = clock_timestamp(), review_note = $3,
               updated_at = clock_timestamp()
             where id = $1 and scope = 'collective' and state = 'active'
             returning ${reviewMemoryColumns}`,
            [current.supersedesId, request.user!.id, body.note],
          );
          if (superseded.rows[0]) {
            await writeMemoryEvent(
              connection,
              superseded.rows[0],
              request.user!.id,
              'active',
              body.note,
            );
          }
        }
        const edited = editableMemory(current, body, current.state === 'candidate');
        const updated = await updateReviewedMemory(
          connection,
          edited,
          nextState,
          request.user!.id,
          body.note,
        );
        await writeMemoryEvent(connection, updated, request.user!.id, current.state, body.note);
        await writeAudit(connection, request, `review-memory.collective.${body.action}`, memoryId, {
          contributorCount: updated.contributorCount,
          conflictCount: updated.conflictCount,
          state: nextState,
        });
        await connection.query('commit');
        return { schemaVersion, memory: memoryView(updated) };
      } catch (error) {
        await connection.query('rollback');
        if (isUniqueViolation(error)) return duplicateMemory(request, reply);
        throw error;
      } finally {
        connection.release();
      }
    },
  );
}

async function authorizedAnalysisContext(
  database: Database,
  authorization: AuthorizationService,
  request: FastifyRequest,
  analysisId: string,
): Promise<AnalysisMemoryContext | null> {
  const result = await database.query<AnalysisMemoryContext>(
    `select repository.tenant_id as "tenantId", repository.id as "repositoryId",
            analysis.memory_owner_user_id as "memoryOwnerUserId",
            analysis.memory_hash as "memoryHash", analysis.memory_context as "memoryContext",
            snapshot_request.base_sha as "baseSha", snapshot_request.head_sha as "headSha"
       from analysis_runs analysis
       join snapshots snapshot on snapshot.id = analysis.snapshot_id
       join snapshot_requests snapshot_request on snapshot_request.id = snapshot.request_id
       join pull_requests pull_request on pull_request.id = snapshot_request.pull_request_id
       join repositories repository on repository.id = pull_request.repository_id
      where analysis.id = $1`,
    [analysisId],
  );
  const context = result.rows[0];
  if (
    !context ||
    (context.memoryOwnerUserId &&
      context.memoryOwnerUserId !== request.user!.id &&
      request.user!.role !== 'administrator') ||
    !(await canReadRepository(database, authorization, request, context.repositoryId, 'view'))
  ) {
    return null;
  }
  return context;
}

async function candidateSource(
  database: Database,
  userId: string,
  analysisId: string,
  body: z.infer<typeof reviewMemoryCandidateCreateSchema>,
): Promise<
  | {
      kind: 'finding' | 'chat-message' | 'github-pr-message';
      findingId?: string;
      chatMessageId?: string;
      githubMessageId?: string;
      githubMessageContentHash?: string;
      anchor: Record<string, unknown>;
      fingerprint?: string;
    }
  | undefined
> {
  if (body.sourceFindingId) {
    const finding = await database.query<{
      id: string;
      anchor: Record<string, unknown>;
      fingerprint: string;
    }>(
      `select finding.id, finding.anchor, finding.fingerprint
         from findings finding join reports report on report.id = finding.report_id
        where finding.id = $1 and report.analysis_run_id = $2`,
      [body.sourceFindingId, analysisId],
    );
    return finding.rows[0]
      ? {
          kind: 'finding',
          findingId: finding.rows[0].id,
          anchor: finding.rows[0].anchor,
          fingerprint: finding.rows[0].fingerprint,
        }
      : undefined;
  }
  if (body.sourceGithubPrMessageId) {
    const message = await database.query<{
      id: string;
      kind: string;
      authorLogin: string;
      path: string | null;
      line: number | null;
      side: string | null;
      commitSha: string | null;
      htmlUrl: string;
      contentHash: string;
    }>(
      `select message.id, message.kind, message.author_login as "authorLogin", message.path,
              message.line, message.side, message.commit_sha as "commitSha",
              message.html_url as "htmlUrl", message.content_hash as "contentHash"
         from github_pr_messages message
         join snapshots snapshot on snapshot.id =
           (select snapshot_id from analysis_runs where id = $2)
         join snapshot_requests request on request.id = snapshot.request_id
        where message.id = $1 and message.pull_request_id = request.pull_request_id`,
      [body.sourceGithubPrMessageId, analysisId],
    );
    return message.rows[0]
      ? {
          kind: 'github-pr-message',
          githubMessageId: message.rows[0].id,
          githubMessageContentHash: message.rows[0].contentHash,
          anchor: {
            kind: message.rows[0].kind,
            authorLogin: message.rows[0].authorLogin,
            path: message.rows[0].path,
            line: message.rows[0].line,
            side: message.rows[0].side,
            commitSha: message.rows[0].commitSha,
            htmlUrl: message.rows[0].htmlUrl,
          },
        }
      : undefined;
  }
  const message = await database.query<{
    id: string;
    role: string;
    scope: Record<string, unknown>;
  }>(
    `select message.id, message.role, session.scope
       from chat_messages message
       join chat_sessions session on session.id = message.session_id
      where message.id = $1 and session.analysis_run_id = $2 and session.user_id = $3
        and message.status = 'completed'`,
    [body.sourceChatMessageId, analysisId, userId],
  );
  return message.rows[0]
    ? {
        kind: 'chat-message',
        chatMessageId: message.rows[0].id,
        anchor: { ...message.rows[0].scope, role: message.rows[0].role },
      }
    : undefined;
}

type GitHubPrMemorySourceRow = {
  id: string;
  pullRequestId: string;
  kind: 'issue-comment' | 'review' | 'review-comment';
  authorLogin: string;
  authorType: string;
  body: string;
  contentHash: string;
  path: string | null;
  line: number | null;
  side: 'LEFT' | 'RIGHT' | null;
  commitSha: string | null;
  inReplyToGithubId: string | null;
  htmlUrl: string;
  githubCreatedAt: Date | string;
  githubUpdatedAt: Date | string;
  state: 'available' | 'saved' | 'ignored';
};

function githubSourceView(source: GitHubPrMemorySourceRow) {
  return {
    ...source,
    githubCreatedAt: dateString(source.githubCreatedAt)!,
    githubUpdatedAt: dateString(source.githubUpdatedAt)!,
  };
}

async function lockMemory(
  database: Pick<DatabaseClient, 'query'>,
  memoryId: string,
): Promise<ReviewMemoryRecord | undefined> {
  return (
    await database.query<ReviewMemoryRecord>(
      `select ${reviewMemoryColumns} from review_memories where id = $1 for update`,
      [memoryId],
    )
  ).rows[0];
}

function personalTransition(
  memory: ReviewMemoryRecord,
  action: z.infer<typeof reviewMemoryReviewSchema>['action'],
): ReviewMemoryRecord['state'] | null {
  if (memory.state === 'candidate' && action === 'activate') return 'active';
  if (memory.state === 'candidate' && action === 'reject') return 'rejected';
  if (memory.state === 'active' && action === 'retire') return 'retired';
  return null;
}

function collectiveTransition(
  memory: ReviewMemoryRecord,
  action: z.infer<typeof reviewMemoryReviewSchema>['action'],
): ReviewMemoryRecord['state'] | null {
  return personalTransition(memory, action);
}

function editableMemory(
  current: ReviewMemoryRecord,
  body: z.infer<typeof reviewMemoryReviewSchema>,
  editable: boolean,
): ReviewMemoryRecord {
  if (!editable) return current;
  const updated = {
    ...current,
    summary: body.summary ?? current.summary,
    detail: body.detail ?? current.detail,
    recommendation: body.recommendation ?? current.recommendation,
    categories: body.categories ?? current.categories,
    filePaths: body.filePaths ?? current.filePaths,
    symbols: body.symbols ?? current.symbols,
    confidence: body.confidence ?? current.confidence,
    importance: body.importance ?? current.importance,
  };
  return {
    ...updated,
    contentHash: reviewMemoryContentHash(updated),
    searchText: buildReviewMemorySearchText(updated),
  };
}

async function updateReviewedMemory(
  database: Pick<DatabaseClient, 'query'>,
  memory: ReviewMemoryRecord,
  state: ReviewMemoryRecord['state'],
  reviewerId: string,
  note: string,
): Promise<ReviewMemoryRecord> {
  const result = await database.query<ReviewMemoryRecord>(
    `update review_memories set state = $2, summary = $3, detail = $4,
       recommendation = $5, categories = $6, file_paths = $7, symbols = $8,
       search_text = $9, content_hash = $10, confidence = $11, importance = $12,
       reviewed_by = $13, reviewed_at = clock_timestamp(), review_note = $14,
       updated_at = clock_timestamp() where id = $1 returning ${reviewMemoryColumns}`,
    [
      memory.id,
      state,
      memory.summary,
      memory.detail,
      memory.recommendation,
      memory.categories,
      memory.filePaths,
      memory.symbols,
      memory.searchText,
      memory.contentHash,
      memory.confidence,
      memory.importance,
      reviewerId,
      note,
    ],
  );
  return result.rows[0]!;
}

async function writeMemoryEvent(
  database: Pick<DatabaseClient, 'query'>,
  memory: ReviewMemoryRecord,
  actorUserId: string,
  beforeState: ReviewMemoryRecord['state'],
  note: string,
): Promise<void> {
  if (memory.state === 'candidate') throw new Error('Candidate review event is invalid');
  const action = {
    active: 'activated',
    rejected: 'rejected',
    retired: 'retired',
    superseded: 'superseded',
  }[memory.state];
  await database.query(
    `insert into review_memory_events(
       memory_id, action, actor_user_id, before_state, after_state, revision, note)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [memory.id, action, actorUserId, beforeState, memory.state, memory.revision, note],
  );
}

function memoryView(memory: ReviewMemoryRecord) {
  const { searchText, ...visible } = memory;
  void searchText;
  return {
    ...visible,
    reviewedAt: dateString(memory.reviewedAt),
    createdAt: dateString(memory.createdAt)!,
    updatedAt: dateString(memory.updatedAt)!,
  };
}

function dateString(value: Date | string | null): string | null {
  return value instanceof Date ? value.toISOString() : value;
}

async function writeAudit(
  database: Pick<DatabaseClient, 'query'>,
  request: FastifyRequest,
  action: string,
  resourceId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await database.query(
    `insert into audit_events(actor, action, resource_type, resource_id, outcome, request_id, metadata)
     values ($1,$2,'review-memory',$3,'success',$4,$5::jsonb)`,
    [request.user!.subject, action, resourceId, request.id, JSON.stringify(metadata)],
  );
}

function hiddenNotFound(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(404).send({
    error: {
      code: 'RESOURCE_NOT_FOUND',
      message: '리소스를 찾을 수 없습니다.',
      requestId: request.id,
      retryable: false,
    },
  });
}

function invalidTransition(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(409).send({
    error: {
      code: 'INVALID_MEMORY_TRANSITION',
      message: '현재 상태에서는 요청한 메모리 작업을 수행할 수 없습니다.',
      requestId: request.id,
      retryable: false,
    },
  });
}

function duplicateMemory(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(409).send({
    error: {
      code: 'REVIEW_MEMORY_EXISTS',
      message: '같은 내용의 활성 메모리가 이미 있습니다.',
      requestId: request.id,
      retryable: false,
    },
  });
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505');
}
