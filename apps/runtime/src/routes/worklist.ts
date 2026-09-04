import { schemaVersion } from '@gcr/contracts';
import type { Database } from '@gcr/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAdministrator, requireUser } from '../auth/index.js';
import type { AuthorizationAction, AuthorizationService } from '../services/authorization.js';

const repositoryParams = z.object({ repoId: z.string().uuid() });
const repositoryGrantParams = repositoryParams.extend({ userId: z.string().uuid() });
const pullParams = repositoryParams.extend({ number: z.coerce.number().int().positive() });
const repositoryBody = z.object({
  tenantId: z.string().uuid(),
  instanceName: z.string().min(1).max(120),
  apiBaseUrl: z.string().url(),
  webBaseUrl: z.string().url(),
  githubId: z.coerce.number().int().positive(),
  installationId: z.string().min(1).max(80),
  owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  name: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  pollIntervalSeconds: z.coerce.number().int().min(30).max(86_400).default(120),
});
const repositoryListQuery = z.object({ tenantId: z.string().uuid().optional() });
const repositoryPatch = z.object({
  enabled: z.boolean().optional(),
  pollingEnabled: z.boolean().optional(),
  pollIntervalSeconds: z.coerce.number().int().min(30).max(86_400).optional(),
});
const repositoryGrantBody = z.object({ enabled: z.boolean() });

export async function registerWorklistRoutes(
  app: FastifyInstance,
  database: Database,
  authorization: AuthorizationService,
) {
  app.get('/api/v1/me', { preHandler: requireUser }, async (request) => ({
    schemaVersion,
    ...request.user,
  }));

  app.get('/api/v1/repositories', { preHandler: requireUser }, async (request) => {
    const { tenantId } = repositoryListQuery.parse(request.query);
    const rows = await listAuthorizedRepositories(database, authorization, request, tenantId);
    return { schemaVersion, items: rows, nextCursor: null };
  });

  app.get(
    '/api/v1/repositories/:repoId/pulls',
    { preHandler: requireUser },
    async (request, reply) => {
      const { repoId } = repositoryParams.parse(request.params);
      if (!(await canReadRepository(database, authorization, request, repoId)))
        return hiddenNotFound(request, reply);
      const result = await database.query(
        `select pr.id, pr.number, pr.title, pr.state, pr.draft, pr.author_login as "author",
                pr.html_url as "htmlUrl", pr.base_ref as "baseRef", pr.base_sha as "baseSha",
                pr.head_ref as "headRef", pr.head_sha as "headSha",
                pr.github_updated_at as "updatedAt", pr.observed_at as "observedAt",
                latest.id as "latestAnalysisId", latest.state as "analysisState",
                latest.grade, coalesce(latest.attention_count, 0) as "attentionCount"
         from pull_requests pr
         left join lateral (
           select ar.id, ar.state, report.grade,
                  (select count(*)::integer from findings f
                   where f.report_id = report.id and f.priority in ('P2', 'P3')) as attention_count
           from snapshot_requests sr
           join snapshots snapshot on snapshot.request_id = sr.id
           join analysis_runs ar on ar.snapshot_id = snapshot.id
           left join reports report on report.analysis_run_id = ar.id
           where sr.pull_request_id = pr.id
           order by ar.created_at desc limit 1
         ) latest on true
         where pr.repository_id = $1 and pr.state = 'open'
         order by pr.github_updated_at desc limit 100`,
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
      if (!(await canReadRepository(database, authorization, request, repoId)))
        return hiddenNotFound(request, reply);
      const result = await database.query(
        `select pr.id, pr.repository_id as "repositoryId", pr.number, pr.title, pr.state, pr.draft,
                author_login as "author", html_url as "htmlUrl", base_ref as "baseRef",
                base_sha as "baseSha", head_ref as "headRef", head_sha as "headSha",
                github_updated_at as "updatedAt", observed_at as "observedAt",
                r.owner, r.name, i.web_base_url as "webBaseUrl"
         from pull_requests pr join repositories r on r.id = pr.repository_id
         join github_instances i on i.id = r.instance_id
         where pr.repository_id = $1 and pr.number = $2`,
        [repoId, number],
      );
      return result.rows[0] ? { schemaVersion, ...result.rows[0] } : hiddenNotFound(request, reply);
    },
  );

  app.get(
    '/api/v1/admin/repositories',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      const { tenantId } = repositoryListQuery.parse(request.query);
      if (
        !(await authorization.isAllowed(
          request.user!,
          'view',
          { kind: 'repository', id: 'all', ...(tenantId ? { tenantId } : {}) },
          request.id,
        ))
      ) {
        return hiddenNotFound(request, reply);
      }
      return {
        schemaVersion,
        items: await listRepositories(database, tenantId),
        nextCursor: null,
      };
    },
  );

  app.post(
    '/api/v1/admin/repositories',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      const body = repositoryBody.parse(request.body);
      if (
        !(await authorization.isAllowed(
          request.user!,
          'create',
          { kind: 'repository', id: 'new', tenantId: body.tenantId },
          request.id,
        ))
      ) {
        return hiddenNotFound(request, reply);
      }
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
          `insert into repositories(tenant_id, instance_id, github_id, installation_id, owner, name, poll_interval_seconds)
           select tenant.id,$1,$2,$3,$4,$5,$6 from tenants tenant where tenant.id = $7 and tenant.enabled
           on conflict (instance_id, github_id) do update set
             tenant_id = excluded.tenant_id, installation_id = excluded.installation_id,
             owner = excluded.owner, name = excluded.name,
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
            body.tenantId,
          ],
        );
        if (!repository.rows[0]) throw new Error('Tenant is unavailable');
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

  app.put(
    '/api/v1/admin/repositories/:repoId/grants/:userId',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      const { repoId, userId } = repositoryGrantParams.parse(request.params);
      if (!(await canReadRepository(database, authorization, request, repoId, 'update'))) {
        return hiddenNotFound(request, reply);
      }
      const body = repositoryGrantBody.parse(request.body);
      const target = await database.query<{ subject: string }>(
        `select app_user.oidc_subject as subject
         from users app_user join tenant_memberships membership on membership.user_id = app_user.id
         join repositories repository on repository.tenant_id = membership.tenant_id
         where app_user.id = $1 and app_user.enabled and membership.enabled
           and repository.id = $2 and repository.enabled`,
        [userId, repoId],
      );
      if (!target.rows[0]) return hiddenNotFound(request, reply);
      if (body.enabled) {
        await database.query(
          `insert into repository_grants(repository_id, subject_or_group, role)
           values ($1, $2, 'reviewer')
           on conflict (repository_id, subject_or_group) do update set role = 'reviewer'`,
          [repoId, target.rows[0].subject],
        );
      } else {
        await database.query(
          `delete from repository_grants where repository_id = $1 and subject_or_group = $2`,
          [repoId, target.rows[0].subject],
        );
      }
      await writeAudit(database, request, 'repository.grant.update', repoId, 'success');
      return { schemaVersion, repositoryId: repoId, userId, enabled: body.enabled };
    },
  );

  app.patch(
    '/api/v1/admin/repositories/:repoId',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      const { repoId } = repositoryParams.parse(request.params);
      if (!(await canReadRepository(database, authorization, request, repoId, 'update'))) {
        return hiddenNotFound(request, reply);
      }
      const patch = repositoryPatch.parse(request.body);
      const result = await database.query(
        `update repositories set
           enabled = coalesce($2, enabled),
           poll_interval_seconds = coalesce($3, poll_interval_seconds),
           polling_enabled = coalesce($4, polling_enabled),
           updated_at = clock_timestamp()
         where id = $1 returning id`,
        [
          repoId,
          patch.enabled ?? null,
          patch.pollIntervalSeconds ?? null,
          patch.pollingEnabled ?? null,
        ],
      );
      if (!result.rowCount) return hiddenNotFound(request, reply);
      await writeAudit(database, request, 'repository.update', repoId, 'success');
      return { schemaVersion, id: repoId };
    },
  );

  app.post(
    '/api/v1/admin/repositories/:repoId/poll',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      const { repoId } = repositoryParams.parse(request.params);
      if (!(await canReadRepository(database, authorization, request, repoId, 'update'))) {
        return hiddenNotFound(request, reply);
      }
      const result = await database.query(
        `insert into poll_states(repository_id, next_poll_at, backoff_until, updated_at)
         select id, clock_timestamp(), null, clock_timestamp()
         from repositories where id = $1 and enabled and polling_enabled
         on conflict (repository_id) do update set next_poll_at = clock_timestamp(),
           backoff_until = null, updated_at = clock_timestamp()
         returning repository_id`,
        [repoId],
      );
      if (!result.rowCount) return hiddenNotFound(request, reply);
      await writeAudit(database, request, 'repository.poll-now', repoId, 'success');
      return reply.code(202).send({ schemaVersion, id: repoId, state: 'queued' });
    },
  );
}

async function listAuthorizedRepositories(
  database: Database,
  authorization: AuthorizationService,
  request: FastifyRequest,
  tenantId?: string,
) {
  if (request.user!.role === 'administrator') {
    const rows = await listRepositories(database, tenantId);
    return filterRepositoryRows(authorization, request, rows, true);
  }
  const principals = [
    request.user!.subject,
    ...request.user!.groups.map((group) => `group:${group}`),
  ];
  const result = await database.query(
    `select r.id, r.github_id as "githubId", r.tenant_id as "tenantId",
            tenant.slug as "tenantSlug", tenant.display_name as "tenantName",
            r.owner, r.name, i.web_base_url as "webBaseUrl", r.enabled,
            p.last_polled_at as "lastPolledAt", p.next_poll_at as "nextPollAt",
            p.last_outcome as "pollOutcome", p.last_error_code as "pollError"
     from repositories r join github_instances i on i.id = r.instance_id
     join tenants tenant on tenant.id = r.tenant_id
     left join poll_states p on p.repository_id = r.id
     where r.enabled and i.enabled and tenant.enabled and r.tenant_id = any($1::uuid[])
       and ($3::uuid is null or r.tenant_id = $3) and exists (
       select 1 from repository_grants g
       where g.repository_id = r.id and g.subject_or_group = any($2::text[])
     ) order by r.owner, r.name`,
    [request.user!.tenantIds, principals, tenantId ?? null],
  );
  return filterRepositoryRows(authorization, request, result.rows, true);
}

async function listRepositories(database: Database, tenantId?: string) {
  const result = await database.query(
    `select r.id, r.github_id as "githubId", r.installation_id as "installationId",
            r.tenant_id as "tenantId", tenant.slug as "tenantSlug",
            tenant.display_name as "tenantName",
            r.owner, r.name, r.enabled, r.poll_interval_seconds as "pollIntervalSeconds",
            r.polling_enabled as "pollingEnabled", r.credential_id as "credentialId",
            i.name as "instanceName", i.api_base_url as "apiBaseUrl", i.web_base_url as "webBaseUrl",
            credential.label as "credentialLabel",
            p.last_polled_at as "lastPolledAt", p.next_poll_at as "nextPollAt",
            p.last_outcome as "pollOutcome", p.last_error_code as "pollError"
     from repositories r join github_instances i on i.id = r.instance_id
     join tenants tenant on tenant.id = r.tenant_id
     left join github_credentials credential on credential.id = r.credential_id
     left join poll_states p on p.repository_id = r.id
     where ($1::uuid is null or r.tenant_id = $1)
     order by tenant.display_name, r.owner, r.name`,
    [tenantId ?? null],
  );
  return result.rows;
}

export async function canReadRepository(
  database: Database,
  authorization: AuthorizationService,
  request: FastifyRequest,
  repositoryId: string,
  action: AuthorizationAction = 'view',
): Promise<boolean> {
  if (!request.user) return false;
  const principals = [
    request.user.subject,
    ...request.user.groups.map((group) => `group:${group}`),
  ];
  const result = await database.query<{ tenantId: string; enabled: boolean; granted: boolean }>(
    `select r.tenant_id as "tenantId", (r.enabled and tenant.enabled and instance.enabled) as enabled,
            exists (select 1 from repository_grants grant_row
              where grant_row.repository_id = r.id and grant_row.subject_or_group = any($2::text[])) as granted
     from repositories r join tenants tenant on tenant.id = r.tenant_id
     join github_instances instance on instance.id = r.instance_id where r.id = $1`,
    [repositoryId, principals],
  );
  const row = result.rows[0];
  return row
    ? authorization.isAllowed(
        request.user,
        action,
        {
          kind: 'repository',
          id: repositoryId,
          tenantId: row.tenantId,
          granted: request.user.role === 'administrator' || row.granted,
          enabled: row.enabled,
        },
        request.id,
      )
    : false;
}

async function filterRepositoryRows(
  authorization: AuthorizationService,
  request: FastifyRequest,
  rows: Array<Record<string, unknown>>,
  granted: boolean,
) {
  const resources = rows.map((row) => ({
    kind: 'repository' as const,
    id: String(row.id),
    tenantId: String(row.tenantId),
    granted,
    enabled: row.enabled !== false,
  }));
  const allowed = await authorization.filterAllowed(request.user!, 'view', resources, request.id);
  return rows.filter((row) => allowed.has(String(row.id)));
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
