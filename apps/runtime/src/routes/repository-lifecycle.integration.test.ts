import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../auth/index.js';
import { loadConfig } from '../config.js';
import { createGitHubConnection, registerGitHubRepository } from '../services/account-registry.js';
import { AuthorizationService } from '../services/authorization.js';
import { enqueueSnapshot, requestPullRefresh } from '../services/operations.js';
import { ensureFixtureRepository, pollRepository } from '../services/repositories.js';
import { enqueueLatestReviewPublication } from '../services/review-publication.js';
import { registerAccountRegistryRoutes } from './account-registry.js';
import { registerWorklistRoutes } from './worklist.js';

// 전용 local PostgreSQL만 사용하며 매 실행마다 별도 schema를 만들고 정리한다.
const databaseUrl = process.env.GCR_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl).sequential('repository lifecycle with PostgreSQL', () => {
  const schema = `gcr_test_${randomUUID().replaceAll('-', '')}`;
  let root: Database;
  let database: Database;
  let app: FastifyInstance;
  let admin: AuthUser;
  let credentialId: string;
  let tenantId: string;
  let githubId = 1000;
  const config = loadConfig({
    DATABASE_URL: 'postgresql://localhost/unused',
    AUTH_MODE: 'development',
    GITHUB_MODE: 'fixture',
    CREDENTIAL_REGISTRY_ENABLED: 'true',
    CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  });
  const fetcher = vi.fn();

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Use an isolated local test PostgreSQL');
    root = createDatabase(url.toString());
    await root.query(`create schema ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    database = createDatabase(url.toString());
    await runMigrations(database, path.resolve('packages/db/migrations'));
    tenantId = (await database.query("select id from tenants where slug = 'default'")).rows[0].id;
    const result = await database.query(
      "insert into users(oidc_subject, display_name, role) values ('local:synthetic-admin', '검증 관리자', 'administrator') returning id",
    );
    admin = {
      id: result.rows[0].id,
      subject: 'local:synthetic-admin',
      displayName: '검증 관리자',
      role: 'administrator',
      enabled: true,
      groups: [],
      tenantIds: [tenantId],
      tenants: [],
    };
    await database.query(
      "insert into users(oidc_subject, display_name, role) values ('local:reviewer', '검증 사용자', 'reviewer')",
    );
    await database.query(
      'insert into tenant_memberships(tenant_id, user_id) select $1, id from users',
      [tenantId],
    );
    credentialId = await createGitHubConnection(database, config, admin.id, {
      name: 'GitHub test',
      apiBaseUrl: 'https://api.github.com',
      webBaseUrl: 'https://github.com',
      credentialLabel: 'synthetic',
      accessToken: 'synthetic-token-no-network',
    });
    await database.query("update github_credentials set health = 'ready' where id = $1", [
      credentialId,
    ]);
    vi.stubGlobal('fetch', fetcher);
    app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.user = admin;
    });
    await registerWorklistRoutes(app, database, new AuthorizationService(config), config);
    await registerAccountRegistryRoutes(app, database, config);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app?.close();
    await database?.end();
    if (root) {
      await root.query(`drop schema if exists ${schema} cascade`);
      await root.end();
    }
  });

  async function seed() {
    githubId += 1;
    const name = `repo-name-${githubId}`;
    const currentId = githubId;
    fetcher.mockImplementation(async () =>
      Response.json({ id: currentId, owner: { login: 'org-name' }, name }),
    );
    const repositoryId = await registerGitHubRepository(database, config, credentialId, {
      tenantId,
      repositoryUrl: `https://github.com/org-name/${name}/`,
      pollIntervalSeconds: 120,
      reviewPublishingEnabled: true,
      grantSubjects: ['local:reviewer'],
    });
    const pull = await database.query(
      `insert into pull_requests(repository_id, github_id, number, title, state, author_login, html_url, base_ref, base_sha, head_ref, head_sha, github_updated_at)
       values ($1, $2, 1, '검증 PR', 'open', 'synthetic-user', 'https://github.com/org-name/repo-name/pull/1', 'main', $3, 'feature', $4, clock_timestamp()) returning id`,
      [repositoryId, currentId, 'a'.repeat(40), 'b'.repeat(40)],
    );
    const pullId = pull.rows[0].id;
    const connection = await database.connect();
    try {
      await connection.query('begin');
      await enqueueSnapshot(connection, pullId, 'a'.repeat(40), 'b'.repeat(40), null, 'poll');
      await connection.query('commit');
    } finally {
      connection.release();
    }
    return { repositoryId, pullId, name, currentId };
  }

  const remove = (target: { repositoryId: string; name: string }) =>
    app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/repositories/${target.repositoryId}`,
      payload: { confirmName: `org-name/${target.name}` },
    });

  it('registers a URL with a selected user and keeps a single reviewer grant on retry', async () => {
    githubId += 1;
    const currentId = githubId;
    const name = `repo-name-${currentId}`;
    fetcher.mockImplementation(async () =>
      Response.json({ id: currentId, owner: { login: 'org-name' }, name }),
    );
    const request = {
      method: 'POST' as const,
      url: `/api/v1/admin/github-connections/${credentialId}/repositories`,
      payload: {
        tenantId,
        repositoryUrl: `https://github.com/org-name/${name}/`,
        grantSubjects: ['local:reviewer'],
      },
    };
    const response = await app.inject(request);
    expect(response.statusCode).toBe(201);
    const repositoryId = response.json().id;
    const retry = await app.inject(request);
    expect(retry.statusCode).toBe(201);
    expect(retry.json().id).toBe(repositoryId);
    expect(
      (
        await database.query(
          'select subject_or_group, role from repository_grants where repository_id = $1',
          [repositoryId],
        )
      ).rows,
    ).toEqual([{ subject_or_group: 'local:reviewer', role: 'reviewer' }]);
    expect(
      (await database.query('select 1 from poll_states where repository_id = $1', [repositoryId]))
        .rowCount,
    ).toBe(1);
  });

  it('deletes registration without erasing history or credentials; re-registration restores it without old grants', async () => {
    const target = await seed();
    expect((await remove(target)).statusCode).toBe(200);
    const row = (
      await database.query('select * from repositories where id = $1', [target.repositoryId])
    ).rows[0];
    expect(row.deleted_at).toBeTruthy();
    expect([row.enabled, row.polling_enabled, row.review_publishing_enabled]).toEqual([
      false,
      false,
      false,
    ]);
    expect(
      (
        await database.query('select 1 from repository_grants where repository_id = $1', [
          target.repositoryId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (await database.query('select 1 from pull_requests where id = $1', [target.pullId])).rowCount,
    ).toBe(1);
    expect(
      (
        await database.query(
          'select enabled, credential_version from github_credentials where id = $1',
          [credentialId],
        )
      ).rows[0],
    ).toEqual({ enabled: true, credential_version: 1 });
    expect(
      (
        await database.query(
          "select state, last_error->>'code' as code from jobs where payload->>'pullRequestId' = $1",
          [target.pullId],
        )
      ).rows,
    ).toEqual([{ state: 'failed', code: 'REPOSITORY_DELETED' }]);
    expect(
      (await database.query('select state from operations where scope_id = $1', [target.pullId]))
        .rows[0].state,
    ).toBe('failed');
    const listed = (await app.inject({ method: 'GET', url: '/api/v1/admin/repositories' })).json();
    expect(listed.items.some((item: { id: string }) => item.id === target.repositoryId)).toBe(
      false,
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/repositories/${target.repositoryId}/pulls`,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/admin/repositories/${target.repositoryId}`,
          payload: { enabled: true },
        })
      ).statusCode,
    ).toBe(404);
    expect((await remove(target)).statusCode).toBe(404);
    expect(await requestPullRefresh(database, target.repositoryId, 1, admin.id)).toBeNull();
    expect(await enqueueLatestReviewPublication(database, target.repositoryId, false)).toBe(false);
    expect(
      await registerGitHubRepository(database, config, credentialId, {
        tenantId,
        repositoryUrl: `https://github.com/org-name/${target.name}/`,
        pollIntervalSeconds: 120,
        reviewPublishingEnabled: false,
        grantSubjects: [],
      }),
    ).toBe(target.repositoryId);
    expect(
      (
        await database.query('select deleted_at, enabled from repositories where id = $1', [
          target.repositoryId,
        ])
      ).rows[0],
    ).toEqual({ deleted_at: null, enabled: true });
    expect(
      (
        await database.query('select 1 from repository_grants where repository_id = $1', [
          target.repositoryId,
        ])
      ).rowCount,
    ).toBe(0);
  });

  it('does not delete while a Worker is running, then cancels the remaining queued work', async () => {
    const target = await seed();
    await database.query("update jobs set state = 'running' where payload->>'pullRequestId' = $1", [
      target.pullId,
    ]);
    const response = await remove(target);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('REPOSITORY_BUSY');
    expect(
      (
        await database.query('select deleted_at from repositories where id = $1', [
          target.repositoryId,
        ])
      ).rows[0].deleted_at,
    ).toBeNull();
    await database.query(
      "update jobs set state = 'completed' where payload->>'pullRequestId' = $1",
      [target.pullId],
    );
    expect((await remove(target)).statusCode).toBe(200);
  });

  it('does not recreate a deleted fixture on Server restart', async () => {
    await ensureFixtureRepository(database);
    const fixture = (
      await database.query("select id from repositories where installation_id = 'fixture'")
    ).rows[0];
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/repositories/${fixture.id}`,
      payload: { confirmName: 'platform/reviewer-api' },
    });
    expect(response.statusCode).toBe(200);
    await ensureFixtureRepository(database);
    expect(
      (await database.query('select deleted_at from repositories where id = $1', [fixture.id]))
        .rows[0].deleted_at,
    ).toBeTruthy();
  });

  it('drops an in-flight poll observation after deletion without enqueueing new work', async () => {
    const target = await seed();
    // Fixture reader로 실행 경합만 확인하며 외부 GitHub 요청은 보내지 않는다.
    await database.query('update repositories set credential_id = null where id = $1', [
      target.repositoryId,
    ]);
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const polling = pollRepository(
      database,
      {
        listOpenPulls: async () => {
          started();
          await pending;
          return { outcome: 'updated' as const, pulls: [] };
        },
      },
      target.repositoryId,
    );
    await ready;
    try {
      expect((await remove(target)).statusCode).toBe(200);
    } finally {
      release();
    }
    await polling;
    expect(
      (
        await database.query(
          "select 1 from jobs where payload->>'pullRequestId' = $1 and state = 'queued'",
          [target.pullId],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (await database.query('select state from pull_requests where id = $1', [target.pullId]))
        .rows[0].state,
    ).toBe('open');
  });
});
