// Real disposable Keycloak + PostgreSQL + HTTPS browser adoption test.
// No application database, existing realm, user, key, Docker volume, or OS trust
// store is changed. Only synthetic identities and credentials are used.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import {
  NS,
  PERSISTENT,
  C14N,
  MAX_XML_BYTES,
  transaction,
  loginUrl,
  logoutUrl,
  metadata,
  parseXml,
  parseIdpMetadata,
  verifyLogin,
  verifyLogoutResponse,
  SamlContractError,
} from './saml-contract.mjs';
import { certificate, consume } from './saml-contract-fixtures.mjs';

const exec = promisify(execFile);
const applicationMode = process.argv.includes('--application');
const adminMode = process.argv.includes('--admin-contract');
assert(!(applicationMode && adminMode), 'Select one application or administration contract');
const KC_IMAGE =
  'quay.io/keycloak/keycloak@sha256:ff4257d0d64efbe99ed1ddfaf07765cc3c36dc7518bf8324d41961327f441c54';
const PG_IMAGE = 'postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73';
const directory = await mkdtemp(path.join(tmpdir(), 'gcr-saml-'));
const id = randomUUID();
const names = {
  network: `gcr-saml-${id}`,
  postgres: `gcr-saml-pg-${id}`,
  keycloak: `gcr-saml-kc-${id}`,
};
const ownedContainers = [];
const evidence = {
  formatVersion: 1,
  phase: adminMode ? 'P03-C04' : applicationMode ? 'P03-C03' : 'P03-C01',
  status: 'running',
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  keycloakVersion: '26.7.3',
  keycloakImage: KC_IMAGE,
  postgresImage: PG_IMAGE,
  nodeSaml: '5.1.0',
  xmlCrypto: '6.1.2',
  checks: [],
  limitations: [
    'isolated PoC, not the application authentication routes',
    'Chromium headless; Safari and interactive browser operation pending',
    'test-specific generated TLS leaf SPKI pins; no system trust installation',
    'in-memory transaction ledger; PostgreSQL cross-replica replay is P03-C02',
    'ephemeral single identity DB; shared DB ACL and existing-volume migration are P03-C06',
  ],
  cleanup: {},
};
let browser,
  page,
  spServer,
  idpServer,
  networkOwned = false,
  stage = 'prepare';
let config, upstreamPort;
let applicationHandler;
const transactions = new Map(),
  sessions = new Map(),
  ledger = new Set();
const acsReceipts = [],
  rejectedMessages = [];
let logoutReceipt;
evidence.sourceSha256 = Object.fromEntries(
  await Promise.all(
    [
      '../apps/runtime/src/auth/saml-protocol.ts',
      'saml-contract.mjs',
      'saml-contract-smoke.mjs',
      ...(adminMode
        ? [
            'keycloak-admin-smoke.mjs',
            'identity-application-smoke.mjs',
            'identity-smtp-fixture.mjs',
            '../apps/runtime/src/identity/keycloak-admin.ts',
            '../apps/runtime/src/identity/operations.ts',
            '../apps/runtime/src/identity/processor.ts',
            '../apps/runtime/src/identity/routes.ts',
            '../apps/runtime/src/identity/config.ts',
            '../apps/runtime/src/server.ts',
            '../apps/runtime/src/routes/admin.ts',
            '../apps/web/src/AdminPage.tsx',
            '../apps/web/src/IdentityAdministrationPanel.tsx',
            '../apps/web/src/api.ts',
            '../packages/contracts/src/identity-admin.ts',
            '../packages/db/migrations/0034_identity_provisioning_operations.sql',
          ]
        : []),
      ...(applicationMode
        ? [
            'saml-application-smoke.mjs',
            '../apps/runtime/src/auth/saml-routes.ts',
            '../apps/runtime/src/auth/saml-state.ts',
            '../apps/runtime/src/auth/saml-config.ts',
            '../apps/runtime/src/auth/index.ts',
            '../apps/runtime/src/server.ts',
            '../apps/web/src/LoginPage.tsx',
            '../apps/web/src/api.ts',
          ]
        : []),
    ].map(async (name) => [
      name,
      createHash('sha256')
        .update(await readFile(new URL(name, import.meta.url)))
        .digest('hex'),
    ]),
  ),
);
const docker = async (args) =>
  (await exec('docker', args, { timeout: 45_000, maxBuffer: 1024 * 1024 })).stdout.trim();
const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
const close = (server) =>
  new Promise((resolve) => {
    if (!server) return resolve();
    server.closeAllConnections();
    server.close(resolve);
  });
const cookies = (request) =>
  new Map(
    (request.headers.cookie ?? '').split(';').map((part) => {
      const index = part.indexOf('=');
      return [part.slice(0, index).trim(), part.slice(index + 1)];
    }),
  );
const sessionCookie = '__Host-gcr_saml_session';
const txCookie = (tx) => `__Host-gcr_saml_tx_${tx.relayState}`;
const txSetCookie = (tx) =>
  `${txCookie(tx)}=${tx.nonce}; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=None`;
function redirect(response, location, setCookies = []) {
  response.writeHead(303, { location, 'set-cookie': setCookies, 'cache-control': 'no-store' });
  response.end();
}
async function body(request) {
  const parts = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_XML_BYTES * 2) throw new SamlContractError();
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString('utf8');
}
function safeFetch(url, { method = 'GET', data, headers = {}, cert } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        ca: cert,
        headers,
        lookup(_hostname, options, callback) {
          if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
          else callback(null, '127.0.0.1', 4);
        },
        timeout: 15_000,
      },
      (res) => {
        let size = 0;
        const parts = [];
        res.on('data', (part) => {
          size += part.length;
          if (size > 2 * 1024 * 1024) res.destroy(new Error('Bounded HTTP response exceeded'));
          else parts.push(part);
        });
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(parts).toString('utf8'),
          }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('HTTP timeout')));
    req.on('error', reject);
    req.end(data);
  });
}
try {
  const tls = await certificate(directory, 'contract-tls', ['gcr.sp.test', 'keycloak.idp.test']);
  const wrongTls = await certificate(directory, 'wrong-tls', ['gcr.sp.test']);
  const spKeys = await certificate(directory, 'sp-signing');
  const password = randomBytes(24).toString('base64url');
  const adminPassword = randomBytes(24).toString('base64url');
  const userPassword = randomBytes(24).toString('base64url');
  const tlsOptions = { key: tls.key, cert: tls.cert };
  spServer = https.createServer(tlsOptions, (request, response) => {
    if (applicationHandler) return applicationHandler(request, response);
    (async () => {
      const url = new URL(request.url, config.entityId);
      if (request.headers.host !== new URL(config.entityId).host) throw new SamlContractError();
      if (request.method === 'GET' && url.pathname === '/auth/saml/metadata') {
        response.writeHead(200, { 'content-type': 'application/samlmetadata+xml' });
        response.end(metadata(config));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/auth/saml/login') {
        const tx = transaction();
        transactions.set(tx.relayState, tx);
        redirect(response, await loginUrl(config, tx), [txSetCookie(tx)]);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/auth/saml/acs') {
        if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded'))
          throw new SamlContractError();
        const fields = new URLSearchParams(await body(request));
        if (
          Array.from(fields.keys()).length !== 2 ||
          ['SAMLResponse', 'RelayState'].some((key) => fields.getAll(key).length !== 1)
        )
          throw new SamlContractError();
        const tx = transactions.get(fields.get('RelayState'));
        if (!tx || cookies(request).get(txCookie(tx)) !== tx.nonce) throw new SamlContractError();
        const identity = await verifyLogin(config, fields.get('SAMLResponse'), tx);
        consume(ledger, tx, identity);
        const session = randomBytes(24).toString('base64url');
        sessions.set(session, identity);
        acsReceipts.push({
          identity,
          encoded: fields.get('SAMLResponse'),
          tx,
          transactionCookieReceived: true,
          sessionCookieReceived: cookies(request).has(sessionCookie),
          fetchSite: request.headers['sec-fetch-site'],
          method: request.method,
        });
        redirect(response, '/complete', [
          `${txCookie(tx)}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None`,
          `${sessionCookie}=${session}; Path=/; Max-Age=28800; Secure; HttpOnly; SameSite=Lax`,
        ]);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/complete') {
        response.writeHead(sessions.has(cookies(request).get(sessionCookie)) ? 200 : 401, {
          'content-type': 'text/html',
          'cache-control': 'no-store',
        });
        response.end(
          '<!doctype html><title>Contract login complete</title><p>Login complete</p><form method="post" action="/logout"><button>Log out</button></form>',
        );
        return;
      }
      if (request.method === 'POST' && url.pathname === '/logout') {
        if (request.headers.origin !== new URL(config.entityId).origin)
          throw new SamlContractError();
        const session = cookies(request).get(sessionCookie),
          identity = sessions.get(session);
        if (!identity) throw new SamlContractError();
        sessions.delete(session);
        const tx = transaction('logout');
        transactions.set(tx.relayState, tx);
        redirect(response, await logoutUrl(config, tx, identity), [
          txSetCookie(tx),
          `${sessionCookie}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
        ]);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/auth/saml/slo') {
        const tx = transactions.get(url.searchParams.get('RelayState'));
        if (!tx || cookies(request).get(txCookie(tx)) !== tx.nonce) throw new SamlContractError();
        const result = await verifyLogoutResponse(config, url.search.slice(1), tx);
        consume(ledger, tx, result);
        logoutReceipt = { result, tx, query: url.search.slice(1) };
        redirect(response, '/logged-out', [
          `${txCookie(tx)}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None`,
        ]);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/logged-out') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('Logged out');
        return;
      }
      response.writeHead(404);
      response.end();
    })().catch((error) => {
      // Never include the upstream XML, attributes, cookie, or error message.
      rejectedMessages.push({ route: request.url?.split('?')[0], errorType: error.name });
      response.writeHead(400, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      response.end('SAML message rejected');
    });
  });
  const spPort = await listen(spServer);
  idpServer = https.createServer(tlsOptions, (request, response) => {
    if (!upstreamPort) {
      response.writeHead(503);
      response.end();
      return;
    }
    const origin = new URL(config.idpIssuer);
    if (request.headers.host !== origin.host) {
      response.writeHead(400);
      response.end();
      return;
    }
    const proxy = http.request(
      {
        host: '127.0.0.1',
        port: upstreamPort,
        method: request.method,
        path: request.url,
        headers: {
          ...request.headers,
          host: origin.host,
          'x-forwarded-host': origin.host,
          'x-forwarded-proto': 'https',
          'x-forwarded-port': origin.port,
          'x-forwarded-for': '127.0.0.1',
        },
      },
      (res) => {
        response.writeHead(res.statusCode, res.headers);
        res.pipe(response);
      },
    );
    proxy.on('error', () => {
      response.writeHead(502);
      response.end();
    });
    request.pipe(proxy);
  });
  const idpPort = await listen(idpServer);
  const spOrigin = `https://gcr.sp.test:${spPort}`,
    idpOrigin = `https://keycloak.idp.test:${idpPort}`;
  const realm = 'gcr-contract';
  config = {
    acs: `${spOrigin}/auth/saml/acs`,
    slo: `${spOrigin}/auth/saml/slo`,
    entityId: `${spOrigin}/auth/saml/metadata`,
    idpIssuer: `${idpOrigin}/realms/${realm}`,
    entryPoint: `${idpOrigin}/realms/${realm}/protocol/saml`,
    privateKey: spKeys.key,
    publicCert: spKeys.cert,
    idpCerts: [spKeys.cert],
  };
  const requestIdp = (route, options = {}) =>
    safeFetch(`${idpOrigin}${route}`, { cert: tls.cert, ...options });
  stage = 'containers';
  await docker(['network', 'create', names.network]);
  networkOwned = true;
  await writeFile(
    path.join(directory, 'pg.env'),
    `POSTGRES_DB=identity_contract\nPOSTGRES_USER=idp_contract\nPOSTGRES_PASSWORD=${password}\n`,
    { mode: 0o600 },
  );
  await docker([
    'run',
    '-d',
    '--pull=never',
    '--name',
    names.postgres,
    '--network',
    names.network,
    '--network-alias',
    'postgres',
    '--tmpfs',
    '/var/lib/postgresql/data',
    '--memory',
    '512m',
    '--env-file',
    path.join(directory, 'pg.env'),
    PG_IMAGE,
  ]);
  ownedContainers.push(names.postgres);
  await writeFile(
    path.join(directory, 'kc.env'),
    `KC_DB=postgres\nKC_DB_URL=jdbc:postgresql://postgres:5432/identity_contract\nKC_DB_USERNAME=idp_contract\nKC_DB_PASSWORD=${password}\nKC_BOOTSTRAP_ADMIN_USERNAME=contract-admin\nKC_BOOTSTRAP_ADMIN_PASSWORD=${adminPassword}\nKC_HOSTNAME=${idpOrigin}\nKC_HTTP_ENABLED=true\nKC_PROXY_HEADERS=xforwarded\nKC_DB_POOL_INITIAL_SIZE=1\nKC_DB_POOL_MIN_SIZE=1\nKC_DB_POOL_MAX_SIZE=5\n`,
    { mode: 0o600 },
  );
  await docker([
    'run',
    '-d',
    '--pull=never',
    '--name',
    names.keycloak,
    '--network',
    names.network,
    '--memory',
    '2g',
    '--cpus',
    '2',
    '-p',
    '127.0.0.1::8080',
    '--env-file',
    path.join(directory, 'kc.env'),
    KC_IMAGE,
    'start',
    '--http-access-log-enabled=false',
  ]);
  ownedContainers.push(names.keycloak);
  upstreamPort = Number((await docker(['port', names.keycloak, '8080/tcp'])).split(':').at(-1));
  stage = 'keycloak-ready';
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      ready = (await requestIdp('/realms/master')).status === 200;
    } catch {
      /* startup */
    }
    if (ready) break;
    if (attempt % 20 === 0) console.log(JSON.stringify({ stage, waiting: true }));
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert(ready, 'Keycloak readiness timed out');
  const token = await requestIdp('/realms/master/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    data: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: 'contract-admin',
      password: adminPassword,
    }).toString(),
  });
  assert.equal(token.status, 200, 'Disposable admin login');
  const adminToken = JSON.parse(token.text).access_token;
  const admin = async (route, method = 'GET', data) => {
    const result = await requestIdp(`/admin/realms${route}`, {
      method,
      headers: {
        authorization: `Bearer ${adminToken}`,
        ...(data ? { 'content-type': 'application/json' } : {}),
      },
      ...(data ? { data: JSON.stringify(data) } : {}),
    });
    assert(
      result.status >= 200 && result.status < 300,
      `Admin request failed (${method}, ${result.status})`,
    );
    return result.text ? JSON.parse(result.text) : null;
  };
  stage = 'realm-configuration';
  await admin('', 'POST', {
    realm,
    enabled: true,
    sslRequired: 'all',
    registrationAllowed: false,
    ssoSessionMaxLifespan: 3600,
    ssoSessionIdleTimeout: 1800,
  });
  await admin(`/${realm}/clients`, 'POST', {
    clientId: config.entityId,
    protocol: 'saml',
    enabled: true,
    frontchannelLogout: true,
    redirectUris: [config.acs],
    attributes: {
      saml_name_id_format: 'persistent',
      saml_force_name_id_format: 'true',
      'saml.authnstatement': 'true',
      'saml.server.signature': 'true',
      'saml.assertion.signature': 'true',
      'saml.client.signature': 'true',
      'saml.signature.algorithm': 'RSA_SHA256',
      saml_signature_canonicalization_method: C14N,
      'saml.force.post.binding': 'false',
      'saml.server.signature.keyinfo.ext': 'false',
      'saml.assertion.lifespan': '240',
      'saml.signing.certificate': spKeys.cert.replace(/-----[^-]+-----|\s/g, ''),
      saml_assertion_consumer_url_post: config.acs,
      saml_single_logout_service_url_redirect: config.slo,
      'saml.allow.ecp.flow': 'false',
    },
  });
  await admin(`/${realm}/users`, 'POST', {
    username: 'contract-user',
    firstName: 'Contract',
    lastName: 'User',
    email: 'before@example.test',
    emailVerified: true,
    enabled: true,
    credentials: [{ type: 'password', value: userPassword, temporary: false }],
  });
  const [user] = await admin(`/${realm}/users?username=contract-user&exact=true`);
  const descriptor = await requestIdp(`/realms/${realm}/protocol/saml/descriptor`);
  assert.equal(descriptor.status, 200);
  config.idpCerts = parseIdpMetadata(descriptor.text, {
    issuer: config.idpIssuer,
    entryPoint: config.entryPoint,
  });
  evidence.idpMetadataSha256 = createHash('sha256').update(descriptor.text).digest('hex');
  evidence.checks.push('approved-https-idp-metadata');
  const spDescriptor = await safeFetch(config.entityId, { cert: tls.cert });
  assert.equal(spDescriptor.status, 200);
  const spMetadata = parseXml(spDescriptor.text);
  assert.equal(spMetadata.documentElement.getAttribute('entityID'), config.entityId);
  assert(
    spMetadata.getElementsByTagNameNS(NS.metadata, 'NameIDFormat')[0].textContent === PERSISTENT,
  );
  evidence.checks.push('sp-metadata-endpoints-persistent-nameid');
  const unsignedUrl = new URL(await loginUrl(config, transaction()));
  unsignedUrl.searchParams.delete('Signature');
  unsignedUrl.searchParams.delete('SigAlg');
  assert.equal((await safeFetch(unsignedUrl, { cert: tls.cert })).status, 400);
  const wrongAcsUrl = await loginUrl(
    { ...config, acs: `${spOrigin}/unregistered-acs` },
    transaction(),
  );
  assert.equal((await safeFetch(wrongAcsUrl, { cert: tls.cert })).status, 400);
  evidence.checks.push(
    'keycloak-rejects-unsigned-authnrequest',
    'keycloak-rejects-unregistered-acs',
  );
  await assert.rejects(safeFetch(config.entityId, { cert: wrongTls.cert }));
  evidence.checks.push('node-https-rejects-untrusted-certificate');
  stage = 'browser';
  const spki = createHash('sha256')
    .update(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      `--host-resolver-rules=MAP gcr.sp.test 127.0.0.1,MAP keycloak.idp.test 127.0.0.1`,
      `--ignore-certificate-errors-spki-list=${spki}`,
      '--no-proxy-server',
    ],
  });
  evidence.browser = {
    channel: 'chrome',
    version: browser.version(),
    headless: true,
    ignoreHTTPSErrors: false,
    tlsTrust: 'exact-generated-leaf-SPKI',
  };
  const context = await browser.newContext();
  const tlsProbePage = await context.newPage();
  const wrongTlsServer = https.createServer(
    { key: wrongTls.key, cert: wrongTls.cert },
    (_request, response) => {
      response.end('unexpected untrusted response');
    },
  );
  try {
    const wrongPort = await listen(wrongTlsServer);
    await assert.rejects(
      tlsProbePage.goto(`https://gcr.sp.test:${wrongPort}/`),
      /ERR_CERT_AUTHORITY_INVALID/,
    );
    evidence.checks.push('browser-rejects-unpinned-tls-certificate');
  } finally {
    await tlsProbePage.close();
    await close(wrongTlsServer);
  }
  page = await context.newPage();
  const login = async (username = 'contract-user', password = userPassword) => {
    const operation = stage;
    stage = `${operation}:navigate`;
    await page.goto(`${spOrigin}/auth/saml/login`);
    stage = `${operation}:username`;
    await page.locator('input[name="username"]').fill(username);
    stage = `${operation}:password`;
    await page.locator('input[name="password"]').fill(password);
    stage = `${operation}:submit`;
    await page.locator('button[type="submit"], input[type="submit"]').click();
    stage = `${operation}:callback`;
    await page.waitForURL(`${spOrigin}/complete`, { timeout: 30_000 });
    assert.equal(await page.locator('p').textContent(), 'Login complete');
  };
  const logout = async () => {
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await page.waitForURL(`${spOrigin}/logged-out`, { timeout: 30_000 });
    assert(logoutReceipt);
    assert.equal(
      (await context.cookies()).filter((cookie) => cookie.name === sessionCookie).length,
      0,
    );
  };
  stage = 'first-https-login';
  await login();
  const first = acsReceipts.at(-1);
  assert.equal(first.fetchSite, 'cross-site');
  assert.equal(first.method, 'POST');
  assert(first.transactionCookieReceived);
  assert(!first.sessionCookieReceived);
  assert.equal(first.identity.nameIDFormat, PERSISTENT);
  const sessionCookies = (await context.cookies()).filter(
    (cookie) => cookie.name === sessionCookie,
  );
  assert.equal(sessionCookies.length, 1);
  assert(
    sessionCookies[0].secure && sessionCookies[0].httpOnly && sessionCookies[0].sameSite === 'Lax',
  );
  evidence.checks.push(
    'signed-redirect-login-real-keycloak',
    'cross-site-https-post-transaction-cookie',
    'host-only-secure-httponly-lax-session',
  );
  stage = 'logout';
  await logout();
  evidence.checks.push('signed-redirect-slo-local-session-cleared');
  await admin(`/${realm}/users/${user.id}`, 'PUT', {
    ...user,
    email: 'after@example.test',
    firstName: 'Changed',
  });
  stage = 'email-change-login';
  await login();
  assert.equal(acsReceipts.at(-1).identity.nameID, first.identity.nameID);
  const [updated] = await admin(`/${realm}/users?username=contract-user&exact=true`);
  assert.equal(updated.id, user.id);
  assert.equal(updated.email, 'after@example.test');
  evidence.checks.push('persistent-nameid-after-email-and-display-name-change');
  await logout();
  stage = 'real-message-replay';
  const replay = await safeFetch(config.acs, {
    cert: tls.cert,
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `${txCookie(first.tx)}=${first.tx.nonce}`,
    },
    data: new URLSearchParams({
      SAMLResponse: first.encoded,
      RelayState: first.tx.relayState,
    }).toString(),
  });
  assert.equal(replay.status, 400);
  assert.equal(sessions.size, 0);
  await assert.rejects(verifyLogin(config, first.encoded, first.tx), SamlContractError);
  await assert.rejects(
    verifyLogoutResponse(config, logoutReceipt.query, logoutReceipt.tx),
    SamlContractError,
  );
  evidence.checks.push('real-login-and-logout-replay-rejected');
  evidence.checks.push(
    'replayed-https-acs-does-not-create-session',
    'slo-requires-credentials-on-next-login',
  );
  stage = 'key-rotation';
  const realmInfo = await admin(`/${realm}`);
  const previousCertificates = [...config.idpCerts];
  await admin(`/${realm}/components`, 'POST', {
    name: 'contract-next-signing-key',
    parentId: realmInfo.id,
    providerId: 'rsa-generated',
    providerType: 'org.keycloak.keys.KeyProvider',
    config: {
      priority: ['200'],
      enabled: ['true'],
      active: ['true'],
      algorithm: ['RS256'],
      keySize: ['2048'],
    },
  });
  const rotatedDescriptor = await requestIdp(`/realms/${realm}/protocol/saml/descriptor`);
  config.idpCerts = parseIdpMetadata(rotatedDescriptor.text, {
    issuer: config.idpIssuer,
    entryPoint: config.entryPoint,
  });
  assert(config.idpCerts.some((cert) => !previousCertificates.includes(cert)));
  await login();
  const rotatedReceipt = acsReceipts.at(-1);
  assert.equal(rotatedReceipt.identity.nameID, first.identity.nameID);
  // Fresh validation view proves trust, without accepting or minting a new session.
  await assert.rejects(
    verifyLogin({ ...config, idpCerts: previousCertificates }, rotatedReceipt.encoded, {
      ...rotatedReceipt.tx,
      consumed: false,
    }),
    SamlContractError,
  );
  evidence.checks.push('real-idp-signing-key-rotation-overlap', 'old-trust-rejects-new-idp-key');
  await logout();
  evidence.loginCount = acsReceipts.length;
  evidence.postgresVersion = await docker([
    'exec',
    names.postgres,
    'psql',
    '-U',
    'idp_contract',
    '-d',
    'identity_contract',
    '-Atc',
    'show server_version',
  ]);
  evidence.allCallbacksCrossSite = acsReceipts.every(
    (receipt) => receipt.fetchSite === 'cross-site',
  );
  evidence.nameIdStable = true;
  evidence.signingCertificateCount = config.idpCerts.length;
  evidence.rejectedRequests = rejectedMessages;
  if (adminMode) {
    stage = 'administration';
    const { runKeycloakAdminSmoke } = await import('./keycloak-admin-smoke.mjs');
    evidence.administration = await runKeycloakAdminSmoke({
      browser,
      wire(handler) {
        applicationHandler = handler;
      },
      config,
      directory,
      realm,
      admin,
      requestIdp,
      login,
      logout,
      receipts: acsReceipts,
      page,
      docker,
      network: names.network,
      ownContainer(name) {
        ownedContainers.push(name);
      },
      progress(value) {
        stage = `administration:${value}`;
        console.log(JSON.stringify({ stage }));
      },
    });
    evidence.limitations = [
      'compiled administration UI and actual HTTP API use real PostgreSQL and Keycloak; processor is invoked explicitly, worker scheduling is not exercised',
      'Chrome headless; native Safari and interactive browser operation remain pending',
      'test-specific generated TLS leaf SPKI pins; no system trust installation',
      'fixture administrator provisions the realm, service-account roles and synthetic test passwords only',
      'private disposable SMTP sink, reserved example.test recipients; no external mail delivery',
      'security freshness and application-wide revocation remain P03-C05',
    ];
  }
  if (applicationMode) {
    stage = 'application';
    const { runApplicationSmoke } = await import('./saml-application-smoke.mjs');
    evidence.application = await runApplicationSmoke({
      browser,
      config,
      directory,
      spKeys,
      metadataXml: rotatedDescriptor.text,
      identity: first.identity,
      keycloakUserId: user.id,
      userPassword,
      wire(handler) {
        applicationHandler = handler;
      },
      progress(value) {
        stage = `application:${value}`;
        console.log(JSON.stringify({ stage }));
      },
    });
    evidence.limitations = [
      'Chrome headless; native Safari and interactive browser operation remain pending',
      'test-specific generated TLS leaf SPKI pins; no system trust installation',
      'fixture-only explicit identity mapping and activation; production provisioning/freshness are P03-C04/C05',
      'separate disposable app and identity PostgreSQL; shared DB ACL/migration are P03-C06',
      'local app source plus compiled web assets; deployed image SAML activation is not claimed',
    ];
  }
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.failure = { stage, type: error.name };
  if (page) {
    try {
      const url = new URL(page.url());
      evidence.failure.browserPath = url.pathname;
      const title = await page.title();
      evidence.failure.pageCategory = title.startsWith('Sign in to ')
        ? 'keycloak-login'
        : title === 'Contract login complete'
          ? 'contract-success'
          : 'other';
      evidence.failure.transportError = error.message?.match(/\bnet::ERR_[A-Z_]+\b/)?.[0] ?? null;
      evidence.failure.inputs = await page
        .locator('input')
        .evaluateAll((nodes) => nodes.map((node) => ({ name: node.name, type: node.type })));
      evidence.failure.keycloakError = (
        await page
          .locator('#kc-error-message')
          .textContent({ timeout: 1000 })
          .catch(() => '')
      )
        .replace(/https?:\S+/g, '[URL]')
        .slice(0, 300);
    } catch {
      /* no live page */
    }
  }
  // Assertions and command output may contain sensitive synthetic inputs. Keep
  // diagnostics to the stage and type, never the complete exception/stack.
  evidence.rejectedRequests = rejectedMessages;
  console.error(JSON.stringify({ status: 'failed', stage, type: error.name }));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  await close(spServer);
  await close(idpServer);
  for (const name of ownedContainers.reverse()) {
    try {
      await docker(['rm', '-f', '-v', name]);
    } catch {
      evidence.cleanup.containersRemoved = false;
    }
  }
  const remaining = await docker([
    'ps',
    '-a',
    '--filter',
    `name=gcr-saml-`,
    '--format',
    '{{.Names}}',
  ]);
  evidence.cleanup.containersRemoved ??= !Object.values(names).some((name) =>
    remaining.split('\n').includes(name),
  );
  if (networkOwned) {
    try {
      await docker(['network', 'rm', names.network]);
      evidence.cleanup.networkRemoved = true;
    } catch {
      evidence.cleanup.networkRemoved = false;
    }
  }
  await rm(directory, { recursive: true, force: true });
  evidence.cleanup.temporaryFilesRemoved = true;
  evidence.finishedAt = new Date().toISOString();
  if (process.env.GCR_SAML_EVIDENCE) {
    await writeFile(process.env.GCR_SAML_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  }
  console.log(JSON.stringify(evidence, null, 2));
}
