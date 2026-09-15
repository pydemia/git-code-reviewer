import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '@gcr/db';
import { z } from 'zod';
import { centralMemoryContent, ContractError } from '@gcr/client-contract';
import { requireUser } from '../auth/index.js';
import { CriterionError } from '../services/review-criteria.js';
import {
  historyRevision,
  historyCursor,
  readHistoryCursor,
  withHistoryRead,
} from '../services/review-history.js';
import {
  guidanceTransaction,
  createHistoryGuidance,
  readHistoryGuidance,
  activateHistoryGuidance,
  retireHistoryGuidance,
} from '../services/review-history-guidance.js';
import { createHash } from 'node:crypto';
const params = z.object({ repoId: z.string().uuid() });
const detail = params.extend({ guidanceId: z.string().uuid() });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export async function registerHistoryGuidanceRoutes(
  app: FastifyInstance,
  db: Database,
  authorize: (r: FastifyRequest, repo: string, role?: 'reader' | 'maintainer') => Promise<void>,
) {
  const base = '/api/v1/repositories/:repoId/review-history/guidance';
  const options = { preHandler: requireUser, config: { clientKnowledgeRead: true } };
  app.get(base, options, async (request) => {
    const { repoId } = params.parse(request.params);
    const query = z
      .object({
        sourceId: z.string().uuid().optional(),
        cursor: z.string().max(2048).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .strict()
      .parse(request.query);
    await authorize(request, repoId);
    return withHistoryRead(db, async (c) => {
      const fingerprint = (
        await c.query(
          `select count(*)::text as n,max(updated_at)::text as updated from review_memories where repository_id=$1 and scope='collective' and source_anchor->>'format'='review-history-guidance-v1'`,
          [repoId],
        )
      ).rows[0];
      const revision = createHash('sha256')
        .update(JSON.stringify([fingerprint, await historyRevision(c, repoId)]))
        .digest('hex');
      const scope = `guidance:${query.sourceId ?? 'all'}`;
      const last = readHistoryCursor(query.cursor, repoId, scope, revision);
      if (last) z.string().uuid().parse(last);
      const rows = (
        await c.query(
          `select id from review_memories where repository_id=$1 and scope='collective' and source_kind='github-pr-message' and source_anchor->>'format'='review-history-guidance-v1' and ($2::uuid is null or source_github_pr_message_id=$2) and ($3::uuid is null or id>$3) order by id limit $4`,
          [repoId, query.sourceId ?? null, last, query.limit + 1],
        )
      ).rows;
      const items = [];
      for (const row of rows.slice(0, query.limit))
        items.push(await readHistoryGuidance(c, repoId, row.id));
      return {
        schemaVersion: 1,
        repositoryId: repoId,
        revision,
        items,
        nextCursor:
          rows.length > query.limit
            ? historyCursor(repoId, scope, revision, rows[query.limit - 1].id)
            : null,
      };
    });
  });
  app.get(`${base}/:guidanceId`, options, async (request) => {
    const { repoId, guidanceId } = detail.parse(request.params);
    z.object({}).strict().parse(request.query);
    await authorize(request, repoId);
    return withHistoryRead(db, (c) => readHistoryGuidance(c, repoId, guidanceId));
  });
  app.post(base, { preHandler: requireUser }, async (request, reply) => {
    const { repoId } = params.parse(request.params);
    await authorize(request, repoId, 'maintainer');
    const input = z
      .object({
        sourceId: z.string().uuid(),
        contentHash: hash,
        observationHash: hash.nullable(),
        content: z.unknown(),
      })
      .strict()
      .parse(request.body);
    let content;
    try {
      content = centralMemoryContent(input.content);
    } catch (error) {
      if (error instanceof ContractError)
        throw new CriterionError(400, 'INVALID_GUIDANCE_CONTENT', '지침 형식을 확인해 주세요.');
      throw error;
    }
    return reply
      .code(201)
      .send(
        await guidanceTransaction(db, (c) =>
          createHistoryGuidance(c, repoId, request.user!.id, { ...input, content }),
        ),
      );
  });
  for (const action of ['activate', 'retire'] as const)
    app.post(`${base}/:guidanceId/${action}`, { preHandler: requireUser }, async (request) => {
      const { repoId, guidanceId } = detail.parse(request.params);
      await authorize(request, repoId, 'maintainer');
      const { revision } = z
        .object({ revision: z.number().int().positive() })
        .strict()
        .parse(request.body);
      return guidanceTransaction(db, (c) =>
        (action === 'activate' ? activateHistoryGuidance : retireHistoryGuidance)(
          c,
          repoId,
          request.user!.id,
          guidanceId,
          revision,
        ),
      );
    });
}
