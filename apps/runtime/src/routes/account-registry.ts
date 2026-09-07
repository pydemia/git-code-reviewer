import { errorEnvelope, schemaVersion } from '@gcr/contracts';
import type { Database } from '@gcr/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAdministrator, requireUser } from '../auth/index.js';
import type { AppConfig } from '../config.js';
import {
  createChatAccount,
  createGitHubConnection,
  listAdminChatAccounts,
  listAvailableChatAccounts,
  listGitHubConnections,
  reasoningEfforts,
  registerGitHubRepository,
  rotateChatAccountCredential,
  testGitHubConnection,
  updateGitHubConnection,
} from '../services/account-registry.js';

const uuidParams = z.object({ id: z.string().uuid() });
const effortSchema = z.enum(reasoningEfforts);
const accountBody = z.object({
  displayName: z.string().trim().min(1).max(120),
  endpoint: z
    .string()
    .url()
    .max(2_048)
    .refine((value) => new URL(value).origin === 'https://chatgpt.com', {
      message: 'Only the ChatGPT Codex endpoint is allowed',
    })
    .optional(),
  authJson: z.string().trim().min(2).max(100_000),
  models: z
    .array(
      z
        .object({
          id: z.string().trim().min(1).max(200),
          displayName: z.string().trim().min(1).max(200),
          allowedEfforts: z.array(effortSchema).min(1),
          defaultEffort: effortSchema,
        })
        .refine((value) => value.allowedEfforts.includes(value.defaultEffort), {
          message: 'defaultEffort must be allowed',
        }),
    )
    .min(1)
    .max(20),
  assignments: z
    .array(
      z
        .object({
          scopeType: z.enum(['all', 'tenant', 'user', 'group']),
          scopeId: z.string().trim().min(1).max(300),
        })
        .refine(
          (value) =>
            (value.scopeType === 'all' && value.scopeId === '*') ||
            (value.scopeType !== 'all' && value.scopeId !== '*'),
        ),
    )
    .min(1)
    .max(100),
});
const accountPatchBody = z
  .object({
    enabled: z.boolean().optional(),
    authJson: z.string().trim().min(2).max(100_000).optional(),
  })
  .refine((value) => value.enabled !== undefined || value.authJson !== undefined);
const githubConnectionBody = z.object({
  name: z.string().trim().min(1).max(120),
  apiBaseUrl: z.string().url().max(2_048),
  webBaseUrl: z.string().url().max(2_048),
  credentialLabel: z.string().trim().min(1).max(120),
  accessToken: z.string().trim().min(1).max(10_000),
  expiresAt: z.string().datetime().optional(),
});
const githubConnectionUpdateBody = z.object({
  name: z.string().trim().min(1).max(120),
  apiBaseUrl: z.string().url().max(2_048),
  webBaseUrl: z.string().url().max(2_048),
  credentialLabel: z.string().trim().min(1).max(120),
  accessToken: z.string().trim().min(1).max(10_000).optional(),
  expiresAt: z.string().datetime().nullable(),
});
const githubRepositoryBody = z.object({
  tenantId: z.string().uuid(),
  owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  name: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  pollIntervalSeconds: z.coerce.number().int().min(30).max(86_400).default(120),
  grantSubjects: z.array(z.string().trim().min(1).max(300)).max(100).default([]),
});

export async function registerAccountRegistryRoutes(
  app: FastifyInstance,
  database: Database,
  config: AppConfig,
) {
  app.get('/api/v1/chat-accounts', { preHandler: requireUser }, async (request) => ({
    schemaVersion,
    enabled: config.CREDENTIAL_REGISTRY_ENABLED,
    items: config.CREDENTIAL_REGISTRY_ENABLED
      ? await listAvailableChatAccounts(database, request.user!.id)
      : [],
  }));

  app.get('/api/v1/admin/chat-accounts', { preHandler: requireAdministrator }, async () => ({
    schemaVersion,
    enabled: config.CREDENTIAL_REGISTRY_ENABLED,
    items: config.CREDENTIAL_REGISTRY_ENABLED ? await listAdminChatAccounts(database) : [],
  }));

  app.post(
    '/api/v1/admin/chat-accounts',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      ensureRegistryEnabled(config);
      const body = accountBody.parse(request.body);
      const id = await createChatAccount(database, config, request.user!.id, body);
      await writeAudit(database, request, 'chat-account.create', 'chat_account', id);
      return reply.code(201).send({ schemaVersion, id });
    },
  );

  app.patch(
    '/api/v1/admin/chat-accounts/:id',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      ensureRegistryEnabled(config);
      const { id } = uuidParams.parse(request.params);
      const body = accountPatchBody.parse(request.body);
      let changed = false;
      if (body.authJson !== undefined) {
        const result = await rotateChatAccountCredential(database, config, id, body.authJson);
        changed ||= Boolean(result.rowCount);
      }
      if (body.enabled !== undefined) {
        const result = await database.query(
          `update chat_accounts set enabled = $2,
             health = case when $2 and health = 'disabled' then 'unverified'
                           when not $2 then 'disabled' else health end,
             updated_at = clock_timestamp() where id = $1`,
          [id, body.enabled],
        );
        changed ||= Boolean(result.rowCount);
      }
      if (!changed) return reply.code(404).send(notFound(request));
      await writeAudit(database, request, 'chat-account.update', 'chat_account', id);
      return { schemaVersion, id };
    },
  );

  app.get('/api/v1/admin/github-connections', { preHandler: requireAdministrator }, async () => ({
    schemaVersion,
    enabled: config.CREDENTIAL_REGISTRY_ENABLED,
    items: config.CREDENTIAL_REGISTRY_ENABLED ? await listGitHubConnections(database) : [],
  }));

  app.post(
    '/api/v1/admin/github-connections',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      ensureRegistryEnabled(config);
      const body = githubConnectionBody.parse(request.body);
      const id = await createGitHubConnection(database, config, request.user!.id, body);
      await writeAudit(database, request, 'github-connection.create', 'github_credential', id);
      return reply.code(201).send({ schemaVersion, id });
    },
  );

  app.patch(
    '/api/v1/admin/github-connections/:id',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      ensureRegistryEnabled(config);
      const { id } = uuidParams.parse(request.params);
      const body = githubConnectionUpdateBody.parse(request.body);
      const connection = await database.connect();
      try {
        await connection.query('begin');
        const outcome = await updateGitHubConnection(connection, config, id, body);
        if (outcome !== 'updated') {
          await writeAudit(
            connection,
            request,
            'github-connection.update',
            'github_credential',
            id,
            'failure',
          );
          await connection.query('commit');
          if (outcome === 'not-found') return reply.code(404).send(notFound(request));
          if (outcome === 'token-required') {
            return reply
              .code(400)
              .send(
                errorEnvelope(
                  'GITHUB_TOKEN_REQUIRED_FOR_ORIGIN_CHANGE',
                  'GHES API/Web origin을 변경하려면 새 access token을 입력해야 합니다.',
                  request.id,
                ),
              );
          }
          return reply
            .code(409)
            .send(
              errorEnvelope(
                'GITHUB_SHARED_INSTANCE_CONFLICT',
                '여러 credential이 공유하는 GHES instance의 이름과 URL은 변경할 수 없습니다.',
                request.id,
              ),
            );
        }
        await writeAudit(connection, request, 'github-connection.update', 'github_credential', id);
        await connection.query('commit');
        return { schemaVersion, id };
      } catch (error) {
        await connection.query('rollback');
        if (isUniqueViolation(error)) {
          await writeFailureAudit(connection, request, 'github-connection.update', id);
          return reply
            .code(409)
            .send(
              errorEnvelope(
                'GITHUB_CONNECTION_CONFLICT',
                '같은 API base URL 또는 credential label을 사용하는 GHES 연결이 있습니다.',
                request.id,
              ),
            );
        }
        throw error;
      } finally {
        connection.release();
      }
    },
  );

  app.post(
    '/api/v1/admin/github-connections/:id/test',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      ensureRegistryEnabled(config);
      const { id } = uuidParams.parse(request.params);
      const result = await testGitHubConnection(database, config, id);
      if (!result) return reply.code(404).send(notFound(request));
      await writeAudit(
        database,
        request,
        'github-connection.test',
        'github_credential',
        id,
        result.ok ? 'success' : 'failure',
      );
      return reply.code(result.ok ? 200 : 502).send({ schemaVersion, ...result });
    },
  );

  app.post(
    '/api/v1/admin/github-connections/:id/repositories',
    { preHandler: requireAdministrator },
    async (request, reply) => {
      ensureRegistryEnabled(config);
      const { id } = uuidParams.parse(request.params);
      const body = githubRepositoryBody.parse(request.body);
      const repositoryId = await registerGitHubRepository(database, config, id, body);
      await writeAudit(database, request, 'repository.register-token', 'repository', repositoryId);
      return reply.code(201).send({ schemaVersion, id: repositoryId });
    },
  );
}

function ensureRegistryEnabled(config: AppConfig) {
  if (!config.CREDENTIAL_REGISTRY_ENABLED) {
    throw Object.assign(new Error('Credential registry is disabled'), { statusCode: 503 });
  }
}

async function writeAudit(
  database: Pick<Database, 'query'>,
  request: FastifyRequest,
  action: string,
  resourceType: string,
  resourceId: string,
  outcome = 'success',
) {
  await database.query(
    `insert into audit_events(actor, action, resource_type, resource_id, outcome, request_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [request.user!.subject, action, resourceType, resourceId, outcome, request.id],
  );
}

async function writeFailureAudit(
  database: Pick<Database, 'query'>,
  request: FastifyRequest,
  action: string,
  resourceId: string,
): Promise<void> {
  try {
    await writeAudit(database, request, action, 'github_credential', resourceId, 'failure');
  } catch (error) {
    request.log.error({ err: error }, 'failure audit write failed');
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505');
}

function notFound(request: FastifyRequest) {
  return {
    error: {
      code: 'RESOURCE_NOT_FOUND',
      message: '리소스를 찾을 수 없습니다.',
      requestId: request.id,
      retryable: false,
    },
  };
}
