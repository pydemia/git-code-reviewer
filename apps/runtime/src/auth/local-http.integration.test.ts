import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Fastify from 'fastify';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { registerAuthentication, requireUser } from './index.js';
import { registerMutationOriginGuard } from './mutation-origin.js';

const databaseUrl = process.env.GCR_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl).sequential('opt-in HTTP local sessions with HTTPS preserved', () => {
  const schema = `http_auth_${randomUUID().replaceAll('-', '')}`;
  let root: Database, database: Database;
  const app = Fastify();
  const https = 'https://gcr.test',
    http = 'http://gcr.test';
  const password = 'Synthetic-local-test-password!';
  let secureCookie: string, httpCookie: string;
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw Error('Local test DB only');
    root = createDatabase(url.href);
    await root.query(`create schema ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    database = createDatabase(url.href);
    await runMigrations(database, path.resolve('packages/db/migrations'));
    const config = loadConfig({
      DATABASE_URL: url.href,
      NODE_ENV: 'production',
      AUTH_MODE: 'local',
      PUBLIC_BASE_URL: https,
      LOCAL_HTTP_ORIGIN: http,
      SESSION_SECRET: 'fixture-session-secret-with-32-characters',
      LOCAL_BOOTSTRAP_ADMIN_USERNAME: 'fixture-admin',
      LOCAL_BOOTSTRAP_ADMIN_PASSWORD: password,
    });
    registerMutationOriginGuard(app, config);
    await registerAuthentication(app, config, database);
    app.get('/whoami', { preHandler: requireUser }, async (request) => ({ id: request.user!.id }));
    app.post('/write', { preHandler: requireUser }, async () => ({ ok: true }));
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await database?.end();
    if (root) {
      await root.query(`drop schema ${schema} cascade`);
      await root.end();
    }
  });
  it('retains Secure HTTPS cookies behind HTTP TLS termination', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/local/login',
      headers: { origin: https, 'x-forwarded-proto': 'http' },
      payload: { username: 'fixture-admin', password },
    });
    expect(r.statusCode).toBe(200);
    const cookie = String(r.headers['set-cookie']);
    expect(cookie).toContain('gcr_session=');
    expect(cookie).toContain('; Secure');
    expect(cookie).toContain('; HttpOnly');
    secureCookie = cookie.split(';')[0]!;
  });
  it('uses a separate HTTP cookie and authenticates reads and writes', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/local/login',
      headers: { origin: http, cookie: secureCookie },
      payload: { username: 'fixture-admin', password },
    });
    expect(r.statusCode).toBe(200);
    const cookie = String(r.headers['set-cookie']);
    expect(cookie).toContain('gcr_http_session=');
    expect(cookie).not.toContain('; Secure');
    expect(cookie).toContain('; HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    httpCookie = cookie.split(';')[0]!;
    expect((await app.inject({ url: '/whoami', headers: { cookie: httpCookie } })).statusCode).toBe(
      200,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/write',
          headers: { origin: http, cookie: httpCookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/write',
          headers: { origin: https, cookie: secureCookie },
        })
      ).statusCode,
    ).toBe(200);
  });
  it('rejects missing/foreign origins even with proxy headers and a valid cookie', async () => {
    for (const origin of [undefined, 'https://attacker.test', 'http://gcr.test:444', 'null']) {
      const r = await app.inject({
        method: 'POST',
        url: '/write',
        headers: {
          ...(origin ? { origin } : {}),
          cookie: httpCookie,
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'gcr.test',
        },
      });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe('INVALID_ORIGIN');
    }
  });
  it('logs HTTP out without deleting the independent HTTPS session', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { origin: http, cookie: `${secureCookie}; ${httpCookie}` },
    });
    expect(r.statusCode).toBe(204);
    expect(String(r.headers['set-cookie'])).toContain('gcr_http_session=;');
    expect((await app.inject({ url: '/whoami', headers: { cookie: httpCookie } })).statusCode).toBe(
      401,
    );
    expect(
      (await app.inject({ url: '/whoami', headers: { cookie: secureCookie } })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/logout',
          headers: { origin: https, cookie: secureCookie },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ url: '/whoami', headers: { cookie: secureCookie } })).statusCode,
    ).toBe(401);
  });
});
