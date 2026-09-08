import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerAuthentication, requireUser, type AuthUser } from '../auth/index.js';
import { loadConfig } from '../config.js';
import { AuthorizationService } from '../services/authorization.js';
import { hashLocalPassword } from '../services/local-accounts.js';
import { registerAdminRoutes } from './admin.js';

const databaseUrl = process.env.GCR_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl).sequential('user deletion with PostgreSQL', () => {
  const schema = `gcr_user_delete_${randomUUID().replaceAll('-', '')}`;
  let root: Database, database: Database, app: FastifyInstance;
  let admin: AuthUser, target: AuthUser, tenantId: string;
  let passwordHash: string;
  const config = loadConfig({
    DATABASE_URL: 'postgresql://localhost/unused',
    AUTH_MODE: 'local',
    LOCAL_BOOTSTRAP_ADMIN_USERNAME: 'delete-admin',
    LOCAL_BOOTSTRAP_ADMIN_PASSWORD: 'test-password',
    LOCAL_BOOTSTRAP_REVIEWER_USERNAME: 'delete-target',
    LOCAL_BOOTSTRAP_REVIEWER_PASSWORD: 'test-password',
    AUTO_JOIN_DEFAULT_TENANT: 'true',
  });
  const authorization = new AuthorizationService(config);
  const actors = new Map<string, AuthUser>();
  const remove = (
    user: AuthUser,
    actor = admin,
    confirmation = user.subject.replace(/^local:/, ''),
  ) =>
    app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/users/${user.id}`,
      headers: { 'x-test-actor': actor.id },
      payload: { confirmIdentity: confirmation },
    });
  async function seed(name: string, role: 'reviewer' | 'administrator' = 'reviewer') {
    const row = (
      await database.query(
        'insert into users(oidc_subject, display_name, role) values ($1, $2, $3) returning id',
        [`local:${name}`, '합성 검증 사용자', role],
      )
    ).rows[0];
    await database.query(
      'insert into local_credentials(user_id,username,password_hash) values ($1,$2,$3)',
      [row.id, name, passwordHash],
    );
    const user: AuthUser = {
      id: row.id,
      subject: `local:${name}`,
      displayName: '합성 검증 사용자',
      role,
      groups: [],
      enabled: true,
      tenantIds: [tenantId],
      tenants: [],
    };
    actors.set(user.id, user);
    return user;
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw Error('Use an isolated local test PostgreSQL');
    root = createDatabase(url.toString());
    await root.query(`create schema ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    database = createDatabase(url.toString());
    await runMigrations(database, path.resolve('packages/db/migrations'));
    await runMigrations(database, path.resolve('packages/db/migrations'));
    tenantId = (await database.query("select id from tenants where slug='default'")).rows[0].id;
    passwordHash = await hashLocalPassword('test-password');
    admin = await seed('delete-admin', 'administrator');
    target = await seed('delete-target');
    app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.user = actors.get(String(request.headers['x-test-actor'])) ?? null;
    });
    app.setErrorHandler((error, _request, reply) =>
      reply.code(error instanceof ZodError ? 400 : 500).send({ error: error.message }),
    );
    await registerAdminRoutes(app, database, authorization, config);
  });
  afterAll(async () => {
    await app?.close();
    await database?.end();
    if (root) {
      await root.query(`drop schema if exists ${schema} cascade`);
      await root.end();
    }
  });
  it('requires administrator and policy permission; validates identity and self deletion', async () => {
    expect((await remove(target, target)).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/users/${target.id}`,
          payload: { confirmIdentity: 'delete-target' },
        })
      ).statusCode,
    ).toBe(404);
    const denied = vi.spyOn(authorization, 'isAllowed').mockResolvedValueOnce(false);
    expect((await remove(target)).statusCode).toBe(404);
    denied.mockRestore();
    expect((await remove(target, admin, 'wrong-name')).json().error.code).toBe(
      'USER_DELETE_CONFIRMATION_MISMATCH',
    );
    expect((await remove(admin)).json().error.code).toBe('SELF_DELETE_NOT_ALLOWED');
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/users/${target.id}`,
          headers: { 'x-test-actor': admin.id },
          payload: { confirmIdentity: 'delete-target', force: true },
        })
      ).statusCode,
    ).toBe(400);
    expect((await remove({ ...target, id: randomUUID() })).statusCode).toBe(404);
  });
  it('preserves shared references and private history while removing credentials, sessions and grants', async () => {
    await database.query('insert into tenant_memberships(tenant_id,user_id) values ($1,$2)', [
      tenantId,
      target.id,
    ]);
    await database.query(
      "update users set personal_prompt='synthetic private prompt' where id=$1",
      [target.id],
    );
    await database.query(
      "insert into user_sessions(id_hash,user_id,expires_at) values ($1,$2,clock_timestamp()+interval '1 hour')",
      [createHash('sha256').update('old-token').digest('hex'), target.id],
    );
    const instance = (
      await database.query(
        "insert into github_instances(name,api_base_url,web_base_url) values ('synthetic','https://api.example','https://example') returning id",
      )
    ).rows[0].id;
    const repository = (
      await database.query(
        "insert into repositories(instance_id,github_id,installation_id,owner,name,tenant_id) values ($1,1,'fixture','org-name','repo-name',$2) returning id",
        [instance, tenantId],
      )
    ).rows[0].id;
    await database.query(
      "insert into repository_grants(repository_id,subject_or_group,role) values ($1,$2,'reviewer'),($1,'shared-group','viewer')",
      [repository, target.subject],
    );
    const pull = (
      await database.query(
        "insert into pull_requests(repository_id,github_id,number,title,state,author_login,html_url,base_ref,base_sha,head_ref,head_sha,github_updated_at) values ($1,1,1,'synthetic','open','synthetic','https://example/pr/1','main',$2,'feature',$3,clock_timestamp()) returning id",
        [repository, 'a'.repeat(40), 'b'.repeat(40)],
      )
    ).rows[0].id;
    const request = (
      await database.query(
        'insert into snapshot_requests(pull_request_id,base_sha,head_sha) values ($1,$2,$3) returning id',
        [pull, 'a'.repeat(40), 'b'.repeat(40)],
      )
    ).rows[0].id;
    const snapshot = (
      await database.query(
        "insert into snapshots(request_id,version,resolution,policy_version) values ($1,1,'exact','synthetic') returning id",
        [request],
      )
    ).rows[0].id;
    const run = (
      await database.query(
        "insert into analysis_runs(snapshot_id,analysis_key,state) values ($1,'synthetic-analysis','queued') returning id",
        [snapshot],
      )
    ).rows[0].id;
    const operation = (
      await database.query(
        "insert into operations(type,scope_type,scope_id,state,dedupe_key,requested_by) values ('refresh','pull_request',$1,'completed','synthetic-operation',$2) returning id",
        [pull, target.id],
      )
    ).rows[0].id;
    const session = (
      await database.query(
        'insert into chat_sessions(analysis_run_id,user_id) values ($1,$2) returning id',
        [run, target.id],
      )
    ).rows[0].id;
    await database.query(
      "insert into chat_messages(session_id,role,status,content) values ($1,'user','completed','synthetic history')",
      [session],
    );
    expect((await remove(target)).statusCode).toBe(204);
    const row = (
      await database.query('select enabled,personal_prompt,deleted_at from users where id=$1', [
        target.id,
      ])
    ).rows[0];
    expect(row).toMatchObject({ enabled: false, personal_prompt: '' });
    expect(row.deleted_at).not.toBeNull();
    expect(
      (await database.query('select * from user_sessions where user_id=$1', [target.id])).rowCount,
    ).toBe(0);
    expect(
      (
        await database.query('select * from tenant_memberships where user_id=$1 and enabled', [
          target.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await database.query(
          'select subject_or_group from repository_grants where repository_id=$1',
          [repository],
        )
      ).rows,
    ).toEqual([{ subject_or_group: 'shared-group' }]);
    expect(
      (
        await database.query('select password_hash from local_credentials where user_id=$1', [
          target.id,
        ])
      ).rows[0].password_hash,
    ).toBe('!deleted');
    expect(
      (await database.query('select requested_by from operations where id=$1', [operation])).rows[0]
        .requested_by,
    ).toBe(target.id);
    expect(
      (await database.query('select * from chat_messages where session_id=$1', [session])).rowCount,
    ).toBe(1);
    const list = await app.inject({
      url: '/api/v1/admin/users',
      headers: { 'x-test-actor': admin.id },
    });
    expect(list.json().items.map((u: { id: string }) => u.id)).not.toContain(target.id);
    const audit = (await database.query("select * from audit_events where action='user.delete'"))
      .rows;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('synthetic private prompt');
  });
  it('does not allow reactivation, membership, password reset, repeated deletion or identity reuse', async () => {
    for (const [method, url, payload] of [
      ['PATCH', `/api/v1/admin/users/${target.id}`, { enabled: true }],
      ['PUT', `/api/v1/admin/users/${target.id}/password`, { password: 'new-password' }],
      ['PUT', `/api/v1/admin/tenants/${tenantId}/members/${target.id}`, { enabled: true }],
      [
        'POST',
        '/api/v1/admin/users',
        {
          username: 'delete-target',
          displayName: '새 사용자',
          role: 'reviewer',
          password: 'new-password',
          tenantIds: [tenantId],
        },
      ],
    ] as const) {
      expect(
        (await app.inject({ method, url, headers: { 'x-test-actor': admin.id }, payload }))
          .statusCode,
      ).toBeGreaterThanOrEqual(400);
    }
    expect((await remove(target)).statusCode).toBe(404);
    await expect(
      database.query('update users set enabled=true where id=$1', [target.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('bootstrap and existing sessions cannot restore a deleted local account', async () => {
    const auth = Fastify();
    await registerAuthentication(auth, config, database);
    auth.get('/api/v1/me', { preHandler: requireUser }, async (request) => request.user);
    const login = await auth.inject({
      method: 'POST',
      url: '/auth/local/login',
      payload: { username: 'delete-target', password: 'test-password' },
    });
    expect(login.statusCode).toBe(401);
    expect(
      (await auth.inject({ url: '/api/v1/me', cookies: { gcr_session: 'old-token' } })).statusCode,
    ).toBe(401);
    await auth.close();
    expect(
      (
        await database.query('select * from tenant_memberships where user_id=$1 and enabled', [
          target.id,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it('identity upsert cannot restore a deleted external subject or cache its access', async () => {
    const external = await seed('external-target');
    await database.query('delete from local_credentials where user_id=$1', [external.id]);
    const auth = Fastify();
    await registerAuthentication(
      auth,
      { ...config, AUTH_MODE: 'development', DEV_USER_SUBJECT: external.subject },
      database,
    );
    auth.get('/api/v1/me', { preHandler: requireUser }, async (request) => request.user);
    expect((await auth.inject('/api/v1/me')).statusCode).toBe(200);
    expect((await remove(external, admin, external.subject)).statusCode).toBe(204);
    expect((await auth.inject('/api/v1/me')).statusCode).toBe(401);
    expect((await auth.inject('/api/v1/me')).statusCode).toBe(401);
    await auth.close();
  });
  it('rolls back the deletion when the audit insert fails', async () => {
    const user = await seed('rollback-target');
    await database.query(
      `create function fail_delete_audit() returns trigger language plpgsql as $$ begin if new.action='user.delete' then raise exception 'synthetic audit failure'; end if; return new; end $$`,
    );
    await database.query(
      'create trigger fail_delete_audit before insert on audit_events for each row execute function fail_delete_audit()',
    );
    try {
      expect((await remove(user)).statusCode).toBe(500);
    } finally {
      await database.query('drop trigger fail_delete_audit on audit_events');
    }
    expect(
      (await database.query('select enabled,deleted_at from users where id=$1', [user.id])).rows[0],
    ).toEqual({ enabled: true, deleted_at: null });
    expect(
      (
        await database.query('select password_hash from local_credentials where user_id=$1', [
          user.id,
        ])
      ).rows[0].password_hash,
    ).toBe(passwordHash);
  });
  it('serializes simultaneous administrator deletions and rejects a stale administrator', async () => {
    const second = await seed('second-admin', 'administrator');
    const result = await Promise.all([remove(second, admin), remove(admin, second)]);
    expect(result.map((r) => r.statusCode).sort()).toEqual([204, 404]);
    const remaining = await database.query(
      "select id from users where enabled and deleted_at is null and role='administrator'",
    );
    expect(remaining.rowCount).toBe(1);
    const deleted = remaining.rows[0].id === admin.id ? second : admin;
    const survivor = actors.get(remaining.rows[0].id)!;
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${survivor.id}`,
      headers: { 'x-test-actor': deleted.id },
      payload: { enabled: false },
    });
    expect(patch.statusCode).toBe(404);
    expect((await remove(survivor, survivor)).json().error.code).toBe('SELF_DELETE_NOT_ALLOWED');
  });
});
