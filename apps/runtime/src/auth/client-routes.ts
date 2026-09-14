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
import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { centralConnectionInput } from '@gcr/client-contract';
import type { KnowledgeSigner } from '../services/knowledge-manifest.js';

export async function loadClientConnectionCa(file?: string): Promise<string | null> {
  if (!file) return null;
  try {
    const pem = await readFile(file, 'utf8');
    const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (
      Buffer.byteLength(pem) > 65536 ||
      !certificates?.length ||
      pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim() ||
      certificates.some((value) => !new X509Certificate(value).ca)
    )
      throw Error();
    return pem;
  } catch {
    throw Error(
      'Invalid configuration: CLIENT_CONNECTION_CA_FILE must contain only public CA certificates',
    );
  }
}

export async function registerClientCredentialRoutes(
  app: FastifyInstance,
  database: Database,
  config: AppConfig,
  authorization: AuthorizationService,
  signer?: KnowledgeSigner,
) {
  const enabled =
    config.CLIENT_API_KEYS_ENABLED &&
    !!config.KNOWLEDGE_SERVER_ID &&
    config.KNOWLEDGE_DISTRIBUTION_ENABLED &&
    ['local', 'saml'].includes(config.AUTH_MODE);
  const ca = enabled ? await loadClientConnectionCa(config.CLIENT_CONNECTION_CA_FILE) : null;
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
    routes.get('/api/v1/me/client-connection-config', { preHandler: web }, async (request) => {
      const { repositoryId } = z
        .object({ repositoryId: z.string().uuid() })
        .strict()
        .parse(request.query);
      if (!signer || signer.serverId !== config.KNOWLEDGE_SERVER_ID || !config.PUBLIC_BASE_URL)
        throw new ClientCredentialError(503, 'CLIENT_CONNECTION_UNAVAILABLE');
      if (!(await canReadRepository(database, authorization, request, repositoryId)))
        throw new ClientCredentialError(403, 'CLIENT_SCOPE_DENIED');
      const repository = (
        await database.query<{ tenant_id: string }>(
          'select tenant_id from repositories where id=$1 and deleted_at is null',
          [repositoryId],
        )
      ).rows[0];
      if (!repository) throw new ClientCredentialError(403, 'CLIENT_SCOPE_DENIED');
      return centralConnectionInput({
        serverUrl: config.PUBLIC_BASE_URL,
        serverId: signer.serverId,
        tenantId: repository.tenant_id,
        repositoryId,
        trustedKeys: [{ id: signer.keyId, pem: signer.publicKeyPem }],
        ca,
      });
    });
    routes.post('/api/v1/me/client-credentials', { preHandler: web }, async (request, reply) => {
      const input = clientKeyInput.parse(request.body);
      if (input.scopes.some((scope) => scope !== 'knowledge:read'))
        throw new ClientCredentialError(403, 'CLIENT_READ_ONLY');
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
