import type { Database } from '@gcr/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { requireUser } from './index.js';
import {
  ClientCredentialError,
  clientKeyInput,
  issueClientKey,
  listClientKeys,
  revokeClientKey,
} from './client-credentials.js';
import type { AuthorizationService } from '../services/authorization.js';
import { canReadRepository } from '../routes/worklist.js';

export async function registerClientCredentialRoutes(
  app: FastifyInstance,
  database: Database,
  config: AppConfig,
  authorization: AuthorizationService,
) {
  const enabled =
    config.CLIENT_API_KEYS_ENABLED &&
    !!config.KNOWLEDGE_SERVER_ID &&
    config.KNOWLEDGE_DISTRIBUTION_ENABLED &&
    ['local', 'saml'].includes(config.AUTH_MODE);
  const web = async (request: FastifyRequest) => {
    if (!enabled) throw new ClientCredentialError(503, 'CLIENT_AUTH_DISABLED');
    if (!request.user || !request.cookies.gcr_session || request.headers.authorization)
      throw new ClientCredentialError(401, 'CLIENT_WEB_REAUTHENTICATION_REQUIRED');
    if (
      !['GET', 'HEAD'].includes(request.method) &&
      (!config.PUBLIC_BASE_URL || request.headers.origin !== new URL(config.PUBLIC_BASE_URL).origin)
    )
      throw new ClientCredentialError(403, 'INVALID_ORIGIN');
  };
  await app.register(async (routes) => {
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('cache-control', 'private, no-store').header('vary', 'Cookie, Authorization');
    });
    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof ClientCredentialError || error instanceof z.ZodError)
        return reply.code(error instanceof z.ZodError ? 400 : error.statusCode).send({
          error: {
            code: error instanceof z.ZodError ? 'INVALID_CLIENT_REQUEST' : error.code,
            message: '클라이언트 인증 요청을 처리하지 못했습니다.',
            requestId: request.id,
          },
        });
      throw error;
    });
    routes.get('/api/v1/client-auth/config', async () => ({
      schemaVersion: 1,
      serverId: config.KNOWLEDGE_SERVER_ID ?? null,
      methods: enabled ? ['api-key'] : [],
      clientIds: enabled ? ['commit-defender', 'gcr-cli'] : [],
      scopes: enabled ? ['knowledge:read'] : [],
    }));
    routes.get(
      '/api/v1/client-auth/me',
      { config: { clientKnowledgeRead: true }, preHandler: requireUser },
      async (request) => {
        const principal = request.clientPrincipal;
        if (!principal) throw new ClientCredentialError(401, 'CLIENT_AUTHENTICATION_REQUIRED');
        const effective: string[] = [];
        for (const id of principal.repositoryIds)
          if (await canReadRepository(database, authorization, request, id)) effective.push(id);
        return {
          schemaVersion: 1,
          serverId: config.KNOWLEDGE_SERVER_ID,
          userId: principal.user.id,
          displayName: principal.user.displayName,
          tenantId: principal.tenantId,
          repositoryIds: effective,
          scopes: principal.scopes,
          clientId: principal.clientId,
          keyId: principal.keyId,
          expiresAt: principal.expiresAt,
        };
      },
    );
    routes.get('/api/v1/me/client-credentials', { preHandler: web }, async (request) => {
      const { cursor } = z
        .object({ cursor: z.string().uuid().optional() })
        .strict()
        .parse(request.query);
      return { schemaVersion: 1, ...(await listClientKeys(database, request.user!.id, cursor)) };
    });
    routes.post('/api/v1/me/client-credentials', { preHandler: web }, async (request, reply) => {
      const input = clientKeyInput.parse(request.body);
      for (const id of input.repositoryIds)
        if (!(await canReadRepository(database, authorization, request, id)))
          throw new ClientCredentialError(403, 'CLIENT_SCOPE_DENIED');
      const result = await issueClientKey(database, {
        user: request.user!,
        sessionToken: request.cookies.gcr_session!,
        serverId: config.KNOWLEDGE_SERVER_ID!,
        authMode: config.AUTH_MODE,
        requestId: request.id,
        input,
      });
      return reply.code(201).send({ schemaVersion: 1, ...result });
    });
    routes.delete(
      '/api/v1/me/client-credentials/:keyId',
      { preHandler: web },
      async (request, reply) => {
        const { keyId } = z.object({ keyId: z.string().uuid() }).parse(request.params);
        await revokeClientKey(database, request.user!.id, keyId, request.id);
        return reply.code(204).send();
      },
    );
  });
}
