import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '@gcr/db';
import { z } from 'zod';
import {
  reviewHistoryPullListSchema,
  reviewHistoryMessageListSchema,
  reviewHistoryMessageDetailSchema,
} from '@gcr/contracts';
import {
  withHistoryRead,
  historyRevision,
  historyPull,
  historyMessage,
  historyObservations,
  historyBodyVersions,
  historyCursor,
  readHistoryCursor,
} from '../services/review-history.js';
import { requireUser } from '../auth/index.js';
import { knowledgeUserAllowed } from '../services/knowledge-projection.js';
import { CriterionError } from '../services/review-criteria.js';
export async function registerHistoryReadRoutes(
  routes: FastifyInstance,
  database: Database,
  authorize: (request: FastifyRequest, repoId: string) => Promise<void>,
) {
  const base = '/api/v1/repositories/:repoId/review-history';
  const repoParams = z.object({ repoId: z.string().uuid() });
  const pullParams = repoParams.extend({
    number: z.coerce.number().int().positive().max(2147483647),
  });
  const messageParams = pullParams.extend({ sourceId: z.string().uuid() });
  const pageQuery = z
    .object({
      cursor: z.string().max(2048).optional(),
      revision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    })
    .strict();
  const options = { preHandler: requireUser, config: { clientKnowledgeRead: true } };
  routes.get(base, options, async (request) => {
    const { repoId } = repoParams.parse(request.params);
    const query = pageQuery
      .extend({ pullNumber: z.coerce.number().int().positive().max(2147483647).optional() })
      .strict()
      .parse(request.query);
    await authorize(request, repoId);
    return withHistoryRead(database, async (c) => {
      const revision = await historyRevision(c, repoId),
        scope = `pulls:${query.pullNumber ?? ''}`;
      const raw = readHistoryCursor(query.cursor, repoId, scope, revision, query.revision),
        last = raw === null ? null : z.coerce.number().int().positive().max(2147483647).parse(raw);
      const rows = (
        await c.query(
          'select number from pull_requests where repository_id=$1 and ($2::int is null or number<$2) and ($3::int is null or number=$3) order by number desc limit $4',
          [repoId, last, query.pullNumber ?? null, query.limit + 1],
        )
      ).rows;
      const items = [];
      for (const row of rows.slice(0, query.limit))
        items.push(await historyPull(c, repoId, row.number));
      return reviewHistoryPullListSchema.parse({
        schemaVersion: 1,
        repositoryId: repoId,
        revision,
        items,
        nextCursor:
          rows.length > query.limit
            ? historyCursor(repoId, scope, revision, String(rows[query.limit - 1].number))
            : null,
        capabilities: {
          manage: await knowledgeUserAllowed(c, repoId, request.user!.id, 'maintainer'),
        },
      });
    });
  });
  routes.get(`${base}/pulls/:number/messages`, options, async (request) => {
    const { repoId, number } = pullParams.parse(request.params);
    const query = pageQuery
      .extend({ parentId: z.string().uuid().optional() })
      .strict()
      .parse(request.query);
    await authorize(request, repoId);
    return withHistoryRead(database, async (c) => {
      const pull = await historyPull(c, repoId, number),
        revision = await historyRevision(c, repoId),
        scope = `messages:${number}:${query.parentId ?? ''}`;
      const raw = readHistoryCursor(query.cursor, repoId, scope, revision, query.revision),
        last = raw ? z.string().uuid().parse(raw) : null;
      let parent: string | null = null;
      if (query.parentId) {
        const item = await historyMessage(c, repoId, number, query.parentId);
        if (item.kind !== 'review-comment')
          throw new CriterionError(
            400,
            'HISTORY_REPLY_SOURCE_INVALID',
            'inline 코멘트의 답글만 조회할 수 있습니다.',
          );
        parent = item.githubId;
      }
      if (last) await historyMessage(c, repoId, number, last);
      const rows = (
        await c.query(
          `select id from github_pr_messages where pull_request_id=$1
     and ($2::uuid is null or (github_created_at,id)>(select github_created_at,id from github_pr_messages where id=$2))
     and ($3::bigint is null or (kind='review-comment' and in_reply_to_github_id=$3)) order by github_created_at,id limit $4`,
          [pull.id, last, parent, query.limit + 1],
        )
      ).rows;
      const items = [];
      for (const row of rows.slice(0, query.limit)) {
        const { body, provenance, ...item } = await historyMessage(c, repoId, number, row.id);
        void provenance;
        items.push({ ...item, excerpt: body.slice(0, 500), bodyCharacters: body.length });
      }
      return reviewHistoryMessageListSchema.parse({
        schemaVersion: 1,
        repositoryId: repoId,
        revision,
        pull,
        items,
        nextCursor:
          rows.length > query.limit
            ? historyCursor(repoId, scope, revision, rows[query.limit - 1].id)
            : null,
      });
    });
  });
  routes.get(`${base}/pulls/:number/messages/:sourceId`, options, async (request) => {
    const { repoId, number, sourceId } = messageParams.parse(request.params);
    z.object({}).strict().parse(request.query);
    await authorize(request, repoId);
    return withHistoryRead(database, async (c) =>
      reviewHistoryMessageDetailSchema.parse({
        schemaVersion: 1,
        repositoryId: repoId,
        pullNumber: number,
        revision: await historyRevision(c, repoId),
        item: await historyMessage(c, repoId, number, sourceId),
      }),
    );
  });
  routes.get(`${base}/pulls/:number/messages/:sourceId/history`, options, async (request) => {
    const { repoId, number, sourceId } = messageParams.parse(request.params);
    const { cursor } = z
      .object({ cursor: z.string().max(2048).optional() })
      .strict()
      .parse(request.query);
    await authorize(request, repoId);
    return withHistoryRead(database, (c) =>
      historyObservations(c, repoId, number, sourceId, cursor),
    );
  });
  routes.get(`${base}/pulls/:number/messages/:sourceId/versions`, options, async (request) => {
    const { repoId, number, sourceId } = messageParams.parse(request.params);
    const { cursor } = z
      .object({ cursor: z.string().max(2048).optional() })
      .strict()
      .parse(request.query);
    await authorize(request, repoId);
    return withHistoryRead(database, (c) =>
      historyBodyVersions(c, repoId, number, sourceId, cursor),
    );
  });
}
