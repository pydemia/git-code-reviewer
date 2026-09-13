// Called by saml-contract-smoke.mjs --application after its real Keycloak PoC.
// Only the verified fixture NameID is explicitly mapped to a fixture GCR user.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, runMigrations } from '../packages/db/src/index.ts';
import { loadConfig } from '../apps/runtime/src/config.ts';
import { buildServer } from '../apps/runtime/src/server.ts';
import { validateSamlSettings } from '../apps/runtime/src/auth/saml-config.ts';
import { linkExistingSamlIdentity } from '../apps/runtime/src/auth/saml-state.ts';

export async function runApplicationSmoke({
  browser,
  config,
  directory,
  spKeys,
  metadataXml,
  identity,
  keycloakUserId,
  userPassword,
  wire,
  progress,
}) {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const schema = `gcr_app_smoke_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(process.env.GCR_TEST_DATABASE_URL ?? '');
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'Owned loopback PostgreSQL required',
  );
  const root = createDatabase(url.href),
    apps = [],
    ports = [],
    receipts = [];
  let database,
    context,
    schemaCreated = false,
    serial = 0;
  const evidence = { status: 'running', checks: [], replicas: 2, cleanup: {} };
  const spOrigin = new URL(config.acs).origin;
  try {
    progress('database');
    await root.query(`create schema ${schema}`);
    schemaCreated = true;
    url.searchParams.set('options', `-c search_path=${schema}`);
    database = createDatabase(url.href);
    await runMigrations(database, path.join(repository, 'packages/db/migrations'));
    const metadataFile = path.join(directory, 'application-idp.xml');
    await writeFile(metadataFile, metadataXml, { mode: 0o600 });
    const applicationConfig = loadConfig({
      DATABASE_URL: url.href,
      AUTH_MODE: 'saml',
      NODE_ENV: 'production',
      GITHUB_MODE: 'disabled',
      PUBLIC_BASE_URL: spOrigin,
      SESSION_SECRET: randomBytes(32).toString('base64url'),
      WEB_DIST: path.join(repository, 'apps/web/dist'),
      ARTIFACT_ROOT: path.join(directory, 'app-artifacts'),
      SAML_IDP_ISSUER: config.idpIssuer,
      SAML_IDP_ENTRY_POINT: config.entryPoint,
      SAML_IDP_METADATA_URL: config.entryPoint + '/descriptor',
      SAML_IDP_METADATA_FILE: metadataFile,
      SAML_PRIVATE_KEY_FILE: spKeys.keyPath,
      SAML_PUBLIC_CERT_FILE: spKeys.certPath,
    });
    const administrator = (
      await database.query(
        "insert into users(oidc_subject,display_name,role) values('fixture-admin','Fixture Administrator','administrator') returning id",
      )
    ).rows[0].id;
    const userId = (
      await database.query(
        "insert into users(oidc_subject,display_name,role,groups_json) values('original-gcr-subject','Original GCR name','reviewer','[\"engineering\"]') returning id",
      )
    ).rows[0].id;
    const identityId = await linkExistingSamlIdentity(
      database,
      validateSamlSettings(applicationConfig),
      {
        actorId: administrator,
        userId,
        expectedSubject: 'original-gcr-subject',
        keycloakUserId,
        identity,
      },
    );
    await database.query(
      "update user_identities set enabled=true,provisioning_state='provisioned',identity_verified_at=clock_timestamp(),security_checked_at=statement_timestamp(),security_fresh_until=statement_timestamp()+interval '5 minutes' where id=$1",
      [identityId],
    );
    evidence.checks.push('explicit-fixture-mapping-from-verified-persistent-nameid');
    progress('servers');
    for (let i = 0; i < 2; i++) {
      const app = await buildServer(applicationConfig);
      apps.push(app);
      await app.listen({ host: '127.0.0.1', port: 0 });
      ports.push(app.server.address().port);
    }
    wire((request, response) => {
      if (request.headers.host !== new URL(spOrigin).host) {
        response.writeHead(400);
        response.end();
        return;
      }
      const replica = serial++ % ports.length;
      let receipt;
      if (request.method === 'POST' && request.url === '/auth/saml/acs') {
        receipt = {
          replica,
          method: request.method,
          fetchSite: request.headers['sec-fetch-site'],
          transactionCookieReceived: (request.headers.cookie ?? '').includes(
            '__Host-gcr_saml_login_',
          ),
          sessionCookieReceived: /(?:^|;\s*)gcr_session=/.test(request.headers.cookie ?? ''),
        };
        receipts.push(receipt);
      }
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port: ports[replica],
          path: request.url,
          method: request.method,
          headers: request.headers,
        },
        (res) => {
          if (receipt) receipt.status = res.statusCode;
          response.writeHead(res.statusCode, res.headers);
          res.pipe(response);
        },
      );
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    });
    context = await browser.newContext({ ignoreHTTPSErrors: false });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => {
      pageErrors.push(error.name);
    });
    progress('login-page');
    await page.goto(spOrigin + '/login?returnTo=%2Fguide');
    await page.getByRole('link', { name: '조직 계정으로 로그인' }).waitFor();
    assert.equal(await page.locator('input[type="password"]').count(), 0);
    evidence.checks.push('compiled-login-page-advertises-saml-without-local-password');
    await page.getByRole('link', { name: '조직 계정으로 로그인' }).click();
    progress('keycloak-credentials');
    await page.locator('input[name="username"]').fill('contract-user');
    await page.locator('input[name="password"]').fill(userPassword);
    await page.locator('button[type="submit"], input[type="submit"]').click();
    await page.waitForURL(spOrigin + '/guide', { timeout: 30_000 });
    progress('application-session');
    const sessionUser = await page.evaluate(async () => {
      const response = await fetch('/api/v1/me');
      return { status: response.status, data: await response.json() };
    });
    assert.equal(sessionUser.status, 200);
    assert.equal(sessionUser.data.id, userId);
    assert.equal(sessionUser.data.subject, 'original-gcr-subject');
    assert.equal(sessionUser.data.displayName, 'Original GCR name');
    assert.equal(sessionUser.data.role, 'reviewer');
    assert.deepEqual(sessionUser.data.groups, ['engineering']);
    assert.equal(receipts.length, 1);
    assert.deepEqual(
      { ...receipts[0], replica: null },
      {
        replica: null,
        method: 'POST',
        fetchSite: 'cross-site',
        transactionCookieReceived: true,
        sessionCookieReceived: false,
        status: 303,
      },
    );
    const sessionCookies = (await context.cookies()).filter(
      (cookie) => cookie.name === 'gcr_session',
    );
    assert.equal(sessionCookies.length, 1);
    assert.equal(sessionCookies[0].secure, true);
    assert.equal(sessionCookies[0].httpOnly, true);
    assert.equal(sessionCookies[0].sameSite, 'Lax');
    assert.equal(sessionCookies[0].domain, 'gcr.sp.test');
    assert.equal(
      (await context.cookies()).filter((cookie) => cookie.name.startsWith('__Host-gcr_saml_'))
        .length,
      0,
    );
    evidence.checks.push(
      'real-keycloak-cross-site-acs-to-application',
      'durable-session-shared-by-application-replicas',
      'existing-gcr-authority-preserved',
      'secure-host-only-lax-session-and-completed-transaction-cookie-removal',
    );
    progress('application-logout');
    await page.getByRole('button', { name: '로그아웃', exact: true }).click();
    await page.waitForURL(spOrigin + '/login', { timeout: 30_000 });
    await page.getByRole('link', { name: '조직 계정으로 로그인' }).waitFor();
    assert.equal(
      (await context.cookies()).filter(
        (cookie) => cookie.name === 'gcr_session' || cookie.name.startsWith('__Host-gcr_saml_'),
      ).length,
      0,
    );
    assert.equal(
      (
        await database.query('select count(*)::int as n from user_sessions where user_id=$1', [
          userId,
        ])
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await database.query(
          "select count(*)::int as n from saml_transactions where kind='logout' and consumed_at is not null",
        )
      ).rows[0].n,
      1,
    );
    assert.equal(await page.evaluate(async () => (await fetch('/api/v1/me')).status), 401);
    evidence.checks.push(
      'compiled-logout-button-real-keycloak-slo',
      'logout-response-consumed-in-database',
      'logout-clears-local-cookie-and-denies-api',
    );
    await page.getByRole('link', { name: '조직 계정으로 로그인' }).click();
    await page.locator('input[name="username"]').waitFor();
    assert.equal(new URL(page.url()).origin, new URL(config.idpIssuer).origin);
    evidence.checks.push('new-login-requires-keycloak-credentials-after-slo');
    assert.deepEqual(pageErrors, []);
    evidence.checks.push('no-browser-uncaught-errors');
    evidence.receipts = receipts;
    evidence.migrations = (
      await database.query('select count(*)::int as n from schema_migrations')
    ).rows[0].n;
    evidence.assetSha256 = Object.fromEntries(
      await Promise.all(
        (await readdir(path.join(applicationConfig.WEB_DIST, 'assets')))
          .filter((name) => /\.(js|css)$/.test(name))
          .map(async (name) => [
            name,
            createHash('sha256')
              .update(await readFile(path.join(applicationConfig.WEB_DIST, 'assets', name)))
              .digest('hex'),
          ]),
      ),
    );
    evidence.status = 'passed';
  } finally {
    await context?.close();
    wire(undefined);
    for (const app of apps) await app.close();
    await database?.end();
    if (schemaCreated) await root.query(`drop schema ${schema} cascade`);
    await root.end();
    evidence.cleanup = {
      browserContextClosed: true,
      applicationServersClosed: true,
      schemaDropped: schemaCreated,
    };
  }
  return evidence;
}
