import type { Database } from '@gcr/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/index.js';
import type { AuthorizationService } from '../services/authorization.js';
import { canReadRepository } from './worklist.js';
import { criteriaNotFound } from '../services/review-criteria.js';
import { readReviewObservations } from '../services/review-observations.js';
export async function registerReviewObservationsRoutes(
  app: FastifyInstance,
  database: Database,
  authorization: AuthorizationService,
) {
  app.get(
    '/api/v1/repositories/:repoId/review-observations',
    { preHandler: requireUser },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store').header('vary', 'Cookie, Authorization');
      const { repoId } = z.object({ repoId: z.string().uuid() }).parse(request.params);
      const { days } = z
        .object({
          days: z.coerce
            .number()
            .pipe(z.union([z.literal(7), z.literal(30), z.literal(90)]))
            .default(30),
        })
        .strict()
        .parse(request.query);
      if (!(await canReadRepository(database, authorization, request, repoId)))
        throw criteriaNotFound();
      const result = await readReviewObservations(database, repoId, days);
      if (!(await canReadRepository(database, authorization, request, repoId)))
        throw criteriaNotFound();
      return result;
    },
  );
}
