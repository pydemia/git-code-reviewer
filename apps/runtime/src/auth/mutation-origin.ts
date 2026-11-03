import { errorEnvelope } from '@gcr/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { isSamlCallback } from './saml-routes.js';

export function registerMutationOriginGuard(app: FastifyInstance, config: AppConfig) {
  app.addHook('onRequest', async (request, reply) => {
    // Only marked submission routes accept origin-less native client writes.
    // Their authentication hook and handler still require a scoped bearer key.
    const nativeSubmission =
      request.routeOptions.config.clientSubmissionScope &&
      request.headers.authorization !== undefined &&
      request.headers.origin === undefined;
    if (
      (config.NODE_ENV === 'production' || config.AUTH_MODE === 'saml') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      !(config.AUTH_MODE === 'saml' && isSamlCallback(request)) &&
      !nativeSubmission &&
      !isAllowedBrowserOrigin(request, config)
    ) {
      return reply
        .code(403)
        .send(errorEnvelope('INVALID_ORIGIN', '허용되지 않은 요청입니다.', request.id));
    }
  });
}
export function isAllowedBrowserOrigin(request: FastifyRequest, config: AppConfig): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    const expected = new URL(config.PUBLIC_BASE_URL ?? `${request.protocol}://${request.host}`);
    return (
      origin === parsed.origin &&
      (parsed.origin === expected.origin ||
        (config.AUTH_MODE === 'local' && origin === config.LOCAL_HTTP_ORIGIN))
    );
  } catch {
    return false;
  }
}
