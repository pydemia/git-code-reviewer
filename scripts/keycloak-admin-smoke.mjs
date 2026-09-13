// Extends the existing HTTPS/real-SAML fixture with the production Admin API
// adapter. All setup, identities, roles and SMTP resources belong to this run.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createDatabase, runMigrations } from '../packages/db/src/index.ts';
import { requestIdentityProvisioning } from '../apps/runtime/src/identity/operations.ts';
import { processIdentityOperation } from '../apps/runtime/src/identity/processor.ts';
import {
  KeycloakAdminClient,
  keycloakAppUserAttribute,
  keycloakOperationAttribute,
  keycloakNameIdAttribute,
  plannedKeycloakNameId,
} from '../apps/runtime/src/identity/keycloak-admin.ts';

const NODE_IMAGE =
  'node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32';

export async function runKeycloakAdminSmoke({
  browser,
  wire,
  config,
  directory,
  realm,
  admin,
  requestIdp,
  login,
  logout,
  receipts,
  page,
  docker,
  network,
  ownContainer,
  progress,
}) {
  return withIdentityDatabase(async ({ database, databaseUrl, actorId, tenantId }) => {
    const checks = [];
    const step = (name) => progress(name);
    const clientId = 'gcr-identity-administration';
    const clientSecret = randomBytes(32).toString('base64url');
    const secretFile = path.join(directory, 'identity-admin.secret');
    await writeFile(secretFile, clientSecret, { mode: 0o600, flag: 'wx' });
    step('service-account-and-protected-attributes');
    const profile = await admin(`/${realm}/users/profile`);
    await admin(`/${realm}/users/profile`, 'PUT', {
      ...profile,
      unmanagedAttributePolicy: 'ADMIN_EDIT',
    });
    await admin(`/${realm}/clients`, 'POST', {
      clientId,
      protocol: 'openid-connect',
      enabled: true,
      publicClient: false,
      secret: clientSecret,
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      fullScopeAllowed: false,
    });
    const [client] = await admin(`/${realm}/clients?clientId=${clientId}`);
    const serviceUser = await admin(`/${realm}/clients/${client.id}/service-account-user`);
    const [management] = await admin(`/${realm}/clients?clientId=realm-management`);
    const role = await admin(`/${realm}/clients/${management.id}/roles/manage-users`);
    await admin(
      `/${realm}/users/${serviceUser.id}/role-mappings/clients/${management.id}`,
      'POST',
      [role],
    );
    await admin(`/${realm}/clients/${client.id}/scope-mappings/clients/${management.id}`, 'POST', [
      role,
    ]);
    const assigned = await admin(
      `/${realm}/users/${serviceUser.id}/role-mappings/clients/${management.id}`,
    );
    assert.deepEqual(
      assigned.map(({ name }) => name),
      ['manage-users'],
    );

    let serviceToken,
      createRequests = 0,
      emailRequests = 0;
    let loseCreate = false,
      loseEmail = false;
    const transport = async (input, init = {}) => {
      const url = new URL(String(input));
      assert.equal(url.origin, new URL(config.idpIssuer).origin);
      assert.equal(init.redirect, 'error');
      assert(init.signal);
      if (url.pathname.endsWith('/protocol/openid-connect/token')) {
        const form = new URLSearchParams(init.body);
        assert.equal(form.get('grant_type'), 'client_credentials');
        assert.equal(form.get('client_id'), clientId);
        assert(!form.has('username') && !form.has('password'));
      }
      const result = await requestIdp(url.pathname + url.search, {
        method: init.method,
        headers: init.headers,
        data: init.body,
      });
      if (url.pathname.endsWith('/protocol/openid-connect/token') && result.status === 200)
        serviceToken = JSON.parse(result.text).access_token;
      if (url.pathname.endsWith('/users') && init.method === 'POST') {
        createRequests++;
        if (loseCreate && result.status === 201) {
          loseCreate = false;
          throw new Error('Synthetic accepted create response lost');
        }
      }
      if (url.pathname.endsWith('/execute-actions-email')) {
        emailRequests++;
        if (loseEmail && result.status === 204) {
          loseEmail = false;
          throw new Error('Synthetic accepted email response lost');
        }
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(result.headers))
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      return new Response([204, 205, 304].includes(result.status) ? null : result.text, {
        status: result.status,
        headers,
      });
    };
    const adapter = new KeycloakAdminClient(
      {
        issuer: config.idpIssuer,
        entityId: config.entityId,
        clientId,
        clientSecretFile: secretFile,
      },
      transport,
    );
    const binding = {
      issuer: config.idpIssuer,
      entityId: config.entityId,
      acsUrl: config.acs,
      sloUrl: config.slo,
    };
    const queued = await requestIdentityProvisioning(database, binding, actorId, {
      kind: 'create',
      requestId: randomUUID(),
      username: 'provisioned-user',
      email: 'provisioned@example.test',
      displayName: 'Provisioned',
      target: { kind: 'new', role: 'reviewer', tenantIds: [tenantId] },
    });
    const plan = {
      operationId: queued.id,
      userId: queued.user_id,
      username: queued.requested_username,
      email: queued.requested_email,
      displayName: queued.requested_display_name,
    };
    step('disabled-user-and-idempotent-reconciliation');
    loseCreate = true;
    const created = await adapter.ensureCreated(plan);
    assert.equal(created.enabled, false);
    assert.equal(created.emailVerified, false);
    assert.deepEqual(
      new Set(created.requiredActions),
      new Set(['VERIFY_EMAIL', 'UPDATE_PASSWORD']),
    );
    assert.equal((await adapter.ensureCreated(plan)).id, created.id);
    assert.equal(createRequests, 1);
    assert.equal((await admin(`/${realm}/users?username=${plan.username}&exact=true`)).length, 1);
    assert.deepEqual(await admin(`/${realm}/users/${created.id}/credentials`), []);
    await assert.rejects(adapter.ensureCreated({ ...plan, userId: randomUUID() }), {
      code: 'IDENTITY_ACCOUNT_CONFLICT',
      retryable: false,
    });
    await assert.rejects(adapter.sendActionsEmail(created.id, plan.email, 'invite'), {
      code: 'IDENTITY_PROFILE_INVALID',
    });
    assert.equal(emailRequests, 0);
    checks.push(
      'disabled-user-without-password',
      'persistent-admin-only-operation-markers',
      'lost-create-response-reconciles-one-user',
      'repeated-operation-does-not-create-duplicate',
      'username-match-with-another-gcr-user-rejected',
      'disabled-user-email-rejected',
    );

    step('service-account-permission-boundaries');
    assert(serviceToken);
    const realmRoles = JSON.parse(Buffer.from(serviceToken.split('.')[1], 'base64url'))
      .resource_access['realm-management'].roles;
    assert.deepEqual(realmRoles, ['manage-users']);
    for (const [route, method, data] of [
      [`/admin/realms/${realm}`, 'PUT', { displayName: 'Unauthorized' }],
      [`/admin/realms/${realm}/clients`, 'POST', { clientId: 'unauthorized-client' }],
      [`/admin/realms/${realm}/components`, 'POST', { name: 'unauthorized-key' }],
      ['/admin/realms/master/users', 'GET', undefined],
    ]) {
      const result = await requestIdp(route, {
        method,
        headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' },
        ...(data ? { data: JSON.stringify(data) } : {}),
      });
      assert.equal(
        result.status,
        403,
        'Service account must not administer realm, clients, keys or master',
      );
    }
    checks.push(
      'manage-users-only-realm-role',
      'realm-client-key-and-master-administration-forbidden',
    );

    step('smtp-failure-and-accepted-delivery');
    assert.equal(
      (await database.query('select enabled from users where id=$1', [plan.userId])).rows[0]
        .enabled,
      false,
    );
    assert.equal(await processIdentityOperation(database, binding, adapter), true);
    assert.equal(await processIdentityOperation(database, binding, adapter), false);
    const completed = (
      await database.query('select * from identity_admin_operations where id=$1', [queued.id])
    ).rows[0];
    assert.equal(completed.state, 'succeeded');
    assert.equal(completed.external_user_id, created.id);
    assert.equal(
      (await database.query('select enabled from users where id=$1', [plan.userId])).rows[0]
        .enabled,
      true,
    );
    const mapped = (
      await database.query('select * from user_identities where id=$1', [completed.identity_id])
    ).rows[0];
    assert.equal(mapped.provisioning_state, 'provisioned');
    assert.equal(mapped.name_id, plannedKeycloakNameId(plan.operationId));
    assert.equal(mapped.enabled, true);
    assert.equal(mapped.security_checked_at, null);
    assert.equal(mapped.security_fresh_until, null);
    assert.equal((await adapter.getUser(created.id)).enabled, true);
    assert.equal(createRequests, 1);
    checks.push(
      'real-postgresql-outbox-to-keycloak-to-stable-gcr-identity',
      'application-enabled-only-after-verified-provisioning',
      'provisioning-does-not-renew-security-freshness',
    );
    await assert.rejects(adapter.sendActionsEmail(created.id, plan.email, 'invite'), {
      code: 'IDENTITY_EMAIL_UNCONFIRMED',
      retryable: false,
    });
    const smtpName = `gcr-saml-smtp-${randomUUID()}`;
    step('smtp-fixture-start');
    const smtpScript = path.join(directory, 'identity-smtp-fixture.mjs');
    await copyFile(new URL('./identity-smtp-fixture.mjs', import.meta.url), smtpScript);
    await docker([
      'run',
      '-d',
      '--pull=never',
      '--name',
      smtpName,
      '--network',
      network,
      '--network-alias',
      'smtp.fixture',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      '1000:1000',
      '--memory',
      '128m',
      '--pids-limit',
      '64',
      '--mount',
      `type=bind,source=${smtpScript},target=/fixture.mjs,readonly`,
      NODE_IMAGE,
      'node',
      '/fixture.mjs',
    ]);
    ownContainer(smtpName);
    const smtpCount = async () =>
      JSON.parse(
        await docker([
          'exec',
          smtpName,
          'node',
          '-e',
          'fetch("http://127.0.0.1:8026").then(r=>r.text()).then(t=>process.stdout.write(t))',
        ]),
      ).messages;
    step('smtp-fixture-ready');
    let ready = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        ready = (await smtpCount()) === 0;
      } catch {
        /* private sink startup */
      }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(ready, 'Disposable SMTP sink must be ready');
    step('smtp-fixture-realm-configuration');
    await admin(`/${realm}`, 'PUT', {
      smtpServer: {
        host: 'smtp.fixture',
        port: '8025',
        from: 'no-reply@example.test',
        ssl: 'false',
        starttls: 'false',
        auth: 'false',
      },
    });
    step('smtp-fixture-invite');
    await adapter.sendActionsEmail(created.id, plan.email, 'invite');
    assert.equal(await smtpCount(), 1);
    await adapter.sendActionsEmail(created.id, plan.email, 'password-reset');
    assert.equal(await smtpCount(), 2);
    loseEmail = true;
    await assert.rejects(adapter.sendActionsEmail(created.id, plan.email, 'invite'), {
      code: 'IDENTITY_EMAIL_UNCONFIRMED',
      retryable: false,
    });
    assert.equal(await smtpCount(), 3);
    assert.equal(emailRequests, 4);
    checks.push(
      'smtp-failure-visible-without-automatic-resend',
      'invite-and-reset-email-accepted-by-private-sink',
      'lost-email-response-is-unconfirmed-and-not-repeated',
    );

    step('end-user-cannot-change-linking-attributes');
    const fixturePassword = randomBytes(24).toString('base64url');
    // Only fixture setup uses the admin password endpoint. The adapter never sets,
    // reads, stores or returns the user's password or an emailed action token.
    await admin(`/${realm}/users/${created.id}`, 'PUT', {
      lastName: 'Fixture',
      emailVerified: true,
      requiredActions: [],
    });
    await admin(`/${realm}/users/${created.id}/reset-password`, 'PUT', {
      type: 'password',
      value: fixturePassword,
      temporary: false,
    });
    await admin(`/${realm}/clients`, 'POST', {
      clientId: 'fixture-end-user-token',
      protocol: 'openid-connect',
      enabled: true,
      publicClient: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: true,
    });
    const tokenResult = await requestIdp(`/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      data: new URLSearchParams({
        grant_type: 'password',
        client_id: 'fixture-end-user-token',
        username: plan.username,
        password: fixturePassword,
      }).toString(),
    });
    assert.equal(tokenResult.status, 200);
    const userToken = JSON.parse(tokenResult.text).access_token;
    const attributes = (await adapter.getUser(created.id)).attributes;
    const userView = await requestIdp(`/realms/${realm}/account/`, {
      headers: { authorization: `Bearer ${userToken}`, accept: 'application/json' },
    });
    assert.equal(userView.status, 200);
    const account = JSON.parse(userView.text);
    for (const key of Object.keys(attributes)) assert.equal(account.attributes?.[key], undefined);
    const edited = await requestIdp(`/realms/${realm}/account/`, {
      method: 'POST',
      headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
      data: JSON.stringify({
        ...account,
        attributes: {
          ...account.attributes,
          [keycloakAppUserAttribute]: [randomUUID()],
          [keycloakOperationAttribute]: [randomUUID()],
          [keycloakNameIdAttribute(config.entityId)]: ['G-unapproved-name-id'],
        },
      }),
    });
    assert([200, 204, 400, 403].includes(edited.status));
    assert.deepEqual((await adapter.getUser(created.id)).attributes, attributes);
    checks.push('end-user-cannot-read-or-change-provisioning-markers-and-nameid');

    step('real-signed-nameid-matches-admin-provisioning');
    const expectedIdentity = adapter.identity(await adapter.getUser(created.id));
    assert.equal(expectedIdentity.nameID, plannedKeycloakNameId(plan.operationId));
    const beforeLogin = receipts.length;
    await login(plan.username, fixturePassword);
    assert.equal(receipts.length, beforeLogin + 1);
    const signed = receipts.at(-1).identity;
    for (const key of ['nameID', 'nameIDFormat', 'nameQualifier', 'spNameQualifier'])
      assert.equal(signed[key] ?? null, expectedIdentity[key]);
    assert.equal(signed.nameID, mapped.name_id);
    assert.equal(receipts.at(-1).fetchSite, 'cross-site');
    await logout();
    checks.push(
      'actual-signed-persistent-nameid-matches-planned-admin-attribute',
      'actual-signed-nameid-has-no-qualifiers',
      'provisioned-user-cross-site-saml-and-slo',
    );

    step('logout-all-and-disabled-login');
    await adapter.logoutAll(created.id);
    assert.deepEqual(await admin(`/${realm}/users/${created.id}/sessions`), []);
    assert.equal((await adapter.setEnabled(created.id, false)).enabled, false);
    const beforeDisabled = receipts.length;
    await page.goto(new URL('/auth/saml/login', config.entityId).href);
    await page.locator('input[name="username"]').fill(plan.username);
    await page.locator('input[name="password"]').fill(fixturePassword);
    const deniedResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === 'POST' &&
        url.origin === new URL(config.idpIssuer).origin &&
        url.pathname === `/realms/${realm}/login-actions/authenticate`
      );
    });
    await page.locator('button[type="submit"], input[type="submit"]').click();
    assert.equal((await deniedResponse).status(), 200);
    await page.locator('input[name="username"]').waitFor({ state: 'visible' });
    assert(await page.locator('input[name="password"]').isVisible());
    assert.equal(new URL(page.url()).origin, new URL(config.idpIssuer).origin);
    assert.equal(receipts.length, beforeDisabled);
    checks.push(
      'admin-logout-all-removes-idp-sessions',
      'disabled-user-cannot-produce-saml-callback',
    );
    const { runIdentityApplicationSmoke } = await import('./identity-application-smoke.mjs');
    const application = await runIdentityApplicationSmoke({
      browser,
      wire,
      config,
      directory,
      database,
      databaseUrl,
      tenantId,
      adapter,
      binding,
      clientId,
      secretFile,
      smtpCount,
      progress(value) {
        step(`application:${value}`);
      },
    });
    return {
      status: 'passed',
      application,
      checks,
      createRequests,
      emailRequests,
      smtpMessages: await smtpCount(),
      standardRealmRoles: ['manage-users'],
      unmanagedAttributePolicy: 'ADMIN_EDIT',
      productionCredentialFlows: ['client_credentials'],
      smtpImage: NODE_IMAGE,
      appDatabaseMigrations: Number(
        (await database.query('select count(*) from schema_migrations')).rows[0].count,
      ),
    };
  });
}

async function withIdentityDatabase(run) {
  const url = new URL(process.env.GCR_TEST_DATABASE_URL ?? 'http://missing.invalid');
  assert(
    ['postgres:', 'postgresql:'].includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    'Run with the owned PostgreSQL fixture',
  );
  const root = createDatabase(url.href),
    schema = `gcr_identity_${randomUUID().replaceAll('-', '')}`;
  let database;
  try {
    await root.query(`create schema ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    database = createDatabase(url.href);
    await runMigrations(database);
    const actorId = (
      await database.query(`insert into users(oidc_subject,display_name,role)
      values('identity-fixture-admin','Identity fixture admin','administrator') returning id`)
    ).rows[0].id;
    const tenantId = (await database.query("select id from tenants where slug='default'")).rows[0]
      .id;
    return await run({ database, databaseUrl: url.href, actorId, tenantId });
  } finally {
    await database?.end();
    await root.query(`drop schema if exists ${schema} cascade`);
    await root.end();
  }
}
