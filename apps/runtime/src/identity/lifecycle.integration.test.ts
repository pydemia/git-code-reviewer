import { createHash, randomUUID } from 'node:crypto';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import type { IdentityLifecycleRequest } from '@gcr/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { loadConfig } from '../config.js';
import { AuthorizationService } from '../services/authorization.js';
import { registerIdentityAdministrationRoutes } from './routes.js';
import {
  linkExistingSamlIdentity,
  persistentNameId,
  type SamlProviderBinding,
} from '../auth/saml-state.js';
import {
  KeycloakAdminClient,
  KeycloakAdminError,
  keycloakNameIdAttribute,
  type KeycloakUser,
} from './keycloak-admin.js';
import {
  KeycloakSecurityError,
  type IdentitySecurityEvent,
  type SecurityObservation,
} from './keycloak-security.js';
import {
  completeIdentityRevocations,
  identityLifecycleTransaction,
  requestIdentityLifecycle,
  retryIdentityReactivation,
} from './lifecycle.js';
import {
  claimIdentityOperation,
  retryIdentityOperation,
  supersedeIdentityOperations,
} from './operations.js';
import { processIdentityReactivation } from './reactivation.js';
import { revokeUserIdentitySecurity } from './revocation.js';
import {
  reconcileIdentitySecurity,
  type IdentitySecurityAdministration,
} from './security-processor.js';
import {
  applySecurityObservation,
  claimIdentitySecurityLogout,
  claimSecurityObservation,
  completeIdentitySecurityLogout,
} from './security-state.js';

const databaseUrl = process.env.GCR_TEST_DATABASE_URL;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
describe.skipIf(!databaseUrl).sequential('Identity lifecycle with PostgreSQL', () => {
  const schema = `identity_lifecycle_${randomUUID().replaceAll('-', '')}`;
  const binding: SamlProviderBinding = {
    issuer: `https://identity.test/realms/${schema}`,
    entityId: 'https://gcr.test/auth/saml/metadata',
    acsUrl: 'https://gcr.test/auth/saml/acs',
    sloUrl: 'https://gcr.test/auth/saml/slo',
  };
  let root: Database, database: Database, replica: Database;
  let actorId: string, userId: string, identityId: string, external: KeycloakUser;
  let events: IdentitySecurityEvent[], adapter: ReturnType<typeof fixture>;
  const reader = new KeycloakAdminClient({
    issuer: binding.issuer,
    entityId: binding.entityId,
    clientId: 'fixture',
    clientSecretFile: '/not-read-by-pure-identity-method',
  });
  function observation(
    continuity: SecurityObservation['continuity'] = 'continuous',
  ): SecurityObservation {
    const now = Date.now();
    return {
      continuity,
      checkpoint: {
        realmId: 'fixture',
        configurationHash: hash('configuration'),
        observedAt: now,
        security: { id: randomUUID(), time: now },
        administration: { id: randomUUID(), time: now },
      },
      events: structuredClone(events),
    };
  }
  function adminEvent(action: 'update-user' | 'logout-user', own = true): IdentitySecurityEvent {
    return {
      id: randomUUID(),
      time: Date.now(),
      stream: 'administration',
      kind: 'revoke-identity',
      userId: external.id,
      administrationAction: action,
      ...(own ? { ownAdministration: true as const } : {}),
      ...(action === 'logout-user' ? { remoteLogoutConfirmed: true } : {}),
    };
  }
  function fixture() {
    return {
      endpoints: reader.endpoints,
      withRequestGuard: reader.withRequestGuard.bind(reader),
      identity: reader.identity.bind(reader),
      capture: vi.fn(async () => observation()),
      getUser: vi.fn(async () => structuredClone(external)),
      setEnabled: vi.fn(async (_id: string, enabled: boolean) => {
        external.enabled = enabled;
        events.push(adminEvent('update-user'));
        return structuredClone(external);
      }),
      logoutAll: vi.fn(async (id: string) => {
        expect(id).toBe(external.id);
        events.push(adminEvent('logout-user'));
      }),
    } satisfies IdentitySecurityAdministration;
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw Error('Isolated local PostgreSQL only');
    root = createDatabase(url.href);
    await root.query(`create schema ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    database = createDatabase(url.href);
    replica = createDatabase(url.href);
    await runMigrations(database);
  }, 30_000);
  afterAll(async () => {
    await replica?.end();
    await database?.end();
    if (root) {
      await root.query(`drop schema ${schema} cascade`);
      await root.end();
    }
  });
  beforeEach(async () => {
    await database.query('truncate users,identity_security_sources cascade');
    events = [];
    actorId = (
      await database.query(`insert into users(oidc_subject,display_name,role)
      values('admin','Admin','administrator') returning id`)
    ).rows[0].id;
    userId = (
      await database.query(`insert into users(oidc_subject,display_name,role,personal_prompt)
      values('preserved-subject','Preserved','reviewer','Preserved prompt') returning id`)
    ).rows[0].id;
    await database.query(
      `insert into local_credentials(user_id,username,password_hash) values($1,'preserved','synthetic-preserved-hash')`,
      [userId],
    );
    external = {
      id: randomUUID(),
      username: 'preserved',
      email: 'fixture@example.test',
      enabled: true,
      requiredActions: [],
      attributes: { [keycloakNameIdAttribute(binding.entityId)]: [`G-${randomUUID()}`] },
    };
    identityId = await linkExistingSamlIdentity(database, binding, {
      actorId,
      userId,
      expectedSubject: 'preserved-subject',
      keycloakUserId: external.id,
      identity: { ...reader.identity(external), nameIDFormat: persistentNameId },
    });
    await database.query(
      `update user_identities set enabled=true,provisioning_state='provisioned',identity_verified_at=clock_timestamp() where id=$1`,
      [identityId],
    );
    const lease = (await claimSecurityObservation(database, binding))!;
    await applySecurityObservation(database, binding, lease, observation('baseline'));
    await completeIdentitySecurityLogout(
      database,
      (await claimIdentitySecurityLogout(database, binding))!,
    );
    adapter = fixture();
  });
  const request = (kind: IdentityLifecycleRequest['kind'], requestId = randomUUID()) => ({
    kind,
    requestId,
    target: { kind: 'existing' as const, userId, expectedSubject: 'preserved-subject' },
    revokeAllSessions: true as const,
  });
  const queue = (kind: IdentityLifecycleRequest['kind']) =>
    requestIdentityLifecycle(database, binding, actorId, request(kind));
  const row = async () =>
    (await database.query('select * from user_identities where id=$1', [identityId])).rows[0];
  const operation = async (id: string) =>
    (await database.query('select * from identity_admin_operations where id=$1', [id])).rows[0];
  async function disableFixture() {
    await database.query('update users set enabled=false where id=$1', [userId]);
    await database.query(
      'update user_identities set enabled=false,idp_disabled_by_gcr=true where id=$1',
      [identityId],
    );
    external.enabled = false;
  }
  async function newLocalSession() {
    await database.query(
      `insert into user_sessions(id_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 hour')`,
      [hash(randomUUID()), userId],
    );
  }
  it('deduplicates a revocation across replicas and commits local access loss before IdP I/O', async () => {
    await newLocalSession();
    const input = request('disable');
    const results = await Promise.all([
      requestIdentityLifecycle(database, binding, actorId, input),
      requestIdentityLifecycle(replica, binding, actorId, input),
    ]);
    expect(results[0]!.id).toBe(results[1]!.id);
    expect(await row()).toMatchObject({
      enabled: false,
      idp_disabled_by_gcr: true,
      security_epoch: '3',
      security_fresh_until: null,
    });
    expect((await database.query('select count(*)::int n from user_sessions')).rows[0].n).toBe(0);
    expect(
      (await database.query('select desired_enabled from identity_security_logout_outbox')).rows,
    ).toEqual([{ desired_enabled: false }]);
    expect(external.enabled).toBe(true);
    expect(adapter.setEnabled).not.toHaveBeenCalled();
  });
  it('rejects changed payloads and a changed subject without another epoch increment', async () => {
    const input = request('logout-all');
    await requestIdentityLifecycle(database, binding, actorId, input);
    const before = await row();
    await expect(
      requestIdentityLifecycle(database, binding, actorId, { ...input, kind: 'disable' }),
    ).rejects.toMatchObject({ code: 'IDENTITY_OPERATION_CONFLICT' });
    await expect(
      requestIdentityLifecycle(database, binding, actorId, {
        ...request('disable'),
        target: { ...input.target, expectedSubject: 'different' },
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_OPERATION_CONFLICT' });
    expect(await row()).toEqual(before);
  });
  it('keeps a logout request actorless and completes only after the matching remote epoch', async () => {
    const item = await queue('logout-all');
    await database.query('update users set enabled=false where id=$1', [actorId]);
    expect(await completeIdentityRevocations(database, binding)).toBe(0);
    const result = await reconcileIdentitySecurity(database, binding, adapter);
    expect(result.loggedOut).toBe(true);
    expect(adapter.setEnabled).not.toHaveBeenCalled();
    expect((await operation(item.id)).state).toBe('succeeded');
    expect(
      (await database.query('select enabled from users where id=$1', [userId])).rows[0].enabled,
    ).toBe(true);
  });
  it('refuses to disable the last active administrator', async () => {
    await database.query("update users set role='administrator' where id=$1", [userId]);
    await database.query('update users set enabled=false where id=$1', [actorId]);
    await expect(
      requestIdentityLifecycle(database, binding, userId, request('disable')),
    ).rejects.toMatchObject({ code: 'IDENTITY_LAST_ADMINISTRATOR_REQUIRED' });
    expect((await row()).enabled).toBe(true);
  });
  it('requires current source health before accepting reactivation', async () => {
    await disableFixture();
    await database.query("update identity_security_sources set state='gap'");
    await expect(queue('enable')).rejects.toMatchObject({ code: 'IDENTITY_SECURITY_UNAVAILABLE' });
    expect((await database.query('select * from identity_admin_operations')).rowCount).toBe(0);
  });
  it('enables only after exact profile, own update/logout receipts and final epoch verification', async () => {
    const credentials = (await database.query('select * from local_credentials')).rows;
    await disableFixture();
    await newLocalSession();
    const item = await queue('enable');
    expect((await row()).enabled).toBe(false);
    expect(await processIdentityReactivation(database, binding, adapter)).toBe(true);
    expect((await operation(item.id)).state).toBe('succeeded');
    expect(await row()).toMatchObject({
      enabled: true,
      idp_disabled_by_gcr: false,
      security_epoch: item.expected_security_epoch,
      security_reconciled_epoch: item.expected_security_epoch,
    });
    expect(
      (await row()).security_fresh_until.getTime() - (await row()).security_checked_at.getTime(),
    ).toBe(300_000);
    expect((await database.query('select * from identity_security_logout_outbox')).rows).toEqual(
      [],
    );
    expect((await database.query('select * from user_sessions')).rows).toEqual([]);
    expect((await database.query('select * from local_credentials')).rows).toEqual(credentials);
    expect(
      (await database.query('select oidc_subject,personal_prompt from users where id=$1', [userId]))
        .rows[0],
    ).toEqual({ oidc_subject: 'preserved-subject', personal_prompt: 'Preserved prompt' });
    await database.query('update identity_security_sources set available_at=clock_timestamp()');
    await reconcileIdentitySecurity(database, binding, adapter);
    expect((await row()).security_epoch).toBe(item.expected_security_epoch);
    expect(adapter.logoutAll).toHaveBeenCalledTimes(1);
  });
  it('accepts an already enabled remote account only after a confirmed logout', async () => {
    await disableFixture();
    external.enabled = true;
    const item = await queue('enable');
    await processIdentityReactivation(database, binding, adapter);
    expect((await operation(item.id)).state).toBe('succeeded');
    expect(adapter.setEnabled).not.toHaveBeenCalled();
    expect(adapter.logoutAll).toHaveBeenCalledTimes(1);
  });
  it('persists an external administrator revocation seen beside its own writes', async () => {
    await disableFixture();
    const item = await queue('enable');
    adapter.logoutAll.mockImplementationOnce(async () => {
      events.push(adminEvent('logout-user'), adminEvent('update-user', false));
    });
    await processIdentityReactivation(database, binding, adapter);
    expect((await operation(item.id)).state).toBe('failed');
    expect((await row()).enabled).toBe(false);
    expect(BigInt((await row()).security_epoch)).toBeGreaterThan(
      BigInt(item.expected_security_epoch!),
    );
    expect((await database.query('select * from identity_security_event_receipts')).rowCount).toBe(
      3,
    );
    expect(
      (await database.query('select desired_enabled from identity_security_logout_outbox')).rows,
    ).toEqual([{ desired_enabled: false }]);
  });
  it('retains ordinary session tombstones while acknowledging its own administrative writes', async () => {
    await disableFixture();
    const item = await queue('enable');
    const sessionId = 'abcdefghijklmnopqrstuvwx';
    adapter.logoutAll.mockImplementationOnce(async () => {
      events.push(adminEvent('logout-user'), {
        id: randomUUID(),
        time: Date.now(),
        stream: 'security',
        kind: 'logout-session',
        userId: external.id,
        sessionId,
      });
    });
    await processIdentityReactivation(database, binding, adapter);
    expect((await operation(item.id)).state).toBe('succeeded');
    expect(
      (await database.query('select keycloak_session_hash from identity_idp_session_revocations'))
        .rows,
    ).toEqual([{ keycloak_session_hash: hash(sessionId) }]);
  });
  it('does not enable when its original administrator loses permission during the remote request', async () => {
    await disableFixture();
    const item = await queue('enable');
    adapter.logoutAll.mockImplementationOnce(async () => {
      events.push(adminEvent('logout-user'));
      await database.query("update users set role='reviewer' where id=$1", [actorId]);
    });
    await processIdentityReactivation(database, binding, adapter);
    expect((await operation(item.id)).state).toBe('failed');
    expect((await row()).enabled).toBe(false);
    expect((await database.query('select * from identity_security_event_receipts')).rowCount).toBe(
      2,
    );
    await reconcileIdentitySecurity(database, binding, adapter);
    expect(external.enabled).toBe(false);
  });
  it('cannot overwrite a newer GCR block accepted during remote enable', async () => {
    await disableFixture();
    const item = await queue('enable');
    adapter.setEnabled.mockImplementationOnce(async () => {
      external.enabled = true;
      events.push(adminEvent('update-user'));
      await queue('disable');
      return structuredClone(external);
    });
    await processIdentityReactivation(database, binding, adapter);
    expect(await operation(item.id)).toMatchObject({
      state: 'failed',
      error_code: 'IDENTITY_ACCESS_CHANGED',
    });
    expect((await row()).enabled).toBe(false);
    expect(adapter.logoutAll).not.toHaveBeenCalled();
    await reconcileIdentitySecurity(database, binding, adapter);
    expect(external.enabled).toBe(false);
  });
  it('keeps a durable block when a remote enable response is lost', async () => {
    await disableFixture();
    const item = await queue('enable');
    adapter.setEnabled.mockImplementationOnce(async () => {
      external.enabled = true;
      events.push(adminEvent('update-user'));
      throw new KeycloakAdminError('IDENTITY_RESULT_UNCONFIRMED');
    });
    await processIdentityReactivation(database, binding, adapter);
    expect(await operation(item.id)).toMatchObject({
      state: 'failed',
      error_code: 'IDENTITY_RESULT_UNCONFIRMED',
    });
    expect((await row()).enabled).toBe(false);
    await reconcileIdentitySecurity(database, binding, adapter);
    expect(external.enabled).toBe(false);
  });
  it('fails closed and persists available receipts when an own write cannot be correlated', async () => {
    await disableFixture();
    const item = await queue('enable');
    adapter.logoutAll.mockImplementationOnce(async () => {});
    await processIdentityReactivation(database, binding, adapter);
    expect((await operation(item.id)).state).toBe('failed');
    expect((await row()).enabled).toBe(false);
    expect((await database.query('select * from identity_security_event_receipts')).rowCount).toBe(
      1,
    );
  });
  it('rejects a changed persistent NameID before any remote write', async () => {
    await disableFixture();
    const item = await queue('enable');
    external.attributes![keycloakNameIdAttribute(binding.entityId)] = ['G-different'];
    await processIdentityReactivation(database, binding, adapter);
    expect(await operation(item.id)).toMatchObject({
      state: 'failed',
      error_code: 'IDENTITY_ACCOUNT_CONFLICT',
    });
    expect(adapter.setEnabled).not.toHaveBeenCalled();
    expect(adapter.logoutAll).not.toHaveBeenCalled();
  });
  it('does not automatically replay a claim left by a crashed process', async () => {
    await disableFixture();
    const item = await queue('enable');
    await claimIdentityOperation(database, binding, 'reactivation');
    await database.query(
      "update identity_admin_outbox set claimed_until=clock_timestamp()-interval '1 second'",
    );
    await processIdentityReactivation(replica, binding, adapter);
    expect(await operation(item.id)).toMatchObject({
      state: 'failed',
      error_code: 'IDENTITY_RESULT_UNCONFIRMED',
    });
    expect(adapter.capture).not.toHaveBeenCalled();
    expect(adapter.setEnabled).not.toHaveBeenCalled();
  });
  it('revalidates and binds a new epoch on an explicit retry, while provisioning retry rejects it', async () => {
    await disableFixture();
    const item = await queue('enable');
    adapter.capture.mockRejectedValueOnce(
      new KeycloakAdminError('IDENTITY_ADMIN_UNAVAILABLE', true),
    );
    await processIdentityReactivation(database, binding, adapter);
    await expect(retryIdentityOperation(database, binding, actorId, item.id)).rejects.toMatchObject(
      { code: 'IDENTITY_OPERATION_CONFLICT' },
    );
    await retryIdentityReactivation(database, binding, actorId, item.id);
    expect(BigInt((await operation(item.id)).expected_security_epoch)).toBeGreaterThan(
      BigInt(item.expected_security_epoch!),
    );
    await processIdentityReactivation(database, binding, adapter);
    expect((await operation(item.id)).state).toBe('succeeded');
  });
  it('does not acknowledge an epoch changed while a remote call is in flight', async () => {
    await disableFixture();
    const item = await queue('enable');
    adapter.logoutAll.mockImplementationOnce(async () => {
      events.push(adminEvent('logout-user'));
      await identityLifecycleTransaction(database, async (client) => {
        await client.query("select pg_advisory_xact_lock(hashtext('gcr:user-administration'))");
        await revokeUserIdentitySecurity(client, userId);
      });
    });
    await processIdentityReactivation(database, binding, adapter);
    expect((await operation(item.id)).state).toBe('failed');
    expect((await row()).enabled).toBe(false);
    expect((await row()).security_reconciled_epoch).not.toBe((await row()).security_epoch);
  });
  it('persists a confirmed source gap and refuses the remote enable', async () => {
    await disableFixture();
    const item = await queue('enable');
    adapter.capture.mockRejectedValueOnce(
      new KeycloakSecurityError('IDENTITY_EVENT_BATCH_INCOMPLETE'),
    );
    await processIdentityReactivation(database, binding, adapter);
    expect((await operation(item.id)).state).toBe('failed');
    expect(adapter.setEnabled).not.toHaveBeenCalled();
    expect((await database.query('select state from identity_security_sources')).rows).toEqual([
      { state: 'gap' },
    ]);
    expect((await row()).security_fresh_until).toBeNull();
  });
  it('does not revive an explicitly superseded operation on retry', async () => {
    await disableFixture();
    const item = await queue('enable');
    await identityLifecycleTransaction(database, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext('gcr:user-administration'))");
      await supersedeIdentityOperations(client, userId);
    });
    await expect(
      retryIdentityReactivation(database, binding, actorId, item.id),
    ).rejects.toMatchObject({ code: 'IDENTITY_OPERATION_CONFLICT' });
    expect(await processIdentityReactivation(database, binding, adapter)).toBe(false);
  });
  async function api(security: boolean) {
    const config = loadConfig({
      DATABASE_URL: databaseUrl!,
      AUTH_MODE: 'local',
      LOCAL_BOOTSTRAP_ADMIN_USERNAME: 'fixture-admin',
      LOCAL_BOOTSTRAP_ADMIN_PASSWORD: 'synthetic-fixture-password-only',
      IDENTITY_ADMIN_ENABLED: 'true',
      IDENTITY_SECURITY_ENABLED: String(security),
      PUBLIC_BASE_URL: 'https://gcr.test',
      SAML_IDP_ISSUER: binding.issuer,
      SAML_ENTITY_ID: binding.entityId,
      KEYCLOAK_ADMIN_CLIENT_ID: 'fixture',
      KEYCLOAK_ADMIN_CLIENT_SECRET_FILE: '/not-used-by-request-routes',
    });
    const app = Fastify();
    app.decorateRequest('user', null);
    app.addHook('onRequest', async (req) => {
      req.user =
        req.headers['x-fixture-role'] === 'anonymous'
          ? null
          : {
              id: actorId,
              subject: 'admin',
              displayName: 'Admin',
              enabled: true,
              role: req.headers['x-fixture-role'] === 'reviewer' ? 'reviewer' : 'administrator',
              groups: [],
              tenantIds: [],
              tenants: [],
            };
    });
    app.setErrorHandler((error, _req, reply) =>
      reply
        .code(error instanceof ZodError ? 400 : 500)
        .send({ error: { code: 'INVALID_FIXTURE_REQUEST' } }),
    );
    await registerIdentityAdministrationRoutes(
      app,
      database,
      new AuthorizationService(config),
      config,
    );
    return app;
  }
  it('advertises lifecycle capabilities only with security enabled and rejects disabled routes without writes', async () => {
    const app = await api(false);
    try {
      expect((await app.inject('/api/v1/admin/identity/capabilities')).json().actions).toEqual([
        'create',
        'link',
        'invite',
        'password-reset',
      ]);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/identity/operations',
            payload: request('disable'),
          })
        ).statusCode,
      ).toBe(404);
      expect((await database.query('select * from identity_admin_operations')).rows).toEqual([]);
    } finally {
      await app.close();
    }
  });
  it('protects lifecycle routes, requires revocation acknowledgment and returns a stable accepted operation', async () => {
    const app = await api(true);
    const input = request('logout-all');
    try {
      expect((await app.inject('/api/v1/admin/identity/capabilities')).json().actions).toEqual([
        'create',
        'link',
        'invite',
        'password-reset',
        'disable',
        'enable',
        'logout-all',
      ]);
      for (const role of ['anonymous', 'reviewer'])
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/v1/admin/identity/operations',
              headers: { 'x-fixture-role': role },
              payload: input,
            })
          ).statusCode,
        ).toBe(404);
      for (const payload of [
        { ...input, revokeAllSessions: false },
        { ...input, password: 'not-accepted' },
      ])
        expect(
          (await app.inject({ method: 'POST', url: '/api/v1/admin/identity/operations', payload }))
            .statusCode,
        ).toBe(400);
      const first = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/identity/operations',
        payload: input,
      });
      const second = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/identity/operations',
        payload: input,
      });
      expect(first.statusCode).toBe(202);
      expect(second.json()).toEqual(first.json());
      expect(first.json().operation).toMatchObject({
        kind: 'logout-all',
        state: 'pending',
        mailDelivery: 'not-requested',
        retryAllowed: false,
      });
      expect(first.json().operation).not.toHaveProperty('external_user_id');
      expect(first.json().operation).not.toHaveProperty('expected_security_epoch');
    } finally {
      await app.close();
    }
  });
  it('uses the lifecycle retry endpoint to authorize a new epoch after failure', async () => {
    await disableFixture();
    const item = await queue('enable');
    adapter.capture.mockRejectedValueOnce(
      new KeycloakAdminError('IDENTITY_ADMIN_UNAVAILABLE', true),
    );
    await processIdentityReactivation(database, binding, adapter);
    const app = await api(true);
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/identity/operations/${item.id}/retry`,
        payload: {},
      });
      expect(response.statusCode).toBe(202);
      expect((await operation(item.id)).state).toBe('pending');
      expect(BigInt((await operation(item.id)).expected_security_epoch)).toBeGreaterThan(
        BigInt(item.expected_security_epoch!),
      );
    } finally {
      await app.close();
    }
  });
});
