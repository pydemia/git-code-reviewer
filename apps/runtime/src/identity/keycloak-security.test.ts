import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeycloakAdminSettings } from './keycloak-admin.js';
import { KeycloakSecurityClient, requiredSecurityEventTypes } from './keycloak-security.js';

describe('bounded Keycloak security event observations', () => {
  let directory: string, settings: KeycloakAdminSettings;
  let service: string, realm: string, configuration: Record<string, unknown>;
  let security: Record<string, unknown>[], administration: Record<string, unknown>[];
  let attributes: Record<string, string[]>, client: KeycloakSecurityClient;
  let mutate: (route: string, method: string) => void;
  let tokenCount: number, omitTokenEvent: boolean, duplicateProbe: boolean;
  let tokenOverrides: Record<string, unknown>;
  let requests: { route: string; method: string; body: unknown }[];
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'gcr-security-test-'));
    await writeFile(path.join(directory, 'secret'), 'synthetic-service-secret', { mode: 0o600 });
    settings = {
      issuer: 'https://identity.test/realms/gcr',
      entityId: 'https://gcr.test/auth/saml/metadata',
      clientId: 'gcr-service',
      clientSecretFile: path.join(directory, 'secret'),
    };
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const userEvent = (values: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    time: Date.now(),
    realmId: realm,
    type: 'LOGIN',
    userId: randomUUID(),
    ...values,
  });
  const adminEvent = (values: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    time: Date.now(),
    realmId: realm,
    operationType: 'UPDATE',
    resourceType: 'USER',
    resourcePath: `users/${randomUUID()}`,
    authDetails: { userId: randomUUID() },
    ...values,
  });
  beforeEach(() => {
    service = randomUUID();
    realm = 'realm-id';
    security = [];
    administration = [];
    attributes = { preserved: ['keep'] };
    tokenCount = 0;
    omitTokenEvent = false;
    duplicateProbe = false;
    tokenOverrides = {};
    requests = [];
    mutate = () => {};
    configuration = {
      eventsEnabled: true,
      eventsExpiration: 86400,
      enabledEventTypes: [...requiredSecurityEventTypes],
      adminEventsEnabled: true,
      adminEventsDetailsEnabled: false,
    };
    const request = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (url.pathname.endsWith('/token')) {
        tokenCount++;
        const claims = {
          iss: settings.issuer,
          sub: service,
          azp: settings.clientId,
          jti: randomUUID(),
          iat: Math.floor(Date.now() / 1000),
          ...tokenOverrides,
        };
        if (!omitTokenEvent)
          security.push(
            userEvent({
              type: 'CLIENT_LOGIN',
              userId: service,
              clientId: settings.clientId,
              details: { token_id: claims.jti },
            }),
          );
        return Response.json({
          access_token: `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.c2ln`,
          token_type: 'Bearer',
          expires_in: 300,
        });
      }
      const route = url.pathname.replace('/admin/realms/gcr', '');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ route, method, body });
      mutate(route, method);
      if (route === '/events/config') return Response.json(configuration);
      if (route === '/events' || route === '/admin-events') {
        expect(url.searchParams.get('max')).toBe('501');
        expect(url.searchParams.get('direction')).toBe('asc');
        expect(url.searchParams.has('first')).toBe(false);
        const from = Number(url.searchParams.get('dateFrom'));
        return Response.json(
          (route === '/events' ? security : administration)
            .filter((event) => Number(event.time) >= from)
            .slice(0, 501),
        );
      }
      expect(route).toBe(`/users/${service}`);
      if (method === 'PUT') {
        attributes = body.attributes;
        administration.push(
          adminEvent({ resourcePath: route.slice(1), authDetails: { userId: service } }),
        );
        if (duplicateProbe)
          administration.push(
            adminEvent({ resourcePath: route.slice(1), authDetails: { userId: service } }),
          );
        return new Response(null, { status: 204 });
      }
      return Response.json({ id: service, attributes });
    });
    client = new KeycloakSecurityClient(settings, request);
  });
  it('requires two durable probes and a fresh token on every pass, preserving owned attributes', async () => {
    const first = await client.capture();
    expect(first.continuity).toBe('baseline');
    const next = await client.capture(first.checkpoint);
    expect(next.continuity).toBe('continuous');
    expect(next.events).toEqual([]);
    expect(tokenCount).toBe(2);
    expect(attributes.preserved).toEqual(['keep']);
    expect(next.checkpoint.security.id).not.toBe(first.checkpoint.security.id);
    expect(
      requests.filter((r) => r.method !== 'GET').every((r) => r.route === `/users/${service}`),
    ).toBe(true);
    const serialized = JSON.stringify(next);
    for (const secret of [
      'synthetic-service-secret',
      'token_id',
      'authorization',
      'gcr.security.probe',
    ])
      expect(serialized).not.toContain(secret);
  });
  it.each(['security', 'administration'])(
    'detects a cleared %s stream despite successful new probes',
    async (stream) => {
      const first = await client.capture();
      if (stream === 'security') security = [];
      else administration = [];
      expect((await client.capture(first.checkpoint)).continuity).toBe('gap');
    },
  );
  it('does not treat a stale checkpoint or changed configuration as continuous', async () => {
    const first = await client.capture();
    expect(
      (await client.capture({ ...first.checkpoint, observedAt: Date.now() - 300_001 })).continuity,
    ).toBe('gap');
    configuration.eventsExpiration = 7200;
    expect((await client.capture(first.checkpoint)).continuity).toBe('gap');
  });
  it.each([
    { eventsEnabled: false },
    { adminEventsEnabled: false },
    { adminEventsDetailsEnabled: true },
    { enabledEventTypes: ['CLIENT_LOGIN'] },
    { eventsExpiration: 60 },
  ])('refuses incomplete or privacy-unsafe event configuration %j', async (override) => {
    Object.assign(configuration, override);
    await expect(client.capture()).rejects.toMatchObject({
      code: 'IDENTITY_EVENT_CONFIGURATION_INVALID',
    });
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
  });
  it('fails closed on an overflowing same-timestamp batch instead of offset paging', async () => {
    const now = Date.now();
    security.push(...Array.from({ length: 501 }, () => userEvent({ time: now })));
    await expect(client.capture()).rejects.toMatchObject({
      code: 'IDENTITY_EVENT_BATCH_INCOMPLETE',
    });
  });
  it('observes a late-committed credential event with an older timestamp inside the transaction overlap', async () => {
    const delayed = userEvent({ type: 'UPDATE_CREDENTIAL', time: Date.now() - 4 * 60_000 });
    mutate = (_route, method) => {
      if (method === 'PUT') security.push(delayed);
    };
    const observation = await client.capture();
    expect(observation.events).toContainEqual({
      id: delayed.id,
      time: delayed.time,
      userId: delayed.userId,
      stream: 'security',
      kind: 'revoke-identity',
    });
  });
  it('detects clearing between the before and after observations', async () => {
    security.push(userEvent());
    mutate = (_route, method) => {
      if (method === 'PUT') security.shift();
    };
    await expect(client.capture()).rejects.toMatchObject({
      code: 'IDENTITY_EVENT_BATCH_INCOMPLETE',
    });
  });
  it('requires exact token correlation and a unique own-admin probe', async () => {
    omitTokenEvent = true;
    await expect(client.capture()).rejects.toMatchObject({
      code: 'IDENTITY_EVENT_PROBE_UNCONFIRMED',
    });
    omitTokenEvent = false;
    duplicateProbe = true;
    await expect(client.capture()).rejects.toMatchObject({
      code: 'IDENTITY_EVENT_PROBE_UNCONFIRMED',
    });
  });
  it.each([
    { iss: 'https://wrong.test/realms/gcr' },
    { azp: 'other-client' },
    { sub: 'bad' },
    { iat: 1 },
  ])('rejects mismatched service token metadata %j without leaking it', async (override) => {
    tokenOverrides = override;
    await expect(client.capture()).rejects.toMatchObject({
      code: 'IDENTITY_EVENT_PROBE_UNCONFIRMED',
    });
    expect(requests).toEqual([]);
  });
  it('normalizes session logout separately, includes own-client security writes, and removes private event fields', async () => {
    const userId = randomUUID(),
      sessionId = 'fixtureSession_24-chars01';
    security.push(
      userEvent({
        type: 'LOGOUT',
        userId,
        sessionId,
        ipAddress: '192.0.2.1',
        details: { email: 'private@example.test' },
      }),
    );
    security.push(userEvent({ type: 'UPDATE_PASSWORD', userId }));
    administration.push(
      adminEvent({
        resourcePath: `users/${userId}/reset-password`,
        operationType: 'ACTION',
        authDetails: { userId: service },
      }),
    );
    administration.push(
      adminEvent({ resourcePath: `users/${userId}/logout`, operationType: 'ACTION' }),
    );
    administration.push(
      adminEvent({ resourcePath: 'logout-all', resourceType: 'REALM', operationType: 'ACTION' }),
    );
    const result = await client.capture();
    expect(result.events).toHaveLength(5);
    expect(result.events[0]).toMatchObject({ kind: 'logout-session', userId, sessionId });
    expect(result.events[1]).toMatchObject({ kind: 'revoke-identity', userId });
    expect(result.events[2]).toMatchObject({ kind: 'revoke-identity', userId });
    expect(result.events[3]).toMatchObject({ remoteLogoutConfirmed: true });
    expect(result.events[4]).toMatchObject({ kind: 'revoke-provider' });
    expect(JSON.stringify(result)).not.toMatch(/192\.0\.2\.1|private@example|authDetails|details/);
  });
  it('never interprets an unscoped ordinary logout as all-device revocation', async () => {
    security.push(userEvent({ type: 'LOGOUT' }));
    await expect(client.capture()).rejects.toMatchObject({
      code: 'IDENTITY_EVENT_BATCH_INCOMPLETE',
    });
  });
  it('rejects private admin representations, duplicate IDs, wrong realms and clock anomalies', async () => {
    administration.push(adminEvent({ representation: '{"email":"private@example.test"}' }));
    await expect(client.capture()).rejects.toMatchObject({
      code: 'IDENTITY_EVENT_BATCH_INCOMPLETE',
    });
    administration = [];
    const duplicate = userEvent();
    security.push(duplicate, duplicate);
    await expect(client.capture()).rejects.toMatchObject({
      code: 'IDENTITY_EVENT_BATCH_INCOMPLETE',
    });
    security = [userEvent({ realmId: 'different-realm' })];
    await expect(client.capture()).rejects.toMatchObject({
      code: 'IDENTITY_EVENT_BATCH_INCOMPLETE',
    });
    security = [userEvent({ time: Date.now() + 120_000 })];
    await expect(client.capture()).rejects.toMatchObject({
      code: 'IDENTITY_EVENT_BATCH_INCOMPLETE',
    });
  });
});
