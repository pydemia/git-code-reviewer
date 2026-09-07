import type { Database } from '@gcr/db';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import type { AuthUser } from '../auth/index.js';
import type { AppConfig } from '../config.js';
import type { AuthorizationService } from '../services/authorization.js';
import { canReadRepository, registerWorklistRoutes } from './worklist.js';

const repoId = '04eea6d9-104b-48c7-a893-1ea5e6931646';
const jobId = '62f1b4ae-8c15-4a27-8857-a4ea940acfe8';
const admin: AuthUser = {
  id: '8aff9bde-4c15-45b0-9fb2-65b70d2f98c2',
  subject: 'local:admin',
  displayName: '관리자',
  role: 'administrator',
  enabled: true,
  tenantIds: [],
  groups: [],
  tenants: [],
};
const url = `/api/v1/admin/repositories/${repoId}`;
const payload = { confirmName: 'org-name/repo-name' };

describe('review repository deletion', () => {
  it('tombstones registration, cancels queued work and removes grants in one audited transaction', async () => {
    const { app, query, connection, allowed } = await setup();
    const response = await app.inject({ method: 'DELETE', url, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ schemaVersion: 1, id: repoId, deleted: true });
    expect(allowed).toHaveBeenCalledWith(
      admin,
      'manage',
      expect.objectContaining({ id: repoId }),
      expect.any(String),
    );
    expect(query).toHaveBeenCalledWith(expect.stringContaining('deleted_at = clock_timestamp()'), [
      repoId,
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('update jobs'), [[jobId]]);
    expect(query).toHaveBeenCalledWith('delete from repository_grants where repository_id = $1', [
      repoId,
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('insert into audit_events'),
      expect.arrayContaining(['repository.delete', 'success']),
    );
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements).not.toContain(
      expect.stringMatching(/delete from (repositories|github_credentials|reports|chat_sessions)/),
    );
    expect(statements.at(-1)).toBe('commit');
    expect(connection.release).toHaveBeenCalledOnce();
    await app.close();
  });

  it.each(['reviewer', 'anonymous'] as const)('hides deletion from %s callers', async (role) => {
    const { app, database } = await setup({ role });
    expect((await app.inject({ method: 'DELETE', url, payload })).statusCode).toBe(404);
    expect(database.connect).not.toHaveBeenCalled();
    await app.close();
  });

  it('requires an exact confirmation before touching jobs or repository data', async () => {
    const { app, query } = await setup();
    const response = await app.inject({
      method: 'DELETE',
      url,
      payload: { confirmName: 'org-name/other' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('REPOSITORY_NAME_MISMATCH');
    expect(query.mock.calls.some(([sql]) => sql.includes('update repositories'))).toBe(false);
    expect(query).toHaveBeenLastCalledWith('rollback');
    await app.close();
  });

  it('rejects a missing confirmation before opening a transaction', async () => {
    const { app, database } = await setup();
    expect((await app.inject({ method: 'DELETE', url, payload: {} })).statusCode).toBe(400);
    expect(database.connect).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([{ missing: true }, { denied: true }])(
    'returns 404 for missing or unauthorized registration: %j',
    async (options) => {
      const { app, query } = await setup(options);
      expect((await app.inject({ method: 'DELETE', url, payload })).statusCode).toBe(404);
      expect(query).toHaveBeenLastCalledWith('rollback');
      await app.close();
    },
  );

  it('rejects running jobs without deleting or disabling the registration', async () => {
    const { app, query } = await setup({ running: true });
    const response = await app.inject({ method: 'DELETE', url, payload });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('REPOSITORY_BUSY');
    expect(query.mock.calls.some(([sql]) => sql.includes('update repositories'))).toBe(false);
    expect(query).toHaveBeenLastCalledWith('rollback');
    await app.close();
  });

  it('rolls back deletion if its audit cannot be persisted', async () => {
    const { app, query, connection } = await setup({ auditFailure: true });
    expect((await app.inject({ method: 'DELETE', url, payload })).statusCode).toBe(500);
    expect(query).toHaveBeenLastCalledWith('rollback');
    expect(connection.release).toHaveBeenCalledOnce();
    await app.close();
  });

  it('reports row lock timeout as retryable conflict', async () => {
    const { app } = await setup({ lockFailure: true });
    const response = await app.inject({ method: 'DELETE', url, payload });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.retryable).toBe(true);
    await app.close();
  });

  it('filters tombstones from admin and reviewer lists and shared deep-link authorization', async () => {
    const { app, query, database, authorization } = await setup({ missing: true });
    await app.inject({ method: 'GET', url: '/api/v1/admin/repositories' });
    expect(query.mock.calls.some(([sql]) => sql.includes('where r.deleted_at is null'))).toBe(true);
    query.mockClear();
    const allowed = await canReadRepository(
      database,
      authorization,
      { user: admin, id: 'test' } as never,
      repoId,
    );
    expect(allowed).toBe(false);
    expect(query.mock.calls[0]?.[0]).toContain('r.deleted_at is null');
    await app.close();
  });
});

async function setup(
  options: {
    role?: 'reviewer' | 'anonymous';
    missing?: boolean;
    denied?: boolean;
    running?: boolean;
    auditFailure?: boolean;
    lockFailure?: boolean;
  } = {},
) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('for update') && options.lockFailure)
      throw Object.assign(new Error('lock timeout'), { code: '55P03' });
    if (sql.includes('select tenant_id as'))
      return {
        rows: options.missing ? [] : [{ tenantId: admin.id, owner: 'org-name', name: 'repo-name' }],
        rowCount: options.missing ? 0 : 1,
      };
    if (sql.includes('select job.id'))
      return { rows: [{ id: jobId, state: options.running ? 'running' : 'queued' }], rowCount: 1 };
    if (sql.includes('insert into audit_events') && options.auditFailure)
      throw new Error('Audit unavailable');
    return { rows: [], rowCount: 0 };
  });
  const connection = { query, release: vi.fn() };
  const database = { query, connect: vi.fn(async () => connection) } as unknown as Database;
  const allowed = vi.fn(async () => !options.denied);
  const authorization = { isAllowed: allowed } as unknown as AuthorizationService;
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    if (options.role !== 'anonymous')
      request.user = options.role === 'reviewer' ? { ...admin, role: 'reviewer' } : admin;
  });
  app.setErrorHandler((error, _request, reply) =>
    reply.code(error instanceof ZodError ? 400 : 500).send({ error: 'test error' }),
  );
  await registerWorklistRoutes(app, database, authorization, {
    GITHUB_MODE: 'fixture',
  } as AppConfig);
  return { app, query, database, connection, allowed, authorization };
}
