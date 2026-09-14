import { ContractError, REMOTE_REVIEW_MAX_BYTES, remoteReviewCancel } from '@gcr/client-contract';
import { RemoteReviewValidationError } from '@gcr/client-core';
import type { Database } from '@gcr/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/index.js';
import { ClientCredentialError } from '../auth/client-credentials.js';
import type { AppConfig } from '../config.js';
import type { AuthorizationService } from '../services/authorization.js';
import {
  cancelRemoteReviewJob,
  readRemoteReviewJob,
  RemoteReviewJobError,
  submitRemoteReviewJob,
  type RemoteReviewCaller,
} from '../services/remote-review-jobs.js';

const repositoryParams = z.object({ repoId: z.string().uuid() });
const jobParams = repositoryParams.extend({
  requestId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
});
function caller(request: FastifyRequest): RemoteReviewCaller {
  if (!request.clientPrincipal || !request.headers.authorization)
    throw new ClientCredentialError(401, 'CLIENT_AUTHENTICATION_REQUIRED');
  return {
    authorization: request.headers.authorization,
    requestedServerId: String(request.headers['x-gcr-server-id']),
    keyId: request.clientPrincipal.keyId,
    repositoryId: repositoryParams.parse(request.params).repoId,
    traceId: request.id,
  };
}
export async function registerRemoteReviewRoutes(
  app: FastifyInstance,
  database: Database,
  config: AppConfig,
  authorization: AuthorizationService,
) {
  await app.register(async (routes) => {
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('cache-control', 'private, no-store').header('vary', 'Cookie, Authorization');
    });
    routes.setErrorHandler((error, request, reply) => {
      let statusCode = 503,
        code = 'REMOTE_REVIEW_UNAVAILABLE';
      if (error instanceof RemoteReviewJobError || error instanceof ClientCredentialError) {
        statusCode = error.statusCode;
        code = error.code;
      } else if (error instanceof RemoteReviewValidationError) {
        statusCode =
          error.code === 'audience-mismatch' ? 403 : error.code === 'invalid-upload' ? 400 : 409;
        code = `REMOTE_REVIEW_${error.code.replaceAll('-', '_').toUpperCase()}`;
      } else if (error instanceof ContractError || error instanceof z.ZodError) {
        statusCode = 400;
        code = 'INVALID_REMOTE_REVIEW';
      } else if (
        ['40001', '23505', '40P01', '55P03'].includes((error as { code?: string }).code ?? '')
      ) {
        statusCode = 409;
        code = 'REMOTE_REVIEW_ADMISSION_CHANGED';
      } else if ((error as { statusCode?: number }).statusCode === 413) {
        statusCode = 413;
        code = 'REMOTE_REVIEW_UPLOAD_TOO_LARGE';
      }
      return reply
        .code(statusCode)
        .send({
          error: { code, message: '중앙 리뷰 요청을 처리하지 못했습니다.', requestId: request.id },
        });
    });
    const base = '/api/v1/repositories/:repoId/remote-reviews';
    routes.post(
      base,
      {
        bodyLimit: REMOTE_REVIEW_MAX_BYTES + 1024,
        preHandler: requireUser,
        config: { clientModelInvoke: true },
      },
      async (request, reply) => {
        const result = await submitRemoteReviewJob(
          database,
          config,
          authorization,
          caller(request),
          request.body,
        );
        return reply.code(result.created ? 201 : 200).send(result.status);
      },
    );
    for (const kind of ['status', 'result'] as const)
      routes.get(
        `${base}/:requestId/${kind}`,
        { preHandler: requireUser, config: { clientKnowledgeRead: true } },
        async (request) => {
          const { requestId } = jobParams.parse(request.params);
          return readRemoteReviewJob(
            database,
            config,
            authorization,
            caller(request),
            requestId,
            kind === 'result',
          );
        },
      );
    routes.post(
      `${base}/:requestId/cancel`,
      { bodyLimit: 1024, preHandler: requireUser, config: { clientModelInvoke: true } },
      async (request) => {
        const { requestId } = jobParams.parse(request.params);
        const input = remoteReviewCancel(request.body);
        if (input.requestId !== requestId)
          throw new RemoteReviewJobError(409, 'REMOTE_REVIEW_REQUEST_CONFLICT');
        return cancelRemoteReviewJob(
          database,
          config,
          authorization,
          caller(request),
          requestId,
          input.payloadHash,
        );
      },
    );
  });
}
