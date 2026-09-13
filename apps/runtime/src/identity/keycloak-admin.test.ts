import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KeycloakAdminClient,
  KeycloakAdminError,
  keycloakAppUserAttribute,
  keycloakNameIdAttribute,
  keycloakOperationAttribute,
  plannedKeycloakNameId,
  validateKeycloakAdminSettings,
  type KeycloakAdminSettings,
  type KeycloakCreatePlan,
} from './keycloak-admin.js';

describe('Keycloak realm-scoped administration', () => {
  let directory: string, settings: KeycloakAdminSettings;
  let users: Map<string, Record<string, unknown>>, plan: KeycloakCreatePlan;
  let calls: Array<{ url: URL; init: RequestInit; body: Record<string, unknown> | null }>,
    request: ReturnType<typeof vi.fn<typeof fetch>>;
  let tokenCount: number, loseCreate: boolean;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'gcr-keycloak-admin-test-'));
    await writeFile(path.join(directory, 'client-secret'), 'synthetic-client-secret\n', {
      mode: 0o600,
    });
    settings = {
      issuer: 'https://identity.test/realms/gcr',
      entityId: 'https://gcr.test/auth/saml/metadata',
      clientId: 'gcr-identity-admin',
      clientSecretFile: path.join(directory, 'client-secret'),
    };
  });
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  beforeEach(() => {
    users = new Map();
    calls = [];
    tokenCount = 0;
    loseCreate = false;
    plan = {
      operationId: randomUUID(),
      userId: randomUUID(),
      username: 'planned-user',
      email: 'approved@example.test',
      displayName: 'GCR Account',
    };
    request = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input)),
        options = init!;
      expect(options.redirect).toBe('error');
      expect(options.signal).toBeInstanceOf(AbortSignal);
      if (url.pathname.endsWith('/token')) {
        const fields = new URLSearchParams(String(options.body));
        expect([...fields.keys()].sort()).toEqual(['client_id', 'client_secret', 'grant_type']);
        expect(fields.get('grant_type')).toBe('client_credentials');
        expect(fields.get('client_secret')).toBe('synthetic-client-secret');
        tokenCount++;
        return Response.json({
          access_token: 'synthetic-token-' + tokenCount,
          token_type: 'Bearer',
          expires_in: 300,
        });
      }
      expect(new Headers(options.headers).get('authorization')).toMatch(/^Bearer synthetic-token-/);
      const body = options.body === undefined ? null : JSON.parse(String(options.body));
      calls.push({ url, init: options, body });
      if (url.pathname === '/admin/realms/gcr/users' && options.method === 'GET') {
        expect(url.searchParams.get('exact')).toBe('true');
        expect(url.searchParams.get('max')).toBe('2');
        return Response.json(
          [...users.values()].filter((user) => user.username === url.searchParams.get('username')),
        );
      }
      if (url.pathname === '/admin/realms/gcr/users' && options.method === 'POST') {
        if ([...users.values()].some((user) => user.username === body.username))
          return new Response(null, { status: 409 });
        const id = randomUUID();
        users.set(id, { ...body, id });
        if (loseCreate) throw Error('upstream private connection detail');
        return new Response(null, {
          status: 201,
          headers: { location: 'https://untrusted-location.test/do-not-follow' },
        });
      }
      const id = url.pathname.split('/')[5],
        user = users.get(id);
      if (!user) return new Response(null, { status: 404 });
      if (options.method === 'GET') return Response.json(user);
      if (options.method === 'PUT' && url.pathname.endsWith('/' + id)) {
        Object.assign(user, body);
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith('/execute-actions-email') || url.pathname.endsWith('/logout'))
        return new Response(null, { status: 204 });
      throw Error('Unexpected test request');
    });
  });
  const make = () => new KeycloakAdminClient(settings, request);
  it('binds public issuer and internal admin endpoints to the same non-master realm', () => {
    expect(
      validateKeycloakAdminSettings({
        ...settings,
        adminBaseUrl: 'https://private-admin.test/admin/realms/gcr',
      }),
    ).toMatchObject({
      realm: 'gcr',
      tokenUrl: 'https://identity.test/realms/gcr/protocol/openid-connect/token',
      adminBaseUrl: 'https://private-admin.test/admin/realms/gcr',
    });
    for (const changes of [
      { issuer: 'https://identity.test/realms/master' },
      { adminBaseUrl: 'https://private.test/admin/realms/other' },
      { issuer: 'http://identity.test/realms/gcr' },
      { adminBaseUrl: 'https://secret:password@private.test/admin/realms/gcr' },
      { clientId: 'admin-cli' },
      { clientSecretFile: 'relative-secret' },
      { timeoutMs: 10001 },
    ])
      expect(() => validateKeycloakAdminSettings({ ...settings, ...changes })).toThrow(
        'Invalid configuration: Keycloak administration requires approved HTTPS realm endpoints and a mounted service-account secret',
      );
  });
  it('creates a disabled user with fixed operation markers and reuses only the matching account', async () => {
    const client = make(),
      first = await client.ensureCreated(plan),
      second = await client.ensureCreated(plan);
    expect(first.id).toBe(second.id);
    expect(first.enabled).toBe(false);
    expect(first.requiredActions).toEqual(['VERIFY_EMAIL', 'UPDATE_PASSWORD']);
    expect(first.attributes).toEqual({
      [keycloakAppUserAttribute]: [plan.userId],
      [keycloakOperationAttribute]: [plan.operationId],
      [keycloakNameIdAttribute(settings.entityId)]: [plannedKeycloakNameId(plan.operationId)],
    });
    expect(calls.filter((call) => call.init.method === 'POST')).toHaveLength(1);
    expect(tokenCount).toBe(1);
    expect(calls.every((call) => call.url.origin === 'https://identity.test')).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('password');
  });
  it('reconciles a lost create response without creating or linking another account', async () => {
    loseCreate = true;
    const client = make();
    const user = await client.ensureCreated(plan);
    expect(users.size).toBe(1);
    expect((await client.ensureCreated(plan)).id).toBe(user.id);
    expect(calls.filter((call) => call.init.method === 'POST')).toHaveLength(1);
  });
  it.each(['user-id', 'operation-id', 'name-id', 'email'])(
    'rejects a matching username with a different %s',
    async (field) => {
      const client = make(),
        user = await client.ensureCreated(plan),
        record = users.get(user.id)!;
      if (field === 'email') record.email = 'other@example.test';
      else
        (record.attributes as Record<string, string[]>)[
          field === 'user-id'
            ? keycloakAppUserAttribute
            : field === 'operation-id'
              ? keycloakOperationAttribute
              : keycloakNameIdAttribute(settings.entityId)
        ] = [randomUUID()];
      await expect(client.ensureCreated(plan)).rejects.toMatchObject({
        code: 'IDENTITY_ACCOUNT_CONFLICT',
      });
      expect(calls.filter((call) => call.init.method === 'POST')).toHaveLength(1);
      expect(users.size).toBe(1);
    },
  );
  it('does not equate an existing email or username to explicit identity mapping', async () => {
    const id = randomUUID();
    users.set(id, {
      id,
      username: plan.username,
      email: plan.email,
      enabled: true,
      attributes: {},
    });
    await expect(make().ensureCreated(plan)).rejects.toMatchObject({
      code: 'IDENTITY_ACCOUNT_CONFLICT',
    });
    expect(calls.filter((call) => call.init.method !== 'GET')).toHaveLength(0);
  });
  it('deduplicates concurrent service-account token requests', async () => {
    const client = make(),
      id = randomUUID();
    users.set(id, { id, username: plan.username, enabled: false });
    await Promise.all(Array.from({ length: 8 }, () => client.getUser(id)));
    expect(tokenCount).toBe(1);
  });
  it('refreshes a rejected access token at most once', async () => {
    const client = make(),
      fallback = request.getMockImplementation()!;
    let rejected = 0;
    request.mockImplementation(async (input, init) => {
      if (String(input).includes('/admin/')) {
        rejected++;
        return new Response(null, { status: 401 });
      }
      return fallback(input, init);
    });
    await expect(client.getUser(randomUUID())).rejects.toMatchObject({
      code: 'IDENTITY_ADMIN_CREDENTIAL_INVALID',
    });
    expect(tokenCount).toBe(2);
    expect(rejected).toBe(2);
  });
  it('changes only enabled state and reads the same immutable user ID back', async () => {
    const client = make(),
      user = await client.ensureCreated(plan);
    const enabled = await client.setEnabled(user.id, true);
    expect(enabled.enabled).toBe(true);
    expect(enabled.attributes).toEqual(user.attributes);
    expect(calls.filter((call) => call.init.method === 'PUT')[0].body).toEqual({ enabled: true });
  });
  it('extracts the SP-specific NameID and refuses an uninitialized or wildcard-only value', async () => {
    const client = make(),
      user = await client.ensureCreated(plan);
    expect(client.identity(user)).toMatchObject({
      nameID: plannedKeycloakNameId(plan.operationId),
      issuer: settings.issuer,
      entityId: settings.entityId,
      nameQualifier: null,
      spNameQualifier: null,
    });
    expect(() =>
      client.identity({ ...user, attributes: { 'saml.persistent.name.id.for.*': ['other-sp'] } }),
    ).toThrow('IDENTITY_NAME_ID_UNINITIALIZED');
  });
  it('sends required actions only to the confirmed current email of an enabled user', async () => {
    const client = make(),
      user = await client.ensureCreated(plan);
    await expect(client.sendActionsEmail(user.id, plan.email, 'invite')).rejects.toMatchObject({
      code: 'IDENTITY_PROFILE_INVALID',
    });
    await client.setEnabled(user.id, true);
    await expect(
      client.sendActionsEmail(user.id, 'different@example.test', 'invite'),
    ).rejects.toMatchObject({ code: 'IDENTITY_PROFILE_INVALID' });
    await client.sendActionsEmail(user.id, plan.email, 'invite');
    const emailCalls = calls.filter((call) => call.url.pathname.endsWith('/execute-actions-email'));
    expect(emailCalls).toHaveLength(1);
    expect(emailCalls[0].body).toEqual(['VERIFY_EMAIL', 'UPDATE_PASSWORD']);
    expect([...emailCalls[0].url.searchParams.keys()]).toEqual(['lifespan']);
  });
  it('keeps an ambiguous email result separate from safe retry and never resends automatically', async () => {
    const client = make(),
      user = await client.ensureCreated(plan);
    await client.setEnabled(user.id, true);
    const fallback = request.getMockImplementation()!;
    let sent = 0;
    request.mockImplementation(async (input, init) => {
      if (String(input).includes('execute-actions-email')) {
        sent++;
        throw Error('SMTP private response detail');
      }
      return fallback(input, init);
    });
    await expect(
      client.sendActionsEmail(user.id, plan.email, 'password-reset'),
    ).rejects.toMatchObject({ code: 'IDENTITY_EMAIL_UNCONFIRMED', retryable: false });
    expect(sent).toBe(1);
  });
  it('does not repeat a write when a transport result is unknown', async () => {
    const client = make(),
      user = await client.ensureCreated(plan),
      fallback = request.getMockImplementation()!;
    let writes = 0;
    request.mockImplementation(async (input, init) => {
      if (init?.method === 'PUT') {
        writes++;
        throw Error('private response');
      }
      return fallback(input, init);
    });
    await expect(client.setEnabled(user.id, true)).rejects.toMatchObject({
      code: 'IDENTITY_RESULT_UNCONFIRMED',
      retryable: false,
    });
    expect(writes).toBe(1);
  });
  it('rejects inconsistent IDs and service accounts from the profile response', async () => {
    const client = make(),
      id = randomUUID();
    users.set(id, { id: randomUUID(), username: plan.username, enabled: true });
    await expect(client.getUser(id)).rejects.toMatchObject({ code: 'IDENTITY_PROFILE_INVALID' });
    users.set(id, {
      id,
      username: plan.username,
      enabled: true,
      serviceAccountClientId: 'other-client',
    });
    await expect(client.getUser(id)).rejects.toMatchObject({ code: 'IDENTITY_PROFILE_INVALID' });
  });
  it('bounds untrusted JSON and sanitizes upstream errors', async () => {
    const client = make(),
      fallback = request.getMockImplementation()!;
    request.mockImplementation(async (input, init) =>
      String(input).includes('/admin/')
        ? new Response('private-profile'.repeat(50_000), {
            headers: { 'content-type': 'application/json' },
          })
        : fallback(input, init),
    );
    await expect(client.getUser(randomUUID())).rejects.toEqual(
      new KeycloakAdminError('IDENTITY_ADMIN_UNAVAILABLE', true),
    );
    request.mockImplementation(async (input, init) =>
      String(input).includes('/admin/')
        ? new Response('private-error', { status: 403 })
        : fallback(input, init),
    );
    await expect(client.getUser(randomUUID())).rejects.toEqual(
      new KeycloakAdminError('IDENTITY_ADMIN_FORBIDDEN'),
    );
  });
});
