import { errorEnvelope } from '@gcr/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { isSamlCallback } from './saml-routes.js';

export function registerMutationOriginGuard(app: FastifyInstance, config: AppConfig) {
  app.addHook('onRequest', async (request, reply) => {
    // Only marked submission/model routes accept origin-less native client writes.
    // Their authentication hook and handler still require a scoped bearer key.
    const nativeWrite =
      (request.routeOptions.config.clientSubmissionScope ||
        request.routeOptions.config.clientModelInvoke) &&
      request.headers.authorization !== undefined &&
      request.headers.origin === undefined;
    if (
      (config.NODE_ENV === 'production' || config.AUTH_MODE === 'saml') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      !(config.AUTH_MODE === 'saml' && isSamlCallback(request)) &&
      !nativeWrite &&
      !sameOrigin(request, config)
    ) {
      return reply
        .code(403)
        .send(errorEnvelope('INVALID_ORIGIN', '허용되지 않은 요청입니다.', request.id));
    }
  });
}
function sameOrigin(request: FastifyRequest, config: AppConfig): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    const expected = new URL(config.PUBLIC_BASE_URL ?? `${request.protocol}://${request.host}`);
    return origin === parsed.origin && parsed.origin === expected.origin;
  } catch {
    return false;
  }
}
