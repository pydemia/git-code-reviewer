import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';

export const localHttpSessionCookie = 'gcr_http_session';

export function browserSessionCookie(request: FastifyRequest, config: AppConfig): string {
  if (config.AUTH_MODE === 'local' && config.LOCAL_HTTP_ORIGIN) {
    // A distinct name keeps an HTTP login from overwriting a Secure HTTPS cookie.
    // Mutations choose the explicitly approved browser origin, never forwarded headers.
    if (request.headers.origin === config.LOCAL_HTTP_ORIGIN) return localHttpSessionCookie;
    if (!request.cookies.gcr_session && request.cookies[localHttpSessionCookie])
      return localHttpSessionCookie;
  }
  return 'gcr_session';
}
