import { createHash } from 'node:crypto';
import { schemaVersion } from '@gcr/contracts';
import type { Database, DatabaseClient } from '@gcr/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAdministrator } from '../auth/index.js';
import type { AppConfig } from '../config.js';
import type { AuthorizationResource, AuthorizationService } from '../services/authorization.js';

const tenantParams = z.object({ tenantId: z.string().uuid() });
const userParams = z.object({ userId: z.string().uuid() });
const membershipParams = tenantParams.merge(userParams);
const promptParams = tenantParams.extend({ promptId: z.string().uuid() });
const tenantCreateBody = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  displayName: z.string().trim().min(1).max(120),
});
const tenantPatchBody = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => value.displayName !== undefined || value.enabled !== undefined);
const userPatchBody = z.object({ enabled: z.boolean() });
const membershipBody = z.object({ enabled: z.boolean().default(true) });
const promptBody = z.object({ instructions: z.string().trim().min(1).max(12_000) });

type PromptRow = {
  id: string;
  tenantId: string;
  version: number;
  instructions: string;
  contentHash: string;
  active: boolean;
  createdBySubject: string;
  createdByName: string;
  activatedBySubject: string | null;
  activatedByName: string | null;
  activatedAt: Date | string | null;
  createdAt: Date | string;
};

export async function registerAdminRoutes(
  app: FastifyInstance,
  database: Database,
  authorization: AuthorizationService,
  config: AppConfig,
) {
  app.get('/api/v1/admin/tenants', { preHandler: requireAdministrator }, async (request, reply) => {
    if (!(await allowed(authorization, request, 'view', { kind: 'tenant', id: 'all' }))) {
      return hiddenNotFound(request, reply);
    }
    const result = await database.query(
      `select tenant.id, tenant.slug, tenant.display_name as "displayName", tenant.enabled,
              count(distinct membership.user_id)::integer as "memberCount",
              count(distinct repository.id)::integer as "repositoryCount",
              tenant.created_at as "createdAt", tenant.updated_at as "updatedAt"
       from tenants tenant
       left join tenant_memberships membership on membership.tenant_id = tenant.id and membership.enabled
       left join repositories repository on repository.tenant_id = tenant.id
       group by tenant.id order by tenant.display_name, tenant.id`,
    );
    return { schemaVersion, items: result.rows };
  });

  app.post(
    '/api/v1/admin/tenants',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      if (!(await allowed(authorization, request, 'create', { kind: 'tenant', id: 'new' }))) {
        return hiddenNotFound(request, reply);
      }
      const body = tenantCreateBody.parse(request.body);
      const result = await database.query<{ id: string }>(
        `insert into tenants(slug, display_name) values ($1, $2)
         on conflict (slug) do nothing returning id`,
        [body.slug, body.displayName],
      );
      if (!result.rows[0]) {
        return reply.code(409).send({
          error: {
            code: 'TENANT_SLUG_EXISTS',
            message: '이미 사용 중인 tenant slug입니다.',
            requestId: request.id,
            retryable: false,
          },
        });
      }
      await writeAudit(database, request, 'tenant.create', 'tenant', result.rows[0].id, {
        slug: body.slug,
      });
      return reply.code(201).send({ schemaVersion, id: result.rows[0].id });
    },
  );

  app.patch(
    '/api/v1/admin/tenants/:tenantId',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      const { tenantId } = tenantParams.parse(request.params);
      if (
        !(await allowed(authorization, request, 'update', {
          kind: 'tenant',
          id: tenantId,
          tenantId,
        }))
      ) {
        return hiddenNotFound(request, reply);
      }
      const body = tenantPatchBody.parse(request.body);
      const result = await database.query(
        `update tenants set display_name = coalesce($2, display_name),
           enabled = coalesce($3, enabled), updated_at = clock_timestamp()
         where id = $1 returning id`,
        [tenantId, body.displayName ?? null, body.enabled ?? null],
      );
      if (!result.rowCount) return hiddenNotFound(request, reply);
      await writeAudit(database, request, 'tenant.update', 'tenant', tenantId, {
        fields: Object.keys(body),
      });
      return { schemaVersion, id: tenantId };
    },
  );

  app.get('/api/v1/admin/users', { preHandler: requireAdministrator }, async (request, reply) => {
    if (!(await allowed(authorization, request, 'view', { kind: 'user', id: 'all' }))) {
      return hiddenNotFound(request, reply);
    }
    const result = await database.query(
      `select app_user.id, app_user.oidc_subject as subject,
              app_user.display_name as "displayName", app_user.role, app_user.enabled,
              app_user.groups_json as groups,
              coalesce(jsonb_agg(jsonb_build_object(
                'tenantId', tenant.id,
                'tenantSlug', tenant.slug,
                'tenantName', tenant.display_name,
                'enabled', membership.enabled
              ) order by tenant.display_name) filter (where tenant.id is not null), '[]'::jsonb) as memberships,
              app_user.created_at as "createdAt", app_user.updated_at as "updatedAt"
       from users app_user
       left join tenant_memberships membership on membership.user_id = app_user.id
       left join tenants tenant on tenant.id = membership.tenant_id
       group by app_user.id order by app_user.display_name, app_user.id`,
    );
    return { schemaVersion, items: result.rows };
  });

  app.patch(
    '/api/v1/admin/users/:userId',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      const { userId } = userParams.parse(request.params);
      if (!(await allowed(authorization, request, 'update', { kind: 'user', id: userId }))) {
        return hiddenNotFound(request, reply);
      }
      const body = userPatchBody.parse(request.body);
      if (userId === request.user!.id && !body.enabled) {
        return reply.code(409).send({
          error: {
            code: 'SELF_DISABLE_NOT_ALLOWED',
            message: '현재 로그인한 관리자는 자신을 비활성화할 수 없습니다.',
            requestId: request.id,
            retryable: false,
          },
        });
      }
      const result = await database.query(
        `update users set enabled = $2, updated_at = clock_timestamp() where id = $1 returning id`,
        [userId, body.enabled],
      );
      if (!result.rowCount) return hiddenNotFound(request, reply);
      if (!body.enabled)
        await database.query('delete from user_sessions where user_id = $1', [userId]);
      await writeAudit(database, request, 'user.access.update', 'user', userId, {
        enabled: body.enabled,
      });
      return { schemaVersion, id: userId };
    },
  );

  app.put(
    '/api/v1/admin/tenants/:tenantId/members/:userId',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      const { tenantId, userId } = membershipParams.parse(request.params);
      if (
        !(await allowed(authorization, request, 'manage', {
          kind: 'membership',
          id: `${tenantId}:${userId}`,
          tenantId,
        }))
      ) {
        return hiddenNotFound(request, reply);
      }
      const body = membershipBody.parse(request.body);
      const result = await database.query(
        `insert into tenant_memberships(tenant_id, user_id, enabled, created_by)
         select tenant.id, app_user.id, $3, $4 from tenants tenant cross join users app_user
         where tenant.id = $1 and app_user.id = $2
         on conflict (tenant_id, user_id) do update set
           enabled = excluded.enabled, updated_at = clock_timestamp()
         returning tenant_id`,
        [tenantId, userId, body.enabled, request.user!.id],
      );
      if (!result.rowCount) return hiddenNotFound(request, reply);
      await writeAudit(database, request, 'membership.update', 'tenant', tenantId, {
        userId,
        enabled: body.enabled,
      });
      return { schemaVersion, tenantId, userId, enabled: body.enabled };
    },
  );

  app.delete(
    '/api/v1/admin/tenants/:tenantId/members/:userId',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      const { tenantId, userId } = membershipParams.parse(request.params);
      if (
        !(await allowed(authorization, request, 'manage', {
          kind: 'membership',
          id: `${tenantId}:${userId}`,
          tenantId,
        }))
      ) {
        return hiddenNotFound(request, reply);
      }
      await database.query(
        `update tenant_memberships set enabled = false, updated_at = clock_timestamp()
         where tenant_id = $1 and user_id = $2`,
        [tenantId, userId],
      );
      await writeAudit(database, request, 'membership.remove', 'tenant', tenantId, { userId });
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/admin/tenants/:tenantId/analysis-prompts',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      const { tenantId } = tenantParams.parse(request.params);
      if (!(await canManagePrompt(database, authorization, request, reply, tenantId, 'view')))
        return;
      return listPrompts(database, config, tenantId);
    },
  );

  app.post(
    '/api/v1/admin/tenants/:tenantId/analysis-prompts',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      const { tenantId } = tenantParams.parse(request.params);
      if (!(await canManagePrompt(database, authorization, request, reply, tenantId, 'manage'))) {
        return;
      }
      const instructions = normalizeInstructions(promptBody.parse(request.body).instructions);
      const hash = promptHash(instructions);
      const connection = await database.connect();
      let promptId: string;
      try {
        await connection.query('begin');
        await lockPrompt(connection, tenantId);
        await connection.query(
          'update analysis_prompt_versions set active = false where tenant_id = $1 and active',
          [tenantId],
        );
        const existing = await connection.query<{ id: string }>(
          `select id from analysis_prompt_versions where tenant_id = $1 and content_hash = $2`,
          [tenantId, hash],
        );
        if (existing.rows[0]) {
          promptId = existing.rows[0].id;
          await activatePrompt(connection, tenantId, promptId, request.user!.id);
        } else {
          const created = await connection.query<{ id: string }>(
            `insert into analysis_prompt_versions(
               tenant_id, version, instructions, content_hash, active,
               created_by, activated_by, activated_at
             ) values (
               $1, (select coalesce(max(version), 0) + 1 from analysis_prompt_versions where tenant_id = $1),
               $2, $3, true, $4, $4, clock_timestamp()
             ) returning id`,
            [tenantId, instructions, hash, request.user!.id],
          );
          promptId = created.rows[0]!.id;
        }
        await writeAudit(connection, request, 'analysis_prompt.activate', 'tenant', tenantId, {
          promptId,
          hash,
        });
        await connection.query('commit');
      } catch (error) {
        await connection.query('rollback');
        throw error;
      } finally {
        connection.release();
      }
      return reply.code(201).send({ schemaVersion, id: promptId, contentHash: hash });
    },
  );

  app.post(
    '/api/v1/admin/tenants/:tenantId/analysis-prompts/:promptId/activate',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      const { tenantId, promptId } = promptParams.parse(request.params);
      if (!(await canManagePrompt(database, authorization, request, reply, tenantId, 'manage'))) {
        return;
      }
      const connection = await database.connect();
      try {
        await connection.query('begin');
        await lockPrompt(connection, tenantId);
        await connection.query(
          'update analysis_prompt_versions set active = false where tenant_id = $1 and active',
          [tenantId],
        );
        const result = await activatePrompt(connection, tenantId, promptId, request.user!.id);
        if (!result.rowCount) {
          await connection.query('rollback');
          return hiddenNotFound(request, reply);
        }
        await writeAudit(connection, request, 'analysis_prompt.activate', 'tenant', tenantId, {
          promptId,
        });
        await connection.query('commit');
      } catch (error) {
        await connection.query('rollback');
        throw error;
      } finally {
        connection.release();
      }
      return { schemaVersion, id: promptId };
    },
  );

  app.post(
    '/api/v1/admin/tenants/:tenantId/analysis-prompts/reset',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      const { tenantId } = tenantParams.parse(request.params);
      if (!(await canManagePrompt(database, authorization, request, reply, tenantId, 'manage'))) {
        return;
      }
      const connection = await database.connect();
      try {
        await connection.query('begin');
        await lockPrompt(connection, tenantId);
        await connection.query(
          'update analysis_prompt_versions set active = false where tenant_id = $1 and active',
          [tenantId],
        );
        await writeAudit(connection, request, 'analysis_prompt.reset', 'tenant', tenantId, {});
        await connection.query('commit');
      } catch (error) {
        await connection.query('rollback');
        throw error;
      } finally {
        connection.release();
      }
      return { schemaVersion, active: null };
    },
  );
}

async function canManagePrompt(
  database: Database,
  authorization: AuthorizationService,
  request: FastifyRequest,
  reply: FastifyReply,
  tenantId: string,
  action: 'view' | 'manage',
) {
  const tenant = await database.query('select 1 from tenants where id = $1', [tenantId]);
  if (
    !tenant.rowCount ||
    !(await allowed(authorization, request, action, {
      kind: 'analysis_prompt',
      id: tenantId,
      tenantId,
    }))
  ) {
    hiddenNotFound(request, reply);
    return false;
  }
  return true;
}

async function listPrompts(database: Database, config: AppConfig, tenantId: string) {
  const tenantResult = await database.query<{ id: string; slug: string; displayName: string }>(
    `select id, slug, display_name as "displayName" from tenants where id = $1`,
    [tenantId],
  );
  const result = await database.query<PromptRow>(
    `select prompt.id, prompt.tenant_id as "tenantId", prompt.version, prompt.instructions,
            prompt.content_hash as "contentHash", prompt.active,
            creator.oidc_subject as "createdBySubject", creator.display_name as "createdByName",
            activator.oidc_subject as "activatedBySubject", activator.display_name as "activatedByName",
            prompt.activated_at as "activatedAt", prompt.created_at as "createdAt"
     from analysis_prompt_versions prompt
     join users creator on creator.id = prompt.created_by
     left join users activator on activator.id = prompt.activated_by
     where prompt.tenant_id = $1 order by prompt.version desc`,
    [tenantId],
  );
  const items = result.rows.map(promptView);
  return {
    schemaVersion,
    tenant: tenantResult.rows[0]!,
    model: { enabled: config.MODEL_MODE !== 'disabled', name: config.MODEL_NAME ?? null },
    active: items.find((item) => item.active) ?? null,
    items,
  };
}

function promptView(row: PromptRow) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    version: row.version,
    instructions: row.instructions,
    contentHash: row.contentHash,
    active: row.active,
    createdBy: { subject: row.createdBySubject, displayName: row.createdByName },
    activatedBy:
      row.activatedBySubject && row.activatedByName
        ? { subject: row.activatedBySubject, displayName: row.activatedByName }
        : null,
    activatedAt: row.activatedAt,
    createdAt: row.createdAt,
  };
}

async function activatePrompt(
  database: Pick<Database, 'query'>,
  tenantId: string,
  promptId: string,
  actorId: string,
) {
  return database.query(
    `update analysis_prompt_versions set active = true, activated_by = $3,
       activated_at = clock_timestamp() where tenant_id = $1 and id = $2 returning id`,
    [tenantId, promptId, actorId],
  );
}

async function lockPrompt(database: Pick<DatabaseClient, 'query'>, tenantId: string) {
  await database.query(
    `select pg_advisory_xact_lock(hashtextextended('analysis-prompt:' || $1, 0))`,
    [tenantId],
  );
}

async function allowed(
  authorization: AuthorizationService,
  request: FastifyRequest,
  action: 'view' | 'create' | 'update' | 'manage',
  resource: AuthorizationResource,
) {
  return authorization.isAllowed(request.user!, action, resource, request.id);
}

function normalizeInstructions(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

function promptHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function writeAudit(
  database: Pick<Database, 'query'>,
  request: FastifyRequest,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown>,
) {
  await database.query(
    `insert into audit_events(actor, action, resource_type, resource_id, outcome, request_id, metadata)
     values ($1, $2, $3, $4, 'success', $5, $6::jsonb)`,
    [
      request.user?.subject ?? 'anonymous',
      action,
      resourceType,
      resourceId,
      request.id,
      JSON.stringify(metadata),
    ],
  );
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
