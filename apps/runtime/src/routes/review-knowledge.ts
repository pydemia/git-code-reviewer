import type { Database } from '@gcr/db';
import type { FilesystemArtifactStore } from '@gcr/artifact-store';
import { centralMemoryContent, ContractError } from '@gcr/client-contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/index.js';
import type { AuthorizationService } from '../services/authorization.js';
import { canReadRepository } from './worklist.js';
import { CriterionError, criteriaNotFound } from '../services/review-criteria.js';
import {
  issueKnowledgeManifest,
  downloadKnowledgeBundle,
  type KnowledgeSigner,
} from '../services/knowledge-manifest.js';
import {
  approveKnowledgeMemory,
  knowledgeUserAllowed,
  knowledgeMemoryApprovalFingerprint,
} from '../services/knowledge-projection.js';
import { reviewMemoryColumns, type ReviewMemoryRecord } from '../services/review-memory.js';

const repositoryParams = z.object({ repoId: z.string().uuid() });
const memoryParams = repositoryParams.extend({ memoryId: z.string().uuid() });
export async function registerKnowledgeRoutes(
  app: FastifyInstance,
  database: Database,
  authorization: AuthorizationService,
  store: FilesystemArtifactStore,
  signer?: KnowledgeSigner,
) {
  const authorize = async (request: FastifyRequest, repoId: string) => {
    if (!(await canReadRepository(database, authorization, request, repoId)))
      throw criteriaNotFound();
    if (!signer)
      throw new CriterionError(
        503,
        'KNOWLEDGE_DISTRIBUTION_DISABLED',
        '리뷰 지식 배포가 활성화되지 않았습니다.',
      );
    return signer;
  };
  await app.register(async (routes) => {
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('cache-control', 'private, no-store').header('vary', 'Cookie, Authorization');
    });
    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof CriterionError)
        return reply
          .code(error.statusCode)
          .send({
            error: {
              code: error.code,
              message: error.message,
              requestId: request.id,
              retryable: [409, 503].includes(error.statusCode),
            },
          });
      if (error instanceof ContractError || error instanceof z.ZodError)
        return reply
          .code(400)
          .send({
            error: {
              code: 'INVALID_KNOWLEDGE_REQUEST',
              message: '리뷰 지식 요청 형식을 확인해 주세요.',
              requestId: request.id,
              retryable: false,
            },
          });
      if ((error as { code?: string }).code === '40001')
        return reply
          .code(409)
          .send({
            error: {
              code: 'KNOWLEDGE_SNAPSHOT_STALE',
              message: '권한이 변경됐습니다. 다시 요청해 주세요.',
              requestId: request.id,
              retryable: true,
            },
          });
      throw error;
    });
    const base = '/api/v1/repositories/:repoId/review-knowledge';
    routes.get(`${base}/manifest`, { preHandler: requireUser }, async (request, reply) => {
      const { repoId } = repositoryParams.parse(request.params);
      const activeSigner = await authorize(request, repoId);
      const query = z.object({ clientContractVersion: z.string() }).strict().parse(request.query);
      if (query.clientContractVersion !== '1')
        throw new CriterionError(
          426,
          'KNOWLEDGE_CLIENT_UPGRADE_REQUIRED',
          '지원하지 않는 지식 배포 contract 버전입니다.',
        );
      const manifest = await issueKnowledgeManifest(
        database,
        store,
        activeSigner,
        repoId,
        request.user!.id,
      );
      const etag = `"${manifest.manifestHash}"`;
      reply.header('etag', etag);
      // Authorization, complete snapshot readiness and artifact integrity precede 304.
      const condition = request.headers['if-none-match'];
      if (
        typeof condition === 'string' &&
        condition
          .split(',')
          .some((item) => item.trim() === '*' || item.trim().replace(/^W\//, '') === etag)
      )
        return reply.code(304).send();
      return manifest;
    });
    routes.get(`${base}/bundles/:bundleId`, { preHandler: requireUser }, async (request, reply) => {
      const { repoId, bundleId } = repositoryParams
        .extend({ bundleId: z.string().uuid() })
        .parse(request.params);
      await authorize(request, repoId);
      const { snapshotId } = z
        .object({ snapshotId: z.string().uuid() })
        .strict()
        .parse(request.query);
      const result = await downloadKnowledgeBundle(
        database,
        store,
        repoId,
        request.user!.id,
        snapshotId,
        bundleId,
      );
      return reply
        .type('application/json; charset=utf-8')
        .header('etag', `"${result.contentHash}"`)
        .send(result.bytes);
    });
    routes.get(`${base}/status`, { preHandler: requireUser }, async (request) => {
      const { repoId } = repositoryParams.parse(request.params);
      await authorize(request, repoId);
      if (!(await knowledgeUserAllowed(database, repoId, request.user!.id, 'reader')))
        throw criteriaNotFound();
      const result = await database.query(
        `select component,requested_revision as "requestedRevision",published_revision as "publishedRevision",release_sequence as "releaseSequence",current_release_id as "bundleId",last_error as "lastError",updated_at as "updatedAt"
    from review_knowledge_scopes where repository_id=$1 and (component in ('policy','collective') or (component='personal' and owner_user_id=$2)) order by component`,
        [repoId, request.user!.id],
      );
      return { schemaVersion: 1, components: result.rows };
    });
    routes.get(
      `${base}/memories/:memoryId/projection`,
      { preHandler: requireUser },
      async (request) => {
        const { repoId, memoryId } = memoryParams.parse(request.params);
        await authorize(request, repoId);
        const c = await database.connect();
        try {
          await c.query('begin isolation level repeatable read read only');
          const memory = (
            await c.query<ReviewMemoryRecord>(
              `select ${reviewMemoryColumns} from review_memories where repository_id=$1 and id=$2`,
              [repoId, memoryId],
            )
          ).rows[0];
          if (
            !memory ||
            (memory.scope === 'personal' && memory.ownerUserId !== request.user!.id) ||
            !(await knowledgeUserAllowed(
              c,
              repoId,
              request.user!.id,
              memory.scope === 'personal' ? 'reader' : 'maintainer',
            ))
          )
            throw criteriaNotFound();
          const fingerprint = await knowledgeMemoryApprovalFingerprint(c, memory);
          const projection =
            (
              await c.query(
                'select revision,source_fingerprint as "sourceFingerprint",content,approved_at as "approvedAt" from review_knowledge_memory_projections where memory_id=$1',
                [memoryId],
              )
            ).rows[0] ?? null;
          await c.query('commit');
          return {
            schemaVersion: 1,
            memoryId,
            scope: memory.scope,
            state: memory.state,
            reviewed: !!memory.reviewedBy,
            fingerprint,
            projection,
          };
        } catch (error) {
          await c.query('rollback');
          throw error;
        } finally {
          c.release();
        }
      },
    );
    routes.post(
      `${base}/memories/:memoryId/projection`,
      { preHandler: requireUser },
      async (request, reply) => {
        const { repoId, memoryId } = memoryParams.parse(request.params);
        await authorize(request, repoId);
        const input = z
          .object({ expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/), content: z.unknown() })
          .strict()
          .parse(request.body);
        const content = centralMemoryContent(input.content);
        const c = await database.connect();
        try {
          await c.query('begin');
          await approveKnowledgeMemory(
            c,
            repoId,
            request.user!.id,
            memoryId,
            input.expectedFingerprint,
            content,
          );
          await c.query('commit');
          return reply.code(201).send({ schemaVersion: 1, memoryId });
        } catch (error) {
          await c.query('rollback');
          throw error;
        } finally {
          c.release();
        }
      },
    );
  });
}
