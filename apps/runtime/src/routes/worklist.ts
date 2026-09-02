import { schemaVersion } from '@gcr/contracts';
import type { Database } from '@gcr/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAdministrator, requireUser } from '../auth/index.js';

const repositoryParams = z.object({ repoId: z.string().uuid() });
const pullParams = repositoryParams.extend({ number: z.coerce.number().int().positive() });
const repositoryBody = z.object({
  instanceName: z.string().min(1).max(120),
  apiBaseUrl: z.string().url(),
  webBaseUrl: z.string().url(),
  githubId: z.coerce.number().int().positive(),
  installationId: z.string().min(1).max(80),
  owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  name: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  pollIntervalSeconds: z.coerce.number().int().min(30).max(86_400).default(120),
});
const repositoryPatch = z.object({
  enabled: z.boolean().optional(),
  pollIntervalSeconds: z.coerce.number().int().min(30).max(86_400).optional(),
});

export async function registerWorklistRoutes(app: FastifyInstance, database: Database) {
  app.get('/api/v1/me', { preHandler: requireUser }, async (request) => ({
    schemaVersion,
    ...request.user,
  }));

  app.get('/api/v1/repositories', { preHandler: requireUser }, async (request) => {
    const rows = await listAuthorizedRepositories(database, request);
    return { schemaVersion, items: rows, nextCursor: null };
  });

  app.get(
    '/api/v1/repositories/:repoId/pulls',
    { preHandler: requireUser },
    async (request, reply) => {
      const { repoId } = repositoryParams.parse(request.params);
      if (!(await canReadRepository(database, request, repoId)))
        return hiddenNotFound(request, reply);
      const result = await database.query(
        `select id, number, title, state, draft, author_login as "author", html_url as "htmlUrl",
                base_ref as "baseRef", base_sha as "baseSha", head_ref as "headRef", head_sha as "headSha",
                github_updated_at as "updatedAt", observed_at as "observedAt"
         from pull_requests where repository_id = $1 and state = 'open'
         order by github_updated_at desc limit 100`,
        [repoId],
      );
      return { schemaVersion, repositoryId: repoId, items: result.rows, nextCursor: null };
    },
  );

  app.get(
    '/api/v1/repositories/:repoId/pulls/:number',
    { preHandler: requireUser },
    async (request, reply) => {
      const { repoId, number } = pullParams.parse(request.params);
      if (!(await canReadRepository(database, request, repoId)))
        return hiddenNotFound(request, reply);
      const result = await database.query(
        `select id, repository_id as "repositoryId", number, title, state, draft,
                author_login as "author", html_url as "htmlUrl", base_ref as "baseRef",
                base_sha as "baseSha", head_ref as "headRef", head_sha as "headSha",
                github_updated_at as "updatedAt", observed_at as "observedAt"
         from pull_requests where repository_id = $1 and number = $2`,
        [repoId, number],
      );
      return result.rows[0] ? { schemaVersion, ...result.rows[0] } : hiddenNotFound(request, reply);
    },
  );

  app.get('/api/v1/admin/repositories', { preHandler: requireAdministrator }, async () => ({
    schemaVersion,
    items: await listRepositories(database),
    nextCursor: null,
  }));

  app.post(
    '/api/v1/admin/repositories',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      const body = repositoryBody.parse(request.body);
      assertCredentialFreeUrl(body.apiBaseUrl);
      assertCredentialFreeUrl(body.webBaseUrl);
      const connection = await database.connect();
      try {
        await connection.query('begin');
        const instance = await connection.query<{ id: string }>(
          `insert into github_instances(name, api_base_url, web_base_url)
           values ($1, $2, $3)
           on conflict (api_base_url) do update set
             name = excluded.name, web_base_url = excluded.web_base_url, updated_at = clock_timestamp()
           returning id`,
          [
            body.instanceName,
            ensureTrailingSlash(body.apiBaseUrl),
            ensureTrailingSlash(body.webBaseUrl),
          ],
        );
        const repository = await connection.query<{ id: string }>(
          `insert into repositories(instance_id, github_id, installation_id, owner, name, poll_interval_seconds)
           values ($1,$2,$3,$4,$5,$6)
           on conflict (instance_id, github_id) do update set
             installation_id = excluded.installation_id, owner = excluded.owner, name = excluded.name,
             poll_interval_seconds = excluded.poll_interval_seconds, enabled = true,
             updated_at = clock_timestamp()
           returning id`,
          [
            instance.rows[0]!.id,
            body.githubId,
            body.installationId,
            body.owner,
            body.name,
            body.pollIntervalSeconds,
          ],
        );
        await connection.query(
          `insert into poll_states(repository_id, next_poll_at)
           values ($1, clock_timestamp()) on conflict (repository_id) do update set next_poll_at = clock_timestamp()`,
          [repository.rows[0]!.id],
        );
        await writeAudit(
          connection,
          request,
          'repository.register',
          repository.rows[0]!.id,
          'success',
        );
        await connection.query('commit');
        return reply.code(201).send({ schemaVersion, id: repository.rows[0]!.id });
      } catch (error) {
        await connection.query('rollback');
        throw error;
      } finally {
        connection.release();
      }
    },
  );

  app.patch(
    '/api/v1/admin/repositories/:repoId',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      const { repoId } = repositoryParams.parse(request.params);
      const patch = repositoryPatch.parse(request.body);
      const result = await database.query(
        `update repositories set
           enabled = coalesce($2, enabled),
           poll_interval_seconds = coalesce($3, poll_interval_seconds),
           updated_at = clock_timestamp()
         where id = $1 returning id`,
        [repoId, patch.enabled ?? null, patch.pollIntervalSeconds ?? null],
      );
      if (!result.rowCount) return hiddenNotFound(request, reply);
      await writeAudit(database, request, 'repository.update', repoId, 'success');
      return { schemaVersion, id: repoId };
    },
  );
}

async function listAuthorizedRepositories(database: Database, request: FastifyRequest) {
  if (request.user!.role === 'administrator') return listRepositories(database);
  const principals = [
    request.user!.subject,
    ...request.user!.groups.map((group) => `group:${group}`),
  ];
  const result = await database.query(
    `select r.id, r.github_id as "githubId", r.owner, r.name, i.web_base_url as "webBaseUrl",
            p.last_polled_at as "lastPolledAt", p.next_poll_at as "nextPollAt",
            p.last_outcome as "pollOutcome", p.last_error_code as "pollError"
     from repositories r join github_instances i on i.id = r.instance_id
     left join poll_states p on p.repository_id = r.id
     where r.enabled and i.enabled and exists (
       select 1 from repository_grants g
       where g.repository_id = r.id and g.subject_or_group = any($1::text[])
     ) order by r.owner, r.name`,
    [principals],
  );
  return result.rows;
}

async function listRepositories(database: Database) {
  const result = await database.query(
    `select r.id, r.github_id as "githubId", r.installation_id as "installationId",
            r.owner, r.name, r.enabled, r.poll_interval_seconds as "pollIntervalSeconds",
            i.name as "instanceName", i.api_base_url as "apiBaseUrl", i.web_base_url as "webBaseUrl",
            p.last_polled_at as "lastPolledAt", p.next_poll_at as "nextPollAt",
            p.last_outcome as "pollOutcome", p.last_error_code as "pollError"
     from repositories r join github_instances i on i.id = r.instance_id
     left join poll_states p on p.repository_id = r.id
     order by r.owner, r.name`,
  );
  return result.rows;
}

export async function canReadRepository(
  database: Database,
  request: FastifyRequest,
  repositoryId: string,
): Promise<boolean> {
  if (request.user?.role === 'administrator') {
    const result = await database.query('select 1 from repositories where id = $1 and enabled', [
      repositoryId,
    ]);
    return Boolean(result.rowCount);
  }
  if (!request.user) return false;
  const principals = [
    request.user.subject,
    ...request.user.groups.map((group) => `group:${group}`),
  ];
  const result = await database.query(
    `select 1 from repositories r where r.id = $1 and r.enabled and exists (
       select 1 from repository_grants g where g.repository_id = r.id
         and g.subject_or_group = any($2::text[]))`,
    [repositoryId, principals],
  );
  return Boolean(result.rowCount);
}

function hiddenNotFound(request: FastifyRequest, reply: import('fastify').FastifyReply) {
  return reply.code(404).send({
    error: {
      code: 'RESOURCE_NOT_FOUND',
      message: '리소스를 찾을 수 없습니다.',
      requestId: request.id,
      retryable: false,
    },
  });
}

async function writeAudit(
  database: Pick<Database, 'query'>,
  request: FastifyRequest,
  action: string,
  resourceId: string,
  outcome: string,
) {
  await database.query(
    `insert into audit_events(actor, action, resource_type, resource_id, outcome, request_id)
     values ($1, $2, 'repository', $3, $4, $5)`,
    [request.user?.subject ?? 'anonymous', action, resourceId, outcome, request.id],
  );
}

function assertCredentialFreeUrl(value: string) {
  const url = new URL(value);
  if (url.username || url.password) throw new Error('Repository URLs must not contain credentials');
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
