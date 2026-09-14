import { createHash } from 'node:crypto';
import type { Database } from '@gcr/db';
import {
  ContractError,
  reviewSubmissionJson,
  reviewSubmission,
  reviewSubmissionReceipt,
  REVIEW_SUBMISSION_RETENTION_MS,
  type ReviewSubmission,
} from '@gcr/client-contract';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/index.js';
import { authenticateClientKey, ClientCredentialError } from '../auth/client-credentials.js';
import type { AppConfig } from '../config.js';
import type { AuthorizationService } from '../services/authorization.js';
import { canReadRepository } from './worklist.js';
import { CriterionError } from '../services/review-criteria.js';
import {
  submissionIntakeAccess,
  reviewSubmissionIntake,
  intakeDecisionSelect,
  intakeDecisionJoins,
} from '../services/review-submission-intake.js';

const params = z.object({ repoId: z.string().uuid() });
type Row = {
  id: string;
  request_id: string;
  payload_hash: string;
  payload: ReviewSubmission;
  received_at: Date;
  expires_at: Date;
};
const receipt = (row: Row) =>
  reviewSubmissionReceipt({
    schemaVersion: 1,
    id: row.id,
    requestId: row.request_id,
    payloadHash: row.payload_hash,
    audience: row.payload.audience,
    clientId: row.payload.clientId,
    kind: row.payload.kind,
    status: 'submitted',
    evidence: 'client-reported',
    receivedAt: row.received_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  });
class SubmissionError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export async function registerReviewSubmissionRoutes(
  app: FastifyInstance,
  database: Database,
  config: AppConfig,
  authorization: AuthorizationService,
) {
  await app.register(async (routes) => {
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('cache-control', 'private, no-store').header('vary', 'Cookie, Authorization');
    });
    routes.setErrorHandler((error, request, reply) => {
      if (
        error instanceof SubmissionError ||
        error instanceof CriterionError ||
        error instanceof ClientCredentialError ||
        error instanceof ContractError ||
        error instanceof z.ZodError
      )
        return reply.code('statusCode' in error ? error.statusCode : 400).send({
          error: {
            code: 'code' in error ? error.code : 'INVALID_REVIEW_SUBMISSION',
            message:
              error instanceof CriterionError
                ? error.message
                : '리뷰 제출 요청을 처리하지 못했습니다.',
            requestId: request.id,
          },
        });
      if (['40001', '23505', '40P01', '55P03'].includes((error as { code?: string }).code ?? ''))
        return reply.code(409).send({ error: { code: 'SUBMISSION_AUTHORIZATION_CHANGED' } });
      throw error;
    });
    const base = '/api/v1/repositories/:repoId/review-submissions';
    for (const kind of ['result', 'feedback'] as const) {
      const requiredScope = kind === 'result' ? 'reviews:submit' : 'feedback:submit';
      routes.post(
        `${base}/${kind === 'result' ? 'results' : 'feedback'}`,
        {
          bodyLimit: 32768,
          preHandler: requireUser,
          config: { clientSubmissionScope: requiredScope },
        },
        async (request, reply) => {
          if (!request.clientPrincipal)
            throw new ClientCredentialError(401, 'CLIENT_AUTHENTICATION_REQUIRED');
          const { repoId } = params.parse(request.params);
          const input = reviewSubmission(request.body);
          if (input.kind !== kind) throw new SubmissionError(400, 'INVALID_REVIEW_SUBMISSION');
          const approved = Date.parse(input.approvedAt);
          if (
            approved > Date.now() + 60000 ||
            approved < Date.now() - REVIEW_SUBMISSION_RETENTION_MS
          )
            throw new SubmissionError(409, 'SUBMISSION_APPROVAL_EXPIRED');
          if (!(await canReadRepository(database, authorization, request, repoId)))
            throw new SubmissionError(403, 'CLIENT_SCOPE_DENIED');
          const c = await database.connect();
          try {
            await c.query('begin isolation level serializable');
            await c.query("set local lock_timeout='5s'");
            // Recheck the actual credential inside the write transaction. A request
            // does not inherit a prior sync's cached authorization or browser session.
            await c.query('select id from client_api_keys where id=$1 for update', [
              request.clientPrincipal.keyId,
            ]);
            const principal = await authenticateClientKey(c, {
              authorization: request.headers.authorization!,
              serverId: config.KNOWLEDGE_SERVER_ID!,
              requestedServerId: String(request.headers['x-gcr-server-id']),
              authMode: config.AUTH_MODE,
              repositoryId: repoId,
              requiredScope,
            });
            if (
              input.clientId !== principal.clientId ||
              input.audience.serverId !== config.KNOWLEDGE_SERVER_ID ||
              input.audience.tenantId !== principal.tenantId ||
              input.audience.repositoryId !== repoId ||
              input.audience.userId !== principal.user.id
            )
              throw new SubmissionError(403, 'CLIENT_AUDIENCE_MISMATCH');
            const binding = [
              input.audience.serverId,
              principal.tenantId,
              repoId,
              principal.user.id,
              principal.clientId,
              input.id,
            ];
            const hash = createHash('sha256').update(reviewSubmissionJson(input)).digest('hex');
            // Stable across credential rotation, scoped to server/tenant/repo/user/client.
            await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
              createHash('sha256').update(JSON.stringify(binding)).digest('hex'),
            ]);
            const existing = (
              await c.query<Row>(
                'select * from client_review_submissions where server_id=$1 and tenant_id=$2 and repository_id=$3 and owner_user_id=$4 and client_id=$5 and request_id=$6',
                binding,
              )
            ).rows[0];
            if (existing) {
              if (existing.payload_hash !== hash)
                throw new SubmissionError(409, 'SUBMISSION_ID_CONFLICT');
              if (existing.expires_at.getTime() <= Date.now())
                throw new SubmissionError(410, 'SUBMISSION_EXPIRED');
              await c.query('commit');
              return reply.code(200).send(receipt(existing));
            }
            if (input.kind === 'feedback' && input.feedback.rule) {
              const rule = input.feedback.rule;
              const found = await c.query(
                'select 1 from review_rule_revisions where rule_id=$1 and repository_id=$2 and revision=$3',
                [z.string().uuid().parse(rule.id), repoId, rule.revision],
              );
              if (!found.rowCount) throw new SubmissionError(400, 'INVALID_SUBMISSION_RULE');
            }
            if (input.review.snapshot) {
              const found = (
                await c.query<{
                  owner_user_id: string;
                  repository_id: string;
                  manifest_hash: string;
                }>(
                  'select owner_user_id,repository_id,manifest_hash from review_knowledge_manifests where id=$1',
                  [z.string().uuid().parse(input.review.snapshot.id)],
                )
              ).rows[0];
              if (
                found &&
                (found.owner_user_id !== principal.user.id ||
                  found.repository_id !== repoId ||
                  found.manifest_hash !== input.review.snapshot.hash)
              )
                throw new SubmissionError(400, 'INVALID_SUBMISSION_SNAPSHOT');
              // An expired manifest may already be pruned. Its reference remains
              // client-reported, never trusted review or execution evidence.
            }
            const count = await c.query<{ count: string }>(
              "select count(*) from client_review_submissions where owner_user_id=$1 and received_at>statement_timestamp()-interval '1 day'",
              [principal.user.id],
            );
            if (Number(count.rows[0]!.count) >= 1000)
              throw new SubmissionError(429, 'SUBMISSION_RATE_LIMIT');
            const row = (
              await c.query<Row>(
                `insert into client_review_submissions(server_id,tenant_id,repository_id,owner_user_id,client_id,request_id,kind,payload_hash,payload) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) returning *`,
                [...binding, kind, hash, JSON.stringify(input)],
              )
            ).rows[0]!;
            await c.query(
              "insert into audit_events(actor,action,resource_type,resource_id,outcome,request_id) values($1,$2,'client-review-submission',$3,'success',$4)",
              [principal.user.id, `client-${kind}.submit`, row.id, request.id],
            );
            await c.query('commit');
            return reply.code(201).send(receipt(row));
          } catch (error) {
            await c.query('rollback');
            throw error;
          } finally {
            c.release();
          }
        },
      );
    }
    routes.post(
      `${base}/:submissionId/review`,
      { preHandler: requireUser, bodyLimit: 1048576 },
      async (request) => {
        const { repoId, submissionId } = params
          .extend({ submissionId: z.string().uuid() })
          .parse(request.params);
        return reviewSubmissionIntake(
          database,
          request,
          authorization,
          repoId,
          submissionId,
          request.body,
        );
      },
    );
    routes.get(base, { preHandler: requireUser }, async (request) => {
      const { repoId } = params.parse(request.params);
      const capabilities = await submissionIntakeAccess(database, request, authorization, repoId);
      const { cursor } = z
        .object({ cursor: z.string().uuid().optional() })
        .strict()
        .parse(request.query);
      const rows = (
        await database.query<Row & { decision: unknown }>(
          `select s.*, ${intakeDecisionSelect} from client_review_submissions s ${intakeDecisionJoins} where s.repository_id=$1 and s.expires_at>clock_timestamp() and ($2::uuid is null or s.id>$2) order by s.id limit 101`,
          [repoId, cursor ?? null],
        )
      ).rows;
      return {
        schemaVersion: 1,
        capabilities,
        items: rows
          .slice(0, 100)
          .map((row) => ({
            receipt: receipt(row),
            submission: reviewSubmission(row.payload),
            decision: row.decision,
          })),
        nextCursor: rows.length > 100 ? rows[99]!.id : null,
      };
    });
  });
}
