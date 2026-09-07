import cookie from '@fastify/cookie';
import type { Database } from '@gcr/db';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../auth/index.js';
import type { AppConfig } from '../config.js';
import { hashLocalPassword, verifyLocalPassword } from '../services/local-accounts.js';
import { registerProfileRoutes } from './profile.js';

const user: AuthUser = {
  id: '04eea6d9-104b-48c7-a893-1ea5e6931646',
  subject: 'local:reviewer',
  displayName: '리뷰 담당자',
  role: 'reviewer',
  enabled: true,
  groups: [],
  tenants: [],
};

const config = { AUTH_MODE: 'local' } as AppConfig;
const credentialRow = (passwordHash: string) => ({
  username: 'reviewer',
  passwordHash,
  passwordChangedAt: new Date('2026-09-07T00:00:00.000Z'),
});

describe('profile routes', () => {
  it('accepts an 8-character password and invalidates every session', async () => {
    const currentHash = await hashLocalPassword('current-password');
    let updatedHash = '';
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('from local_credentials')) {
        return { rows: [credentialRow(currentHash)], rowCount: 1 };
      }
      if (sql.includes('from local_login_limits')) return { rows: [], rowCount: 0 };
      if (sql.includes('update local_credentials')) updatedHash = String(values?.[1] ?? '');
      return { rows: [], rowCount: 1 };
    });
    const connection = { query, release: vi.fn() };
    const database = { connect: vi.fn(async () => connection) } as unknown as Database;
    const app = await profileTestApp(database);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/profile/password',
      payload: { currentPassword: 'current-password', newPassword: '12345678' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ schemaVersion: 1, reauthenticate: true });
    expect(await verifyLocalPassword('12345678', updatedHash)).toBe(true);
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('delete from user_sessions')),
    ).toBe(true);
    expect(response.headers['set-cookie']).toContain('gcr_session=');
    expect(connection.release).toHaveBeenCalledOnce();
    await app.close();
  });

  it('rejects a 7-character password before opening a transaction', async () => {
    const database = { query: vi.fn(), connect: vi.fn() } as unknown as Database;
    const app = await profileTestApp(database);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/profile/password',
      payload: { currentPassword: 'current-password', newPassword: '1234567' },
    });

    expect(response.statusCode).toBe(400);
    expect(database.connect).not.toHaveBeenCalled();
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('insert into audit_events'),
      expect.arrayContaining(['user.password.change', 'failure']),
    );
    await app.close();
  });

  it('rolls back the profile update when its audit event cannot be stored', async () => {
    const currentHash = await hashLocalPassword('current-password');
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('update users')) {
        return { rows: [{ displayName: '새 표시 이름' }], rowCount: 1 };
      }
      if (sql.includes('from local_credentials')) {
        return { rows: [credentialRow(currentHash)], rowCount: 1 };
      }
      if (sql.includes('insert into audit_events')) throw new Error('audit unavailable');
      return { rows: [], rowCount: 1 };
    });
    const connection = { query, release: vi.fn() };
    const database = { connect: vi.fn(async () => connection) } as unknown as Database;
    const app = await profileTestApp(database);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/profile',
      payload: { displayName: '새 표시 이름' },
    });

    expect(response.statusCode).toBe(500);
    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual([
      'begin',
      expect.stringContaining('update users'),
      expect.stringContaining('from local_credentials'),
      expect.stringContaining('insert into audit_events'),
      'rollback',
    ]);
    expect(connection.release).toHaveBeenCalledOnce();
    await app.close();
  });

  it('records a failed audit event when the current password is wrong', async () => {
    const currentHash = await hashLocalPassword('current-password');
    const { database, query, connection } = passwordDatabase(currentHash);
    const app = await profileTestApp(database);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/profile/password',
      payload: { currentPassword: 'wrong-password', newPassword: '12345678' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('CURRENT_PASSWORD_INVALID');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('local_login_limits'))).toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('insert into audit_events'),
      expect.arrayContaining(['user.password.change', 'failure']),
    );
    expect(query).toHaveBeenCalledWith('commit');
    expect(connection.release).toHaveBeenCalledOnce();
    await app.close();
  });

  it('rejects an unchanged password and clears prior verification failures', async () => {
    const currentHash = await hashLocalPassword('same-password');
    const { database, query } = passwordDatabase(currentHash);
    const app = await profileTestApp(database);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/profile/password',
      payload: { currentPassword: 'same-password', newPassword: 'same-password' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('PASSWORD_UNCHANGED');
    expect(query).toHaveBeenCalledWith(
      'delete from local_login_limits where username_hash = $1',
      expect.any(Array),
    );
    expect(query.mock.calls.some(([sql]) => String(sql).includes('update local_credentials'))).toBe(
      false,
    );
    await app.close();
  });

  it('returns an external profile and rejects application-side changes', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('from local_credentials')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    const database = { query, connect: vi.fn() } as unknown as Database;
    const app = await profileTestApp(database, { AUTH_MODE: 'oidc' } as AppConfig);

    const profileResponse = await app.inject({ method: 'GET', url: '/api/v1/profile' });
    const passwordResponse = await app.inject({
      method: 'PUT',
      url: '/api/v1/profile/password',
      payload: { currentPassword: 'current-password', newPassword: '12345678' },
    });

    expect(profileResponse.json()).toMatchObject({
      identityType: 'external',
      username: null,
      profileEditable: false,
      passwordChangeAllowed: false,
    });
    expect(passwordResponse.statusCode).toBe(409);
    expect(passwordResponse.json().error.code).toBe('PASSWORD_MANAGED_EXTERNALLY');
    expect(database.connect).not.toHaveBeenCalled();
    await app.close();
  });
});

function passwordDatabase(currentHash: string) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('from local_credentials')) {
      return { rows: [credentialRow(currentHash)], rowCount: 1 };
    }
    if (sql.includes('from local_login_limits')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  });
  const connection = { query, release: vi.fn() };
  const database = { connect: vi.fn(async () => connection) } as unknown as Database;
  return { database, query, connection };
}

async function profileTestApp(database: Database, appConfig = config) {
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRequest', async (request) => {
    request.user = user;
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = error.name === 'ZodError' ? 400 : 500;
    return reply.code(status).send({ error: error.message });
  });
  await registerProfileRoutes(app, database, appConfig);
  return app;
}
