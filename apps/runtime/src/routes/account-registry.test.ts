import { randomBytes } from 'node:crypto';
import type { Database } from '@gcr/db';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorEnvelope } from '@gcr/contracts';
import type { AuthUser } from '../auth/index.js';
import type { AppConfig } from '../config.js';
import { GitHubRegistryError, registeredGitHubReader } from '../services/account-registry.js';
import { credentialFingerprint, encryptCredential } from '../services/credential-crypto.js';
import { registerAccountRegistryRoutes } from './account-registry.js';

const credentialId = '04eea6d9-104b-48c7-a893-1ea5e6931646';
const instanceId = '62f1b4ae-8c15-4a27-8857-a4ea940acfe8';
const administrator: AuthUser = {
  id: '8aff9bde-4c15-45b0-9fb2-65b70d2f98c2',
  subject: 'local:admin',
  displayName: '시스템관리자',
  role: 'administrator',
  enabled: true,
  groups: [],
  tenants: [],
};
const config = {
  CREDENTIAL_REGISTRY_ENABLED: true,
  CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
} as AppConfig;

afterEach(() => vi.unstubAllGlobals());

describe('repository URL registration', () => {
  const repositoryUrl = 'https://github.com/org-name/repo-name';
  const payload = { tenantId: administrator.id, repositoryUrl, pollIntervalSeconds: 120 };

  it('verifies the parsed URL using the registered API and stores canonical names', async () => {
    const { app, query, fetcher } = await repositoryTestApp();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/github-connections/${credentialId}/repositories`,
      payload: {
        ...payload,
        repositoryUrl: `${repositoryUrl.replace('/repo-name', '/REPO-NAME')}.git/`,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      'https://api.github.com/repos/org-name/REPO-NAME',
    );
    const options = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(options.headers).get('authorization')).toBe('Bearer synthetic-test-token');
    const insert = query.mock.calls.find(([sql]) => sql.includes('insert into repositories'));
    expect(insert?.[1]).toEqual([
      administrator.id,
      credentialId,
      42,
      'org-name',
      'repo-name',
      120,
      true,
    ]);
    expect(response.body).not.toContain('synthetic-test-token');
    await app.close();
  });

  it('retains owner/name API compatibility', async () => {
    const { app, fetcher } = await repositoryTestApp();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/github-connections/${credentialId}/repositories`,
      payload: { tenantId: administrator.id, owner: 'org-name', name: 'repo-name' },
    });
    expect(response.statusCode).toBe(201);
    expect(fetcher).toHaveBeenCalledOnce();
    await app.close();
  });

  it('stores the selected user with an explicit reviewer role', async () => {
    const { app, query } = await repositoryTestApp();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/github-connections/${credentialId}/repositories`,
      payload: { ...payload, grantSubjects: ['local:reviewer'] },
    });
    expect(response.statusCode).toBe(201);
    const grant = query.mock.calls.find(([sql]) => sql.includes('insert into repository_grants'));
    expect(grant?.[0]).toMatch(/repository_grants\(repository_id, subject_or_group, role\)/);
    expect(grant?.[0]).toContain("values ($1, $2, 'reviewer')");
    expect(grant?.[1]).toEqual([instanceId, 'local:reviewer']);
    expect(query.mock.calls.some(([sql]) => sql === 'commit')).toBe(true);
    await app.close();
  });

  it('rejects a different host before sending the credential anywhere', async () => {
    const { app, fetcher } = await repositoryTestApp();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/github-connections/${credentialId}/repositories`,
      payload: { ...payload, repositoryUrl: 'https://other.example/org-name/backend' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('GITHUB_REPOSITORY_URL_INVALID');
    expect(fetcher).not.toHaveBeenCalled();
    await app.close();
  });

  it('requires a verified unexpired enabled connection', async () => {
    const { app, fetcher } = await repositoryTestApp({ unavailable: true });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/github-connections/${credentialId}/repositories`,
      payload,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('GITHUB_CONNECTION_UNAVAILABLE');
    expect(fetcher).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    [401, 502, 'GITHUB_TOKEN_UNAUTHORIZED'],
    [403, 403, 'GITHUB_REPOSITORY_FORBIDDEN'],
    [404, 404, 'GITHUB_REPOSITORY_NOT_FOUND'],
    [500, 502, 'GITHUB_REPOSITORY_REQUEST_FAILED'],
  ])(
    'explains GitHub HTTP %i errors without exposing the upstream body',
    async (upstream, status, code) => {
      const { app, query } = await repositoryTestApp({ upstream: Number(upstream) });
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/github-connections/${credentialId}/repositories`,
        payload,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json().error.code).toBe(code);
      expect(response.body).not.toContain('upstream-secret');
      expect(query.mock.calls.some(([sql]) => sql.includes('insert into repositories'))).toBe(
        false,
      );
      await app.close();
    },
  );
});

async function repositoryTestApp(options: { upstream?: number; unavailable?: boolean } = {}) {
  const encrypted = encryptCredential(
    'synthetic-test-token',
    config.CREDENTIAL_ENCRYPTION_KEY,
    'github-access-token',
  );
  const query = vi.fn<
    (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>
  >(async (sql) => {
    if (sql.includes('insert into repositories'))
      return { rows: [{ id: instanceId }], rowCount: 1 };
    if (sql.includes('from github_credentials credential'))
      return {
        rows: options.unavailable
          ? []
          : [
              {
                ...encrypted,
                apiBaseUrl: 'https://api.github.com/',
                webBaseUrl: 'https://github.com/',
              },
            ],
        rowCount: options.unavailable ? 0 : 1,
      };
    return { rows: [], rowCount: 1 };
  });
  const database = {
    query,
    connect: async () => ({ query, release: vi.fn() }),
  } as unknown as Database;
  const fetcher = vi.fn<(url: URL, options: RequestInit) => Promise<Response>>(async () =>
    options.upstream
      ? Response.json({ message: 'upstream-secret' }, { status: options.upstream })
      : Response.json({ id: 42, owner: { login: 'org-name' }, name: 'repo-name' }),
  );
  vi.stubGlobal('fetch', fetcher);
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.user = administrator;
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof GitHubRegistryError)
      return reply
        .code(error.statusCode)
        .send(errorEnvelope(error.code, error.message, request.id, error.retryable));
    return reply.code(500).send({ error: 'Unexpected failure' });
  });
  await registerAccountRegistryRoutes(app, database, config);
  return { app, query, fetcher };
}

describe('GHES connection update route', () => {
  it('updates metadata without replacing the encrypted token or incrementing its version', async () => {
    const { app, query, connection } = await testApp();

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/github-connections/${credentialId}`,
      payload: {
        name: '사내 GHES',
        apiBaseUrl: 'https://ghes.example/api/v3',
        webBaseUrl: 'https://ghes.example',
        credentialLabel: 'review-readonly',
        expiresAt: null,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ schemaVersion: 1, id: credentialId });
    const credentialUpdate = query.mock.calls.find(([sql]) =>
      String(sql).includes('update github_credentials'),
    );
    expect(String(credentialUpdate?.[0])).not.toContain('credential_version + 1');
    expect(String(credentialUpdate?.[0])).not.toContain('enabled = true');
    expect(credentialUpdate?.[1]).toEqual([credentialId, 'review-readonly', null]);
    expect(query.mock.calls.map(([sql]) => String(sql)).at(-1)).toBe('commit');
    expect(connection.release).toHaveBeenCalledOnce();
    await app.close();
  });

  it('encrypts a replacement token and increments the credential version', async () => {
    const { app, query } = await testApp();
    const replacementToken = 'github_pat_replacement';

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/github-connections/${credentialId}`,
      payload: {
        name: '사내 GHES',
        apiBaseUrl: 'https://new-ghes.example/api/v3/',
        webBaseUrl: 'https://new-ghes.example/',
        credentialLabel: 'review-readonly',
        accessToken: replacementToken,
        expiresAt: '2026-12-31T14:59:59.000Z',
      },
    });

    expect(response.statusCode).toBe(200);
    const credentialUpdate = query.mock.calls.find(([sql]) =>
      String(sql).includes('update github_credentials'),
    );
    expect(String(credentialUpdate?.[0])).toContain('credential_version = credential_version + 1');
    expect(credentialUpdate?.[1]).toEqual([
      credentialId,
      'review-readonly',
      '2026-12-31T14:59:59.000Z',
      expect.any(Buffer),
      expect.any(Buffer),
      expect.any(Buffer),
      credentialFingerprint(replacementToken),
    ]);
    expect(credentialUpdate?.[1]).not.toContain(replacementToken);
    await app.close();
  });

  it('returns 404 without changing an instance when the credential does not exist', async () => {
    const { app, query, connection } = await testApp({ existing: false });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/github-connections/${credentialId}`,
      payload: updatePayload(),
    });

    expect(response.statusCode).toBe(404);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('update github_instances'))).toBe(
      false,
    );
    expect(query.mock.calls.some(([sql]) => String(sql).includes('insert into audit_events'))).toBe(
      true,
    );
    expect(query.mock.calls.map(([sql]) => String(sql)).at(-1)).toBe('commit');
    expect(connection.release).toHaveBeenCalledOnce();
    await app.close();
  });

  it('rolls back and returns 409 when the URL or credential label conflicts', async () => {
    const { app, query, connection } = await testApp({ uniqueViolation: true });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/github-connections/${credentialId}`,
      payload: updatePayload(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('GITHUB_CONNECTION_CONFLICT');
    expect(query.mock.calls.map(([sql]) => String(sql))).toContain('rollback');
    expect(
      query.mock.calls.some(([sql, values]) =>
        String(sql).includes('insert into audit_events') && Array.isArray(values)
          ? values.includes('failure')
          : false,
      ),
    ).toBe(true);
    expect(connection.release).toHaveBeenCalledOnce();
    await app.close();
  });

  it('requires a new token before changing the API origin', async () => {
    const { app, query } = await testApp();

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/github-connections/${credentialId}`,
      payload: {
        ...updatePayload(),
        apiBaseUrl: 'https://new-ghes.example/api/v3/',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('GITHUB_TOKEN_REQUIRED_FOR_ORIGIN_CHANGE');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('update github_instances'))).toBe(
      false,
    );
    await app.close();
  });

  it('requires a new token before changing the Web origin used by Git', async () => {
    const { app, query } = await testApp();

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/github-connections/${credentialId}`,
      payload: { ...updatePayload(), webBaseUrl: 'https://new-ghes.example/' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('GITHUB_TOKEN_REQUIRED_FOR_ORIGIN_CHANGE');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('update github_instances'))).toBe(
      false,
    );
    await app.close();
  });

  it('rejects shared instance changes while allowing credential-only fields to be edited', async () => {
    const { app, query } = await testApp({ shared: true });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/github-connections/${credentialId}`,
      payload: { ...updatePayload(), name: '공유 GHES 변경' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('GITHUB_SHARED_INSTANCE_CONFLICT');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('update github_instances'))).toBe(
      false,
    );
    await app.close();
  });
});

describe('registered GHES credential gate', () => {
  it('requires ready health before polling or Git materialization can decrypt a token', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const database = { query } as unknown as Database;

    expect(
      await registeredGitHubReader(database, config.CREDENTIAL_ENCRYPTION_KEY, credentialId),
    ).toBe(null);
    expect(String(query.mock.calls[0]?.[0])).toContain("health = 'ready'");
  });
});

function updatePayload() {
  return {
    name: '사내 GHES',
    apiBaseUrl: 'https://ghes.example/api/v3/',
    webBaseUrl: 'https://ghes.example/',
    credentialLabel: 'review-readonly',
    expiresAt: null,
  };
}

async function testApp(
  options: { existing?: boolean; uniqueViolation?: boolean; shared?: boolean } = {},
) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('from github_credentials target')) {
      return options.existing === false
        ? { rows: [], rowCount: 0 }
        : {
            rows: [
              {
                credentialId,
                instanceId,
                name: '사내 GHES',
                apiBaseUrl: 'https://ghes.example/api/v3/',
                webBaseUrl: 'https://ghes.example/',
              },
              ...(options.shared
                ? [
                    {
                      credentialId: '6fc76a25-f8ce-45bc-a876-521851636845',
                      instanceId,
                      name: '사내 GHES',
                      apiBaseUrl: 'https://ghes.example/api/v3/',
                      webBaseUrl: 'https://ghes.example/',
                    },
                  ]
                : []),
            ],
            rowCount: options.shared ? 2 : 1,
          };
    }
    if (options.uniqueViolation && sql.includes('update github_instances')) {
      throw Object.assign(new Error('unique violation'), { code: '23505' });
    }
    return { rows: [], rowCount: 1 };
  });
  const connection = { query, release: vi.fn() };
  const database = {
    query: vi.fn(),
    connect: vi.fn(async () => connection),
  } as unknown as Database;
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.user = administrator;
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = error.name === 'ZodError' ? 400 : 500;
    return reply.code(status).send({ error: error.message });
  });
  await registerAccountRegistryRoutes(app, database, config);
  return { app, query, connection };
}
