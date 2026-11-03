// Real protocol and runtime validation in an owned disposable fixture. This
// script never changes an operational realm or grants operational freshness.
// All realm changes, tokens, service accounts and target identities are owned by
// the enclosing disposable Keycloak fixture. Only structural evidence is saved.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { requiredSecurityEventTypes } from '../apps/runtime/src/identity/keycloak-security.ts';
import { reconcileIdentitySecurity } from '../apps/runtime/src/identity/security-processor.ts';
import { revokeUserIdentitySecurity } from '../apps/runtime/src/identity/revocation.ts';
import { requestIdentityLifecycle } from '../apps/runtime/src/identity/lifecycle.ts';
import { processIdentityReactivation } from '../apps/runtime/src/identity/reactivation.ts';
import { runWorker } from '../apps/runtime/src/jobs/worker.ts';
import { loadConfig } from '../apps/runtime/src/config.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';

export async function runKeycloakSecurityContract({
  admin,
  requestIdp,
  realm,
  clientId,
  clientSecret,
  client,
  management,
  serviceUser,
  adapter,
  userId,
  username,
  fixturePassword,
  login,
  logout,
  receipts,
  securityAdapter,
  database,
  databaseUrl,
  binding,
  progress,
}) {
  const checks = [];
  const eventTypes = [...requiredSecurityEventTypes];
  progress('enable-owned-event-store-and-reader-role');
  await admin(`/${realm}/events/config`, 'PUT', {
    eventsEnabled: true,
    eventsExpiration: 86400,
    enabledEventTypes: eventTypes,
    adminEventsEnabled: true,
    adminEventsDetailsEnabled: false,
  });
  const role = await admin(`/${realm}/clients/${management.id}/roles/view-events`);
  await admin(`/${realm}/users/${serviceUser.id}/role-mappings/clients/${management.id}`, 'POST', [
    role,
  ]);
  await admin(`/${realm}/clients/${client.id}/scope-mappings/clients/${management.id}`, 'POST', [
    role,
  ]);
  const mint = async () => {
    const response = await requestIdp(`/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      data: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    assert.equal(response.status, 200);
    const token = JSON.parse(response.text).access_token;
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    assert.equal(claims.sub, serviceUser.id);
    assert.equal(claims.azp, clientId);
    assert.deepEqual(
      new Set(claims.resource_access['realm-management'].roles),
      new Set(['manage-users', 'view-events']),
    );
    return { token, claims };
  };
  let current = await mint();
  const call = async (route, method = 'GET', data) => {
    const response = await requestIdp(`/admin/realms/${realm}` + route, {
      method,
      headers: { authorization: `Bearer ${current.token}`, 'content-type': 'application/json' },
      ...(data === undefined ? {} : { data: JSON.stringify(data) }),
    });
    return { status: response.status, body: response.text ? JSON.parse(response.text) : null };
  };
  const configuration = await call('/events/config');
  assert.equal(configuration.status, 200);
  assert.equal(configuration.body.eventsEnabled, true);
  assert.equal(configuration.body.adminEventsEnabled, true);
  assert.equal(configuration.body.adminEventsDetailsEnabled, false);
  for (const [route, method, data] of [
    ['/events', 'DELETE', undefined],
    ['/admin-events', 'DELETE', undefined],
    ['/events/config', 'PUT', { eventsEnabled: false }],
    ['', 'PUT', { displayName: 'Unauthorized' }],
  ])
    assert.equal((await call(route, method, data)).status, 403);
  checks.push(
    'manage-users-and-view-events-only',
    'read-events-without-clear-or-configure-permission',
  );
  const from = Date.now() - 60_000;
  const read = async () => {
    const [events, admins] = await Promise.all([
      call(`/events?dateFrom=${from}&max=501&direction=asc`),
      call(`/admin-events?dateFrom=${from}&max=501&direction=asc`),
    ]);
    assert.equal(events.status, 200);
    assert.equal(admins.status, 200);
    assert(Array.isArray(events.body) && events.body.length < 501);
    assert(Array.isArray(admins.body) && admins.body.length < 501);
    for (const event of [...events.body, ...admins.body]) {
      assert.equal(typeof event.id, 'string');
      assert.equal(typeof event.time, 'number');
    }
    assert(
      admins.body.every(
        (event) => event.representation === undefined || event.representation === null,
      ),
    );
    return { events: events.body, admins: admins.body };
  };
  progress('token-correlated-security-event-and-owned-admin-probe');
  const initial = await read();
  // Determine the selected Keycloak version's token/event correlation without
  // persisting the token, its claims, IP addresses or event detail values.
  const tokenEvents = initial.events.filter(
    (event) =>
      event.type === 'CLIENT_LOGIN' &&
      event.clientId === clientId &&
      event.userId === serviceUser.id,
  );
  progress('token-correlation');
  assert(tokenEvents.length > 0);
  const correlated = tokenEvents.find((event) => event.details?.token_id === current.claims.jti);
  assert(correlated, 'CLIENT_LOGIN event must identify the freshly issued token');
  const marker = randomUUID();
  const own = await call(`/users/${serviceUser.id}`);
  progress('owned-service-account-profile');
  assert.equal(own.status, 200);
  assert.equal(own.body.id, current.claims.sub);
  if (own.body.serviceAccountClientId)
    assert([clientId, client.id].includes(own.body.serviceAccountClientId));
  const humanSearch = await call(
    '/users?' +
      new URLSearchParams({
        search: `"${own.body.username}"`,
        briefRepresentation: 'true',
        max: '100',
      }),
  );
  assert.equal(humanSearch.status, 200);
  assert(!humanSearch.body.some((user) => user.id === serviceUser.id));
  await assert.rejects(adapter.getUser(serviceUser.id), { code: 'IDENTITY_PROFILE_INVALID' });
  assert.equal((await adapter.getUser(userId)).id, userId);
  checks.push('service-account-excluded-from-human-search-despite-omitted-profile-marker');
  assert.equal(
    (
      await call(`/users/${serviceUser.id}`, 'PUT', {
        attributes: { ...own.body.attributes, 'gcr.security.probe': [marker] },
      })
    ).status,
    204,
  );
  const readback = await call(`/users/${serviceUser.id}`);
  assert.deepEqual(readback.body.attributes['gcr.security.probe'], [marker]);
  const next = await read();
  progress('admin-probe-correlation');
  const oldIds = new Set(initial.admins.map((event) => event.id));
  const probe = next.admins.filter(
    (event) =>
      !oldIds.has(event.id) &&
      event.resourcePath === `users/${serviceUser.id}` &&
      event.operationType === 'UPDATE' &&
      event.authDetails?.userId === serviceUser.id,
  );
  assert.equal(probe.length, 1);
  const realmId = correlated.realmId;
  assert.equal(probe[0].realmId, realmId);
  checks.push(
    'client-login-correlated-by-token-id',
    'service-account-only-attribute-probe-has-one-admin-event',
    'event-ids-and-epoch-filter-without-profile-representation',
  );

  progress('ordinary-saml-logout-session-correlation');
  await admin(`/${realm}/users/${userId}`, 'PUT', { enabled: true });
  await login(username, fixturePassword);
  const sessionIndex = receipts.at(-1).identity.sessionIndex;
  const [keycloakSessionId, samlClientId, extra] = sessionIndex.split('::');
  assert(keycloakSessionId && samlClientId && extra === undefined);
  await logout();
  const loggedOut = await read();
  assert(
    loggedOut.events.some(
      (event) =>
        event.type === 'LOGIN' && event.userId === userId && event.sessionId === keycloakSessionId,
    ),
  );
  assert(
    loggedOut.events.some(
      (event) =>
        event.type === 'LOGOUT' && event.userId === userId && event.sessionId === keycloakSessionId,
    ),
  );
  checks.push('ordinary-saml-logout-event-identifies-sessionindex-user-session-component');
  const capture = async (checkpoint) => {
    try {
      return await securityAdapter.capture(checkpoint);
    } catch (error) {
      if (/^IDENTITY_[A-Z_]+$/.test(error.code ?? ''))
        progress(`adapter-${error.code}-${error.reason ?? 'other'}`);
      const raw = await read();
      for (const [stream, batch] of Object.entries(raw)) {
        const shapes = [
          ...new Set(
            batch.map((event) =>
              JSON.stringify(
                Object.fromEntries(
                  Object.entries(event)
                    .filter(([key]) => key !== 'details' && key !== 'authDetails')
                    .map(([key, value]) => [
                      key,
                      {
                        type: typeof value,
                        null: value === null,
                        ...(typeof value === 'string'
                          ? {
                              length: value.length,
                              uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                                value,
                              ),
                            }
                          : {}),
                      },
                    ]),
                ),
              ),
            ),
          ),
        ];
        console.log(
          JSON.stringify({ eventFieldShapes: stream, shapes: shapes.map((s) => JSON.parse(s)) }),
        );
      }
      throw error;
    }
  };
  const baseline = await capture();
  assert.equal(baseline.continuity, 'baseline');
  assert(
    baseline.events.some(
      (event) =>
        event.kind === 'logout-session' &&
        event.userId === userId &&
        event.sessionId === keycloakSessionId,
    ),
  );

  progress('direct-admin-disable-password-change-and-clear-detection');
  const before = new Set(next.admins.map((event) => event.id));
  await admin(`/${realm}/users/${userId}`, 'PUT', { enabled: false });
  await admin(`/${realm}/users/${userId}/reset-password`, 'PUT', {
    type: 'password',
    value: randomBytes(32).toString('base64url'),
    temporary: false,
  });
  const changed = await read();
  const changes = changed.admins.filter(
    (event) => !before.has(event.id) && event.resourcePath.startsWith(`users/${userId}`),
  );
  assert(
    changes.some(
      (event) => event.resourcePath === `users/${userId}` && event.operationType === 'UPDATE',
    ),
  );
  assert(
    changes.some(
      (event) =>
        event.resourcePath === `users/${userId}/reset-password` && event.operationType === 'ACTION',
    ),
  );
  assert.equal((await call(`/users/${userId}`)).body.enabled, false);
  const observedChanges = await capture(baseline.checkpoint);
  assert.equal(observedChanges.continuity, 'continuous');
  assert(
    observedChanges.events.some(
      (event) => event.kind === 'revoke-identity' && event.userId === userId,
    ),
  );
  checks.push('console-equivalent-disable-and-password-reset-produce-durable-admin-events');
  await admin(`/${realm}/events`, 'DELETE');
  await admin(`/${realm}/admin-events`, 'DELETE');
  current = await mint();
  const cleared = await read();
  assert(!cleared.events.some((event) => event.id === correlated.id));
  assert(!cleared.admins.some((event) => event.id === probe[0].id));
  assert(cleared.events.some((event) => event.details?.token_id === current.claims.jti));
  const observedClear = await capture(observedChanges.checkpoint);
  assert.equal(observedClear.continuity, 'gap');
  checks.push('production-security-adapter-baseline-continuity-session-scope-and-gap-detection');
  checks.push('old-anchors-disappear-after-log-clear-even-when-new-probe-succeeds');
  progress('production-collector-database-revocation-logout-and-profile-freshness');
  const identityCount = Number(
    (await database.query('select count(*) from user_identities')).rows[0].count,
  );
  const collectorPasses = [];
  for (let index = 0; index < identityCount + 2; index++)
    collectorPasses.push(await reconcileIdentitySecurity(database, binding, securityAdapter));
  assert(collectorPasses.some((pass) => pass.observed));
  assert(collectorPasses.some((pass) => pass.loggedOut));
  assert(collectorPasses.some((pass) => pass.profilesConfirmed > 0));
  const disabledMapping = (
    await database.query(
      'select enabled,security_fresh_until from user_identities where keycloak_user_id=$1',
      [userId],
    )
  ).rows[0];
  assert.equal(disabledMapping.enabled, false);
  assert.equal(disabledMapping.security_fresh_until, null);
  assert(
    Number(
      (await database.query('select count(*) from user_client_credential_epochs')).rows[0].count,
    ) > 0,
  );
  const fresh =
    await database.query(`select i.id from user_identities i join identity_security_sources s
    on s.idp_issuer=i.idp_issuer and s.sp_entity_id=i.sp_entity_id where i.enabled
    and i.security_reconciled_epoch=i.security_epoch and i.security_checked_at=s.checked_at
    and i.security_fresh_until=s.checked_at+interval '5 minutes' and i.security_fresh_until>clock_timestamp()`);
  assert(fresh.rowCount > 0);
  checks.push(
    'production-collector-persists-revocation-before-logout-and-grants-profile-freshness-only-at-event-checkpoint',
  );
  progress('explicit-gcr-block-survives-keycloak-reactivation');
  const blocked = (
    await database.query(`select i.id,i.user_id,i.keycloak_user_id from user_identities i
    join users u on u.id=i.user_id where i.enabled and u.enabled and u.role='reviewer' limit 1`)
  ).rows[0];
  assert(blocked);
  const connection = await database.connect();
  try {
    await connection.query('begin');
    await connection.query("select pg_advisory_xact_lock(hashtext('gcr:user-administration'))");
    await revokeUserIdentitySecurity(connection, blocked.user_id, {
      disableAtIdentityProvider: true,
    });
    await connection.query('update users set enabled=false where id=$1', [blocked.user_id]);
    await connection.query('update user_identities set enabled=false where id=$1', [blocked.id]);
    await connection.query('commit');
  } catch (error) {
    await connection.query('rollback');
    throw error;
  } finally {
    connection.release();
  }
  for (let index = 0; index < identityCount + 2; index++)
    await reconcileIdentitySecurity(database, binding, securityAdapter);
  assert.equal((await adapter.getUser(blocked.keycloak_user_id)).enabled, false);
  await admin(`/${realm}/users/${blocked.keycloak_user_id}`, 'PUT', { enabled: true });
  const convergence = [];
  for (let index = 0; index < identityCount + 4; index++) {
    await database.query('update identity_security_sources set available_at=clock_timestamp()');
    convergence.push(await reconcileIdentitySecurity(database, binding, securityAdapter));
  }
  assert.equal((await adapter.getUser(blocked.keycloak_user_id)).enabled, false);
  assert.equal(convergence.at(-1).loggedOut, false);
  assert.equal(
    Number(
      (await database.query('select count(*) from identity_security_logout_outbox')).rows[0].count,
    ),
    0,
  );
  assert.equal(
    (await database.query('select enabled from users where id=$1', [blocked.user_id])).rows[0]
      .enabled,
    false,
  );
  checks.push(
    'explicit-gcr-block-converges-after-direct-keycloak-enable-without-an-endless-logout-loop',
  );
  progress('verified-reactivation-and-all-device-logout');
  const actor = (
    await database.query(
      `select id from users where enabled and role='administrator' and deleted_at is null order by id limit 1`,
    )
  ).rows[0];
  assert(actor);
  const subject = (
    await database.query('select oidc_subject from users where id=$1', [blocked.user_id])
  ).rows[0].oidc_subject;
  const lifecycle = (kind) =>
    requestIdentityLifecycle(database, binding, actor.id, {
      kind,
      requestId: randomUUID(),
      target: { kind: 'existing', userId: blocked.user_id, expectedSubject: subject },
      revokeAllSessions: true,
    });
  const enabled = await lifecycle('enable');
  assert.equal(await processIdentityReactivation(database, binding, securityAdapter), true);
  const enabledResult = (
    await database.query('select state,error_code from identity_admin_operations where id=$1', [
      enabled.id,
    ])
  ).rows[0];
  assert.equal(
    enabledResult.state,
    'succeeded',
    `reactivation failed: ${enabledResult.error_code}`,
  );
  assert.equal((await adapter.getUser(blocked.keycloak_user_id)).enabled, true);
  const mapping = (await database.query('select * from user_identities where id=$1', [blocked.id]))
    .rows[0];
  assert.equal(mapping.enabled, true);
  assert.equal(mapping.idp_disabled_by_gcr, false);
  assert.equal(mapping.security_epoch, mapping.security_reconciled_epoch);
  assert.equal(
    mapping.security_fresh_until.getTime() - mapping.security_checked_at.getTime(),
    300_000,
  );
  checks.push(
    'reactivation-acknowledges-exact-own-enable-and-logout-events-before-restoring-app-access',
  );

  const logoutOperation = await lifecycle('logout-all');
  const ownedDirectory = await mkdtemp(path.join(tmpdir(), 'gcr-identity-worker-'));
  const stop = new AbortController();
  let worker;
  try {
    const reservation = createServer();
    await new Promise((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', resolve);
    });
    const healthPort = reservation.address().port;
    await new Promise((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    const workerConfig = loadConfig(
      {
        DATABASE_URL: databaseUrl,
        AUTH_MODE: 'local',
        LOCAL_BOOTSTRAP_ADMIN_USERNAME: 'owned-worker-admin',
        LOCAL_BOOTSTRAP_ADMIN_PASSWORD: randomBytes(32).toString('base64url'),
        HOST: '127.0.0.1',
        WORKER_HEALTH_PORT: String(healthPort),
        WORKER_CONCURRENCY: '1',
        DATABASE_POOL_MAX: '2',
        GITHUB_MODE: 'fixture',
        MODEL_MODE: 'disabled',
        WORKSPACE_ROOT: path.join(ownedDirectory, 'workspaces'),
        ARTIFACT_ROOT: path.join(ownedDirectory, 'artifacts'),
        PUBLIC_BASE_URL: new URL(binding.acsUrl).origin,
        IDENTITY_ADMIN_ENABLED: 'true',
        IDENTITY_SECURITY_ENABLED: 'true',
        SAML_IDP_ISSUER: binding.issuer,
        SAML_ENTITY_ID: binding.entityId,
        KEYCLOAK_ADMIN_CLIENT_ID: clientId,
        KEYCLOAK_ADMIN_CLIENT_SECRET_FILE: '/not-used-by-supplied-pinned-adapters',
      },
      'worker',
    );
    worker = runWorker(workerConfig, {
      identityAdministration: adapter,
      identitySecurity: securityAdapter,
      signal: stop.signal,
    });
    let workerFailure;
    void worker.catch((error) => {
      workerFailure = error;
    });
    const deadline = Date.now() + 45_000;
    let state,
      readyChecks = 0;
    while (Date.now() < deadline) {
      if (workerFailure) throw workerFailure;
      const ready = await fetch(`http://127.0.0.1:${healthPort}/health/ready`, {
        signal: AbortSignal.timeout(2000),
      })
        .then((response) => response.status)
        .catch(() => null);
      if (ready !== null) {
        assert.equal(ready, 200);
        readyChecks++;
      }
      state = (
        await database.query('select state from identity_admin_operations where id=$1', [
          logoutOperation.id,
        ])
      ).rows[0].state;
      if (state === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(state, 'succeeded');
    assert(readyChecks > 0);
    assert.equal((await adapter.getUser(blocked.keycloak_user_id)).enabled, true);
    assert.equal(
      (await database.query('select enabled from users where id=$1', [blocked.user_id])).rows[0]
        .enabled,
      true,
    );
    checks.push(
      'actual-worker-loop-drains-all-device-logout-with-two-db-connections-and-one-review-slot',
    );
  } finally {
    stop.abort();
    try {
      if (worker) await worker;
    } finally {
      await rm(ownedDirectory, { recursive: true, force: true });
    }
  }
  return {
    status: 'passed',
    checks,
    securityTypes: eventTypes,
    adminRoles: ['manage-users', 'view-events'],
    adminRepresentations: false,
    directServiceAccountMarkerPresent: own.body.serviceAccountClientId !== undefined,
    securityTokenCorrelation: 'details.token_id equals issued JWT jti',
    query:
      'epoch milliseconds; one bounded complete batch; timestamp ordering is not an offset cursor',
    eventContinuityImplementation:
      'production bounded REST observation and durable PostgreSQL collector; explicit reactivation and actual worker logout scheduling',
  };
}
