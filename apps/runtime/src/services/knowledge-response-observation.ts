import type { Database } from '@gcr/db';
import type { FastifyRequest } from 'fastify';
// Only aggregate server responses after repository authorization. No user, client or bundle IDs.
export function knowledgeResponseObserver(database: Database) {
  const eligible = new WeakMap<
    FastifyRequest,
    { repositoryId: string; route: 'manifest' | 'bundle' }
  >();
  let pending = 0;
  return {
    authorize(request: FastifyRequest, repositoryId: string) {
      const url = request.routeOptions.url;
      if (request.method !== 'GET') return;
      if (url?.endsWith('/manifest')) eligible.set(request, { repositoryId, route: 'manifest' });
      else if (url?.endsWith('/bundles/:bundleId'))
        eligible.set(request, { repositoryId, route: 'bundle' });
    },
    async respond(request: FastifyRequest, status: number, durationMs: number) {
      const value = eligible.get(request);
      eligible.delete(request);
      if (!value) return;
      if (pending >= 16) {
        request.log.warn(
          { code: 'KNOWLEDGE_RESPONSE_OBSERVATION_DROPPED' },
          'Response observation capacity exhausted',
        );
        return;
      }
      if (!Number.isFinite(durationMs)) return;
      pending++;
      let c: import('@gcr/db').DatabaseClient | undefined;
      try {
        c = await database.connect();
        await c.query('begin');
        await c.query("set local statement_timeout='2s'");
        await c.query({
          text: `insert into knowledge_response_observations(repository_id,day,route,status,responses,duration_ms) values($1,(clock_timestamp() at time zone 'UTC')::date,$2,$3,1,$4) on conflict(repository_id,day,route,status) do update set responses=knowledge_response_observations.responses+1,duration_ms=knowledge_response_observations.duration_ms+excluded.duration_ms`,
          values: [value.repositoryId, value.route, status, Math.max(0, Math.round(durationMs))],
        });
        await c.query('commit');
      } catch {
        await c?.query('rollback').catch(() => undefined);
        request.log.warn(
          { code: 'KNOWLEDGE_RESPONSE_OBSERVATION_UNAVAILABLE' },
          'Response observation was not stored',
        );
      } finally {
        c?.release();
        pending--;
      }
    },
  };
}
