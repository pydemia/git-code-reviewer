import { registerHistoryReadRoutes } from './review-history-read.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '@gcr/db';
import { z } from 'zod';
import { requireUser } from '../auth/index.js';
import type { AuthorizationService } from '../services/authorization.js';
import { knowledgeUserAllowed } from '../services/knowledge-projection.js';
import { CriterionError, criteriaNotFound } from '../services/review-criteria.js';
import {
  createHistoryCollection,
  readHistoryCollection,
} from '../services/review-history-collection.js';
import { canReadRepository } from './worklist.js';
const repoParams = z.object({ repoId: z.string().uuid() });
const collectionParams = repoParams.extend({ collectionId: z.string().uuid() });
export async function registerReviewHistoryRoutes(
  app: FastifyInstance,
  database: Database,
  authorization: AuthorizationService,
) {
  const authorize = async (
    request: FastifyRequest,
    repoId: string,
    role: 'reader' | 'maintainer' = 'reader',
  ) => {
    if (
      !(await canReadRepository(database, authorization, request, repoId, 'view')) ||
      !(await knowledgeUserAllowed(database, repoId, request.user!.id, role))
    )
      throw criteriaNotFound();
  };
  await app.register(async (routes) => {
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('cache-control', 'private, no-store').header('vary', 'Cookie, Authorization');
    });
    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof CriterionError)
        return reply.code(error.statusCode).send({
          error: {
            code: error.code,
            message: error.message,
            requestId: request.id,
            retryable: error.statusCode === 409,
          },
        });
      if (error instanceof z.ZodError)
        return reply.code(400).send({
          error: {
            code: 'INVALID_HISTORY_REQUEST',
            message: '리뷰 이력 요청 형식을 확인해 주세요.',
            requestId: request.id,
            retryable: false,
          },
        });
      throw error;
    });
    const base = '/api/v1/repositories/:repoId/review-history';
    await registerHistoryReadRoutes(routes, database, authorize);
    routes.post(`${base}/collections`, { preHandler: requireUser }, async (request, reply) => {
      const { repoId } = repoParams.parse(request.params);
      await authorize(request, repoId, 'maintainer');
      const input = z
        .object({
          requestKey: z.string().uuid(),
          pullNumbers: z.array(z.number().int().positive().max(2147483647)).min(1).max(20),
        })
        .strict()
        .parse(request.body);
      const c = await database.connect();
      let id: string;
      try {
        await c.query('begin');
        id = await createHistoryCollection(c, repoId, request.user!.id, input);
        await c.query(
          "insert into audit_events(actor,action,resource_type,resource_id,outcome,request_id) values($1,'review-history.collect','review-history-collection',$2,'success',$3)",
          [request.user!.id, id, request.id],
        );
        await c.query('commit');
      } catch (error) {
        await c.query('rollback');
        throw error;
      } finally {
        c.release();
      }
      return reply.code(202).send(await readHistoryCollection(database, repoId, id));
    });
    routes.get(
      `${base}/collections/:collectionId`,
      { preHandler: requireUser, config: { clientKnowledgeRead: true } },
      async (request) => {
        const { repoId, collectionId } = collectionParams.parse(request.params);
        z.object({}).strict().parse(request.query);
        await authorize(request, repoId);
        return readHistoryCollection(database, repoId, collectionId);
      },
    );
    routes.post(
      `${base}/collections/:collectionId/retry`,
      { preHandler: requireUser },
      async (request) => {
        const { repoId, collectionId } = collectionParams.parse(request.params);
        z.object({})
          .strict()
          .parse(request.body ?? {});
        await authorize(request, repoId, 'maintainer');
        await readHistoryCollection(database, repoId, collectionId);
        await database.query(
          `update jobs j set state='queued',available_at=clock_timestamp(),max_attempts=attempt_count+3,recovery_count=0,updated_at=clock_timestamp()
        from review_history_collection_items i where i.job_id=j.id and i.collection_id=$1 and i.completed_at is null and j.state='failed' and j.type='history.collect'`,
          [collectionId],
        );
        return readHistoryCollection(database, repoId, collectionId);
      },
    );
  });
}
