import { FilesystemArtifactStore } from '@gcr/artifact-store';
import { schemaVersion } from '@gcr/contracts';
import type { Database } from '@gcr/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/index.js';
import { EventHub, formatServerSentEvent } from '../events/index.js';
import { canReadRepository } from './worklist.js';
import { requestPullRefresh } from '../services/operations.js';

const repositoryPullParams = z.object({
  repoId: z.string().uuid(),
  number: z.coerce.number().int().positive(),
});
const idParams = z.object({ id: z.string().uuid() });

export async function registerSnapshotRoutes(
  app: FastifyInstance,
  database: Database,
  eventHub: EventHub,
  artifacts: FilesystemArtifactStore,
) {
  app.post(
    '/api/v1/repositories/:repoId/pulls/:number/refresh',
    { preHandler: requireUser },
    async (request, reply) => {
      const { repoId, number } = repositoryPullParams.parse(request.params);
      if (!(await canReadRepository(database, request, repoId)))
        return hiddenNotFound(request, reply);
      const active = await database.query<{ count: string }>(
        `select count(*)::text as count from operations
         where requested_by = $1 and state in ('queued','polling','materializing','analyzing')`,
        [request.user!.id],
      );
      if (Number(active.rows[0]?.count ?? 0) >= 5) {
        return reply.code(429).send({
          error: {
            code: 'REFRESH_LIMIT_EXCEEDED',
            message: '진행 중인 새로고침이 너무 많습니다.',
            requestId: request.id,
            retryable: true,
          },
        });
      }
      const operation = await requestPullRefresh(database, repoId, number, request.user!.id);
      if (!operation) return hiddenNotFound(request, reply);
      return reply.code(202).send({
        schemaVersion,
        operationId: operation.id,
        state: operation.state,
        deduplicated: operation.deduplicated,
        eventsUrl: `/api/v1/repositories/${repoId}/pulls/${number}/events`,
      });
    },
  );

  app.get(
    '/api/v1/repositories/:repoId/pulls/:number/analyses',
    { preHandler: requireUser },
    async (request, reply) => {
      const { repoId, number } = repositoryPullParams.parse(request.params);
      if (!(await canReadRepository(database, request, repoId)))
        return hiddenNotFound(request, reply);
      const result = await database.query(
        `select ar.id, ar.snapshot_id as "snapshotId", ar.revision, ar.state, ar.stage, ar.progress,
                ar.created_at as "createdAt", s.resolution, s.merge_base_sha as "mergeBaseSha",
                sr.base_sha as "baseSha", sr.head_sha as "headSha"
         from pull_requests pr
         join snapshot_requests sr on sr.pull_request_id = pr.id
         join snapshots s on s.request_id = sr.id
         left join analysis_runs ar on ar.snapshot_id = s.id
         where pr.repository_id = $1 and pr.number = $2
         order by s.created_at desc limit 20`,
        [repoId, number],
      );
      return { schemaVersion, items: result.rows };
    },
  );

  app.get(
    '/api/v1/repositories/:repoId/pulls/:number/events',
    { preHandler: requireUser },
    async (request, reply) => {
      const { repoId, number } = repositoryPullParams.parse(request.params);
      if (!(await canReadRepository(database, request, repoId)))
        return hiddenNotFound(request, reply);
      const pull = await database.query<{ id: string }>(
        'select id from pull_requests where repository_id = $1 and number = $2',
        [repoId, number],
      );
      if (!pull.rows[0]) return hiddenNotFound(request, reply);
      const lastEventId = Number(request.headers['last-event-id'] ?? 0);
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      reply.raw.write(': connected\n\n');
      const unsubscribe = await eventHub.subscribe(
        'pull_request',
        pull.rows[0].id,
        Number.isSafeInteger(lastEventId) ? lastEventId : 0,
        (event) => reply.raw.write(formatServerSentEvent(event)),
      );
      const keepalive = setInterval(() => reply.raw.write(': keepalive\n\n'), 15_000);
      request.raw.once('close', () => {
        clearInterval(keepalive);
        unsubscribe();
      });
    },
  );

  app.get('/api/v1/operations/:id', { preHandler: requireUser }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const result = await database.query<{
      repository_id: string;
      id: string;
      type: string;
      state: string;
      result: Record<string, unknown> | null;
      error: Record<string, unknown> | null;
      started_at: Date | null;
      finished_at: Date | null;
    }>(
      `select o.*, pr.repository_id
       from operations o join pull_requests pr on pr.id = o.scope_id
       where o.id = $1 and o.scope_type = 'pull_request'`,
      [id],
    );
    const row = result.rows[0];
    if (!row || !(await canReadRepository(database, request, row.repository_id))) {
      return hiddenNotFound(request, reply);
    }
    return {
      schemaVersion,
      id: row.id,
      type: row.type,
      state: row.state,
      result: row.result,
      error: row.error,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  });

  app.get('/api/v1/snapshots/:id/files', { preHandler: requireUser }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!(await canReadSnapshot(database, request, id))) return hiddenNotFound(request, reply);
    const result = await database.query(
      `select id, path, previous_path as "previousPath", status, additions, deletions
       from snapshot_files where snapshot_id = $1 order by path`,
      [id],
    );
    return { schemaVersion, snapshotId: id, items: result.rows };
  });

  app.get('/api/v1/snapshots/:id/diff', { preHandler: requireUser }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!(await canReadSnapshot(database, request, id))) return hiddenNotFound(request, reply);
    const locator = await artifactLocator(database, id, 'diff-index');
    if (!locator) return artifactUnavailable(request, reply);
    return artifacts.readJson(locator);
  });

  app.get('/api/v1/snapshots/:id/commits', { preHandler: requireUser }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!(await canReadSnapshot(database, request, id))) return hiddenNotFound(request, reply);
    const locator = await artifactLocator(database, id, 'commits');
    if (!locator) return artifactUnavailable(request, reply);
    return artifacts.readJson(locator);
  });
}

async function canReadSnapshot(database: Database, request: FastifyRequest, snapshotId: string) {
  const result = await database.query<{ repository_id: string }>(
    `select pr.repository_id from snapshots s
     join snapshot_requests sr on sr.id = s.request_id
     join pull_requests pr on pr.id = sr.pull_request_id where s.id = $1`,
    [snapshotId],
  );
  return result.rows[0]
    ? canReadRepository(database, request, result.rows[0].repository_id)
    : false;
}

async function artifactLocator(database: Database, snapshotId: string, type: string) {
  const result = await database.query<{ locator: string }>(
    `select locator from artifacts
     where scope_type = 'snapshot' and scope_id = $1 and artifact_type = $2 and version = 1`,
    [snapshotId, type],
  );
  return result.rows[0]?.locator ?? null;
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

function artifactUnavailable(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(503).send({
    error: {
      code: 'ARTIFACT_UNAVAILABLE',
      message: '분석 산출물을 읽을 수 없습니다.',
      requestId: request.id,
      retryable: true,
    },
  });
}
