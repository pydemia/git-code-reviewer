import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { registerMutationOriginGuard } from './mutation-origin.js';

const base = {
  DATABASE_URL: 'postgresql://unused/db',
  AUTH_MODE: 'local',
  NODE_ENV: 'production',
  PUBLIC_BASE_URL: 'https://gcr.test',
  LOCAL_BOOTSTRAP_ADMIN_USERNAME: 'fixture',
  LOCAL_BOOTSTRAP_ADMIN_PASSWORD: 'Synthetic-password-for-tests',
};
describe('HTTP local access configuration', () => {
  it('is opt-in and requires an exact same-host HTTP origin and local auth', () => {
    expect(loadConfig(base).LOCAL_HTTP_ORIGIN).toBeUndefined();
    expect(
      loadConfig({ ...base, LOCAL_HTTP_ORIGIN: 'http://gcr.test:8080' }).LOCAL_HTTP_ORIGIN,
    ).toBe('http://gcr.test:8080');
    for (const origin of [
      'https://gcr.test',
      'http://other.test',
      'http://gcr.test/',
      'http://gcr.test/path',
      'http://user:pass@gcr.test',
      'http://gcr.test?x=y',
      'http://gcr.test#hash',
    ])
      expect(() => loadConfig({ ...base, LOCAL_HTTP_ORIGIN: origin })).toThrow('LOCAL_HTTP_ORIGIN');
    for (const mode of ['saml', 'oidc', 'proxy', 'development'])
      expect(() =>
        loadConfig({ ...base, AUTH_MODE: mode, LOCAL_HTTP_ORIGIN: 'http://gcr.test' }),
      ).toThrow('LOCAL_HTTP_ORIGIN');
  });
  it('keeps HTTPS-only deployments closed to HTTP origins', async () => {
    const app = Fastify();
    registerMutationOriginGuard(app, loadConfig(base));
    app.post('/write', async () => ({ ok: true }));
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/write',
            headers: { origin: 'http://gcr.test' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/write',
            headers: { origin: 'https://gcr.test' },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });
});
