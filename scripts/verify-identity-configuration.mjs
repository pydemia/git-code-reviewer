// Stateful Admin API fixture plus real HTTPS transport. No real Keycloak/DB or
// SMTP delivery is exercised; container integration remains a separate gate.
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  administrationClientId,
  configureIdentity,
  ownerAttribute,
  requiredEventTypes,
  validateConfiguration,
} from '../deploy/identity/configuration.mjs';
import { boundedFile, createAdminTransport } from '../deploy/identity/configure.mjs';
import { requiredSecurityEventTypes } from '../apps/runtime/dist/identity/keycloak-security.js';
import { prepareFreshIdentity } from './prepare-identity-compose.mjs';

const execFile = promisify(execFileCallback),
  root = fileURLToPath(new URL('../', import.meta.url));
const parent = await mkdtemp(path.join(tmpdir(), 'gcr-identity-config-')),
  directory = path.join(parent, 'material');
const evidence = {
  startedAt: new Date().toISOString(),
  node: process.version,
  checks: [],
  realKeycloak: false,
  smtpDeliveryTested: false,
  cleanup: false,
};
const check = (name) => evidence.checks.push(name),
  clone = (value) => structuredClone(value);
let server;
const sockets = new Set();

function fixture() {
  const state = {
    realm: null,
    clients: [],
    roles: ['manage-users', 'view-events'].map((name) => ({
      id: randomUUID(),
      name,
      clientRole: true,
      composite: false,
    })),
    profile: {
      attributes: [{ name: 'username' }, { name: 'email' }],
      groups: [],
      unmanagedAttributePolicy: 'DISABLED',
    },
    events: {
      eventsEnabled: false,
      enabledEventTypes: ['LOGIN_ERROR'],
      adminEventsDetailsEnabled: false,
    },
    assigned: [],
    scopes: [],
    inheritedRoles: [],
    inheritedScopes: [],
    groups: [],
    otherMappings: {},
    realmScopes: [],
    keys: [randomBytes(48).toString('hex')],
    users: [
      { id: randomUUID(), credential: randomBytes(32).toString('hex'), sessions: [randomUUID()] },
    ],
    writes: [],
    requests: [],
    dropClientResponse: false,
    ignoreProfileWrite: false,
    rotatedSecret: null,
  };
  const base = '/git-code-reviewer';
  const getClient = (clientId) => state.clients.find((client) => client.clientId === clientId);
  const admin = async (route, method = 'GET', body, allowMissing = false) => {
    state.requests.push({ route, method });
    if (method !== 'GET') state.writes.push({ route, method, body: clone(body) });
    if (route === '' && method === 'POST') {
      assert.equal(state.realm, null);
      assert.equal(body.enabled, false);
      state.realm = {
        ...clone(body),
        id: randomUUID(),
        smtpServer: {},
        unrelatedProperty: 'preserve',
      };
      state.clients.push({
        id: randomUUID(),
        clientId: 'realm-management',
        protocol: 'openid-connect',
      });
      return null;
    }
    if (route === base) {
      if (!state.realm) {
        assert.equal(allowMissing, true);
        return null;
      }
      if (method === 'PUT') {
        assert(
          !body.users &&
            !body.roles &&
            !body.clients &&
            !body.privateKey &&
            !body.publicKey &&
            !body.components,
        );
        state.realm = { ...state.realm, ...clone(body) };
        if (body.smtpServer?.password) state.realm.smtpServer.password = '**********';
        return null;
      }
      assert.equal(method, 'GET');
      return clone(state.realm);
    }
    if (route === base + '/users/profile') {
      if (method === 'PUT') {
        if (!state.ignoreProfileWrite) state.profile = clone(body);
        return null;
      }
      return clone(state.profile);
    }
    if (route === base + '/events/config') {
      if (method === 'PUT') {
        state.events = clone(body);
        return null;
      }
      return clone(state.events);
    }
    if (route.startsWith(base + '/clients?clientId=')) {
      assert.equal(method, 'GET');
      const client = getClient(
        new URL('https://fixture.invalid' + route).searchParams.get('clientId'),
      );
      return client ? [clone(client)] : [];
    }
    if (route === base + '/clients' && method === 'POST') {
      assert.equal(state.events.adminEventsDetailsEnabled, false);
      assert(!getClient(body.clientId));
      const client = { ...clone(body), id: randomUUID(), preservedClientAttribute: true };
      if (body.serviceAccountsEnabled)
        client.user = { id: randomUUID(), enabled: true, serviceAccountClientId: body.clientId };
      state.clients.push(client);
      if (state.dropClientResponse && body.clientId === administrationClientId) {
        state.dropClientResponse = false;
        throw Error('fixture response lost after commit');
      }
      return null;
    }
    const clientMatch = new RegExp(`^${base}/clients/([a-f0-9-]+)(.*)$`).exec(route);
    if (clientMatch) {
      const client = state.clients.find((item) => item.id === clientMatch[1]);
      assert(client);
      const tail = clientMatch[2];
      if (!tail) {
        if (method === 'PUT') {
          assert.equal(body.secret, undefined);
          Object.assign(client, clone(body));
          return null;
        }
        const representation = clone(client);
        if (representation.authorizationServicesEnabled === false)
          delete representation.authorizationServicesEnabled;
        for (const [key, value] of Object.entries(representation.attributes ?? {}))
          if (value === '') delete representation.attributes[key];
        return representation;
      }
      if (tail === '/client-secret') {
        assert.equal(method, 'GET');
        return { type: 'secret', value: client.secret };
      }
      if (tail === '/client-secret/rotated') {
        assert.equal(method, 'GET');
        assert.equal(allowMissing, true);
        return state.rotatedSecret;
      }
      if (tail.startsWith('/roles/'))
        return clone(state.roles.find((role) => role.name === tail.slice(7)));
      if (tail === '/service-account-user') {
        assert(client.user);
        return clone(client.user);
      }
      if (tail === '/scope-mappings')
        return {
          realmMappings: clone(state.realmScopes),
          clientMappings: clone(state.otherMappings),
        };
      if (tail === '/scope-mappings/realm') return clone(state.realmScopes);
      if (tail.startsWith('/scope-mappings/clients/')) {
        if (method === 'POST') {
          state.scopes.push(...clone(body));
          return null;
        }
        return clone([
          ...state.scopes,
          ...(tail.endsWith('/composite') ? state.inheritedScopes : []),
        ]);
      }
    }
    const user = getClient(administrationClientId)?.user;
    if (user && route.startsWith(`${base}/users/${user.id}/`)) {
      const tail = route.slice(`${base}/users/${user.id}`.length);
      if (tail === '/groups?max=1000') return clone(state.groups);
      if (tail === '/role-mappings')
        return {
          realmMappings: [{ name: 'default-roles-git-code-reviewer' }],
          clientMappings: clone(state.otherMappings),
        };
      if (tail.startsWith('/role-mappings/clients/')) {
        if (method === 'POST') {
          state.assigned.push(...clone(body));
          return null;
        }
        return clone([
          ...state.assigned,
          ...(tail.endsWith('/composite') ? state.inheritedRoles : []),
        ]);
      }
    }
    throw Error(`Unexpected fixture route: ${method} ${route}`);
  };
  return { state, admin, getClient };
}

try {
  await prepareFreshIdentity(directory, {
    GCR_RUNTIME_IMAGE: `example.invalid/gcr@sha256:${'a'.repeat(64)}`,
    GCR_IDENTITY_IMAGE: `example.invalid/identity@sha256:${'b'.repeat(64)}`,
    GCR_POSTGRES_IMAGE: `postgres@sha256:${'c'.repeat(64)}`,
  });
  const spCertificate = await readFile(path.join(directory, 'sp-signing-cert'), 'utf8');
  const clientSecret = await readFile(path.join(directory, 'identity-admin-client-secret'), 'utf8');
  const plan = {
    version: 1,
    configurationId: randomUUID(),
    realm: 'git-code-reviewer',
    publicOrigin: 'https://gcr.test:8443',
    identityOrigin: 'https://identity.test:8443',
    adminOrigin: 'https://keycloak:8443',
  };
  const configure = (instance, mode = 'apply', input = plan, extra = {}) =>
    configureIdentity(input, {
      mode,
      admin: instance.admin,
      spCertificate,
      clientSecret,
      ...extra,
    });
  assert.deepEqual([...requiredEventTypes], [...requiredSecurityEventTypes]);
  check('event-configuration-matches-compiled-security-collector-contract');
  const first = fixture();
  const missing = await configure(first, 'inspect');
  assert.equal(missing.converged, false);
  assert.equal(first.state.writes.length, 0);
  assert.equal(first.state.realm, null);
  check('inspection-of-missing-realm-performs-no-configuration-write');
  const identityBefore = clone({ users: first.state.users, keys: first.state.keys });
  const created = await configure(first);
  assert.equal(created.converged, true);
  assert.equal(first.state.realm.enabled, true);
  assert.equal(first.state.writes.at(-1).body.enabled, true);
  assert.deepEqual(
    first.state.assigned.map((role) => role.name),
    ['manage-users', 'view-events'],
  );
  assert.deepEqual(
    first.state.scopes.map((role) => role.name),
    ['manage-users', 'view-events'],
  );
  assert.equal(first.state.profile.unmanagedAttributePolicy, 'ADMIN_EDIT');
  assert(first.state.events.enabledEventTypes.includes('LOGIN_ERROR'));
  assert.equal(first.getClient(administrationClientId).fullScopeAllowed, false);
  const saml = first.getClient(plan.publicOrigin + '/auth/saml/metadata');
  assert.equal(saml.attributes['saml.client.signature'], 'true');
  assert.equal(saml.attributes['saml.assertion.signature'], 'true');
  assert.equal(saml.attributes.saml_name_id_format, 'persistent');
  assert.deepEqual(saml.redirectUris, [plan.publicOrigin + '/auth/saml/acs']);
  check('fresh-owned-realm-configured-and-enabled-only-after-staged-readback');
  const beforeRepeat = clone(first.state),
    writesBefore = first.state.writes.length;
  const repeated = await configure(first);
  assert.deepEqual(repeated.actions, []);
  assert.equal(first.state.writes.length, writesBefore);
  assert.deepEqual({ users: first.state.users, keys: first.state.keys }, identityBefore);
  assert.equal(first.state.realm.id, beforeRepeat.realm.id);
  assert.equal(first.getClient(administrationClientId).secret, clientSecret);
  assert.equal(
    first.getClient(administrationClientId).id,
    beforeRepeat.clients.find((client) => client.clientId === administrationClientId).id,
  );
  check('repeated-apply-has-zero-writes-and-preserves-users-keys-client-ID-and-secret');
  first.state.profile.groups.push({ name: 'custom-profile-group' });
  first.state.realm.attributes['operator.note'] = 'preserve';
  saml.attributes['operator.note'] = 'preserve';
  saml.attributes['saml.client.signature'] = 'false';
  const corrected = await configure(first);
  assert.deepEqual(corrected.actions, ['saml-client.configure']);
  assert.equal(saml.attributes['operator.note'], 'preserve');
  assert.equal(first.state.realm.attributes['operator.note'], 'preserve');
  assert.equal(first.state.profile.groups[0].name, 'custom-profile-group');
  check('narrow-security-drift-correction-preserves-unrelated-owned-configuration');
  for (const [name, change, code] of [
    [
      'unowned-realm',
      (s) => {
        s.state.realm.attributes[ownerAttribute] = randomUUID();
      },
      'REALM_OWNERSHIP_CONFLICT',
    ],
    [
      'unowned-client',
      (s) => {
        s.getClient(administrationClientId).attributes[ownerAttribute] = randomUUID();
      },
      'CLIENT_OWNERSHIP_CONFLICT',
    ],
    [
      'changed-secret',
      (s) => {
        s.getClient(administrationClientId).secret = randomBytes(32).toString('hex');
      },
      'ADMIN_CLIENT_SECRET_MISMATCH',
    ],
    [
      'rotated-secret',
      (s) => {
        s.state.rotatedSecret = { value: randomBytes(32).toString('hex') };
      },
      'CLIENT_SECRET_ROTATION_IN_PROGRESS',
    ],
    [
      'disabled-realm',
      (s) => {
        s.state.realm.enabled = false;
      },
      'EXISTING_REALM_DISABLED',
    ],
    [
      'disabled-client',
      (s) => {
        s.getClient(administrationClientId).enabled = false;
      },
      'EXISTING_CLIENT_DISABLED',
    ],
    [
      'editable-identity-attribute',
      (s) => {
        s.state.profile.attributes.push({
          name: 'gcr.identity.user-id',
          permissions: { view: ['user'], edit: ['user'] },
        });
      },
      'USER_EDITABLE_IDENTITY_ATTRIBUTE',
    ],
    [
      'excessive-inherited-role',
      (s) => {
        s.state.inheritedRoles.push({ id: randomUUID(), name: 'realm-admin', composite: true });
      },
      'EXCESSIVE_MANAGEMENT_ROLES',
    ],
    [
      'excessive-scope',
      (s) => {
        s.state.scopes.push({ id: randomUUID(), name: 'manage-realm', composite: false });
      },
      'EXCESSIVE_MANAGEMENT_ROLES',
    ],
    [
      'unexpected-group',
      (s) => {
        s.state.groups.push({ id: randomUUID() });
      },
      'UNEXPECTED_SERVICE_ACCOUNT_GROUP',
    ],
    [
      'other-client-mapping',
      (s) => {
        s.state.otherMappings.other = { id: randomUUID(), client: 'other' };
      },
      'UNEXPECTED_SERVICE_ACCOUNT_MAPPINGS',
    ],
    [
      'custom-token-mapper',
      (s) => {
        s.getClient(administrationClientId).protocolMappers = [{ name: 'unexpected' }];
      },
      'UNEXPECTED_CLIENT_PROTOCOL_MAPPER',
    ],
  ]) {
    const candidate = fixture();
    Object.assign(candidate.state, clone(beforeRepeat));
    change(candidate);
    candidate.state.writes = [];
    await assert.rejects(() => configure(candidate), { message: code }, name);
    assert.equal(candidate.state.writes.length, 0, name);
  }
  check('twelve-ownership-credential-profile-and-permission-conflicts-refused-before-writes');
  const lost = fixture();
  lost.state.dropClientResponse = true;
  await assert.rejects(() => configure(lost));
  assert.equal(lost.state.realm.enabled, false);
  const incompleteClient = lost.getClient(administrationClientId).id;
  await configure(lost);
  assert.equal(lost.getClient(administrationClientId).id, incompleteClient);
  assert.equal(
    lost.state.clients.filter((client) => client.clientId === administrationClientId).length,
    1,
  );
  check('lost-client-create-response-resumes-with-same-client-secret-and-no-duplicate');
  const ignored = fixture();
  ignored.state.ignoreProfileWrite = true;
  await assert.rejects(() => configure(ignored), {
    message: 'STAGED_CONFIGURATION_READBACK_FAILED',
  });
  assert.equal(ignored.state.realm.enabled, false);
  ignored.state.ignoreProfileWrite = false;
  await configure(ignored);
  assert.equal(ignored.state.realm.enabled, true);
  check('incomplete-readback-keeps-new-realm-disabled-and-can-resume');
  const smtpPlan = {
    ...plan,
    smtp: {
      host: 'smtp.example.test',
      port: 587,
      from: 'identity@example.test',
      tls: 'starttls',
      username: 'smtp-user',
      revision: 'r1',
    },
  };
  const smtpPassword = randomBytes(32).toString('hex');
  const smtp = fixture();
  await configure(smtp);
  const preSmtp = smtp.state.writes.length;
  assert.equal((await configure(smtp, 'inspect', smtpPlan)).smtp, 'pending');
  assert.equal(smtp.state.writes.length, preSmtp);
  await assert.rejects(() => configure(smtp, 'apply', smtpPlan), {
    message: 'SMTP_PASSWORD_REQUIRED',
  });
  assert.equal(smtp.state.writes.length, preSmtp);
  await configure(smtp, 'apply', smtpPlan, { smtpPassword });
  const smtpWrites = smtp.state.writes.length;
  await configure(smtp, 'apply', smtpPlan);
  assert.equal(smtp.state.writes.length, smtpWrites);
  assert.equal(smtp.state.realm.smtpServer.starttls, 'true');
  await assert.rejects(
    () =>
      configure(smtp, 'apply', {
        ...smtpPlan,
        smtp: { ...smtpPlan.smtp, host: 'changed.example.test' },
      }),
    { message: 'SMTP_REVISION_CONFIGURATION_CONFLICT' },
  );
  assert(!JSON.stringify(await configure(smtp, 'inspect', smtpPlan)).includes(smtpPassword));
  check('SMTP-password-is-file-input-and-explicit-revision-prevents-repeated-secret-write');
  for (const input of [
    { ...plan, realm: 'master' },
    { ...plan, publicOrigin: 'http://gcr.test' },
    { ...plan, adminOrigin: plan.identityOrigin },
    { ...plan, unknown: true },
    { ...plan, configurationId: 'not-an-owner' },
    { ...smtpPlan, smtp: { ...smtpPlan.smtp, password: 'forbidden' } },
    { ...smtpPlan, smtp: { ...smtpPlan.smtp, tls: 'none' } },
  ])
    assert.throws(() => validateConfiguration(input));
  check('plan-rejects-master-public-admin-HTTP-unowned-fields-and-inline-SMTP-password');
  const secretFile = path.join(directory, 'identity-admin-client-secret');
  assert.equal(await boundedFile(secretFile, { privateFile: true }), clientSecret);
  await symlink(secretFile, path.join(parent, 'link'));
  await assert.rejects(() => boundedFile(path.join(parent, 'link'), { privateFile: true }));
  await writeFile(path.join(parent, 'public-secret'), clientSecret, { mode: 0o644 });
  await chmod(path.join(parent, 'public-secret'), 0o644);
  await assert.rejects(() =>
    boundedFile(path.join(parent, 'public-secret'), { privateFile: true }),
  );
  await assert.rejects(() => boundedFile(secretFile, { maximum: 10 }));
  check('secret-reader-rejects-symlink-world-access-and-oversized-file');
  // TLS transport is exercised separately from the in-memory reconciliation model.
  await execFile(
    'openssl',
    [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'admin.key',
      '-out',
      'admin.csr',
      '-subj',
      '/CN=127.0.0.1',
    ],
    { cwd: directory },
  );
  await writeFile(
    path.join(directory, 'admin.ext'),
    'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n',
  );
  await execFile(
    'openssl',
    [
      'x509',
      '-req',
      '-in',
      'admin.csr',
      '-CA',
      'ca.crt',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      'admin.crt',
      '-days',
      '1',
      '-sha256',
      '-extfile',
      'admin.ext',
    ],
    { cwd: directory },
  );
  const accessToken = randomBytes(48).toString('base64url'),
    refreshToken = randomBytes(48).toString('base64url');
  const requests = [];
  const cliFixture = fixture();
  let responseMode = 'normal';
  server = https.createServer(
    {
      key: await readFile(path.join(directory, 'admin.key')),
      cert: await readFile(path.join(directory, 'admin.crt')),
    },
    async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString(),
      });
      if (request.url.endsWith('/token')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: 60,
          }),
        );
        return;
      }
      if (request.url.endsWith('/logout')) {
        response.writeHead(204);
        response.end();
        return;
      }
      if (responseMode === 'full') {
        const route = request.url.slice('/admin/realms'.length);
        if (
          (route === '/git-code-reviewer' && !cliFixture.state.realm && request.method === 'GET') ||
          route.endsWith('/client-secret/rotated')
        ) {
          response.writeHead(404);
          response.end();
          return;
        }
        try {
          const bytes = Buffer.concat(chunks).toString();
          const result = await cliFixture.admin(
            route,
            request.method,
            bytes ? JSON.parse(bytes) : undefined,
          );
          response.writeHead(result === null ? 204 : 200, { 'content-type': 'application/json' });
          response.end(result === null ? undefined : JSON.stringify(result));
        } catch {
          response.writeHead(500);
          response.end();
        }
        return;
      }
      if (responseMode === 'redirect') {
        response.writeHead(307, { location: 'https://unapproved.example.test/' });
        response.end();
        return;
      }
      if (responseMode === 'timeout') return;
      if (responseMode === 'too-large') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('x'.repeat(600 * 1024));
        return;
      }
      if (responseMode === 'forbidden') {
        response.writeHead(403);
        response.end(clientSecret);
        return;
      }
      if (responseMode === 'missing') {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ realm: plan.realm }));
    },
  );
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const tlsPlan = { ...plan, adminOrigin: `https://127.0.0.1:${server.address().port}` },
    ca = await readFile(path.join(directory, 'ca.crt'));
  const transport = createAdminTransport(tlsPlan, {
    ca,
    username: 'bootstrap-fixture',
    password: clientSecret,
  });
  assert.equal((await transport('/git-code-reviewer')).realm, plan.realm);
  assert.equal((await transport('/git-code-reviewer')).realm, plan.realm);
  assert.equal(requests.filter((item) => item.url.endsWith('/token')).length, 1);
  assert.equal(
    requests.filter((item) => item.url.includes('/admin/'))[0].authorization,
    `Bearer ${accessToken}`,
  );
  await transport.close();
  assert.equal(requests.filter((item) => item.url.endsWith('/logout')).length, 1);
  assert.equal(new URLSearchParams(requests.at(-1).body).get('refresh_token'), refreshToken);
  await assert.rejects(() => transport('/git-code-reviewer'), {
    message: 'CONFIGURATION_TRANSPORT_CLOSED',
  });
  check('real-HTTPS-bootstrap-token-cache-and-owned-session-logout');
  const tokenTransport = createAdminTransport(tlsPlan, { ca, accessToken, timeoutMs: 100 });
  for (const [variant, code] of [
    ['redirect', 'ADMIN_REQUEST_FAILED'],
    ['forbidden', 'ADMIN_PERMISSION_DENIED'],
    ['timeout', 'ADMIN_REQUEST_TIMEOUT'],
  ]) {
    responseMode = variant;
    const before = requests.length;
    await assert.rejects(() => tokenTransport('/git-code-reviewer', 'PUT', { enabled: true }), {
      message: code,
    });
    assert.equal(requests.length, before + 1);
  }
  responseMode = 'too-large';
  await assert.rejects(() => tokenTransport('/git-code-reviewer'), /ADMIN_RESPONSE/);
  responseMode = 'missing';
  assert.equal(await tokenTransport('/git-code-reviewer', 'GET', undefined, true), null);
  await assert.rejects(() => tokenTransport('/master'), { message: 'INVALID_ADMIN_ROUTE' });
  await assert.rejects(() => tokenTransport('/git-code-reviewer/../master'), {
    message: 'INVALID_ADMIN_ROUTE',
  });
  await assert.rejects(() => tokenTransport('/git-code-reviewer', 'DELETE'), {
    message: 'INVALID_ADMIN_ROUTE',
  });
  const loggedOutBefore = requests.filter((item) => item.url.endsWith('/logout')).length;
  await tokenTransport.close();
  assert.equal(requests.filter((item) => item.url.endsWith('/logout')).length, loggedOutBefore);
  check('redirect-denied-error-body-redacted-timeout-not-retried-and-bounded-response');
  const untrusted = createAdminTransport(tlsPlan, { ca: spCertificate, accessToken });
  await assert.rejects(() => untrusted('/git-code-reviewer'), {
    message: 'ADMIN_CONNECTION_FAILED',
  });
  await untrusted.close();
  check('untrusted-admin-TLS-certificate-rejected');
  responseMode = 'full';
  const cliPlanPath = path.join(directory, 'cli-plan.json'),
    cliTokenPath = path.join(directory, 'cli-token');
  await writeFile(cliPlanPath, JSON.stringify(tlsPlan));
  await writeFile(cliTokenPath, accessToken, { mode: 0o600 });
  const cliEnv = {
    PATH: process.env.PATH,
    GCR_IDENTITY_CONFIG_CA_FILE: path.join(directory, 'ca.crt'),
    GCR_IDENTITY_CONFIG_SP_CERT_FILE: path.join(directory, 'sp-signing-cert'),
    GCR_IDENTITY_CONFIG_CLIENT_SECRET_FILE: secretFile,
    GCR_IDENTITY_CONFIG_TOKEN_FILE: cliTokenPath,
    GCR_IDENTITY_CONFIG_PUBLIC_ORIGIN: tlsPlan.publicOrigin,
    GCR_IDENTITY_CONFIG_IDENTITY_ORIGIN: tlsPlan.identityOrigin,
    GCR_IDENTITY_CONFIG_ADMIN_ORIGIN: tlsPlan.adminOrigin,
  };
  for (const mode of ['--inspect', '--apply', '--apply']) {
    const result = await execFile(
      process.execPath,
      ['deploy/identity/configure.mjs', mode, cliPlanPath],
      { cwd: root, env: cliEnv, timeout: 30_000 },
    );
    assert(!result.stdout.includes(clientSecret) && !result.stdout.includes(accessToken));
    const report = JSON.parse(result.stdout);
    assert.equal(report.converged, mode === '--apply');
  }
  const cliRepeatWrites = cliFixture.state.writes.length;
  const cliInspection = await execFile(
    process.execPath,
    ['deploy/identity/configure.mjs', '--inspect', cliPlanPath],
    { cwd: root, env: cliEnv, timeout: 30_000 },
  );
  assert.equal(JSON.parse(cliInspection.stdout).converged, true);
  assert.equal(cliFixture.state.writes.length, cliRepeatWrites);
  check('actual-CLI-file-inputs-inspect-apply-repeat-and-HTTPS-readback');
  for (const entry of first.state.writes) {
    assert.notEqual(entry.method, 'DELETE');
    assert(
      !/\/credentials|\/reset-password|\/components|\/keys|\/partialImport|\/client-secret/.test(
        entry.route,
      ),
    );
    if (entry.route.includes('/users/'))
      assert(entry.route.endsWith('/profile') || entry.route.includes('/role-mappings/clients/'));
  }
  check('write-trace-excludes-user-credentials-key-generation-import-and-secret-rotation');
  evidence.sourceSha256 = Object.fromEntries(
    await Promise.all(
      [
        'deploy/identity/configuration.mjs',
        'deploy/identity/configure.mjs',
        'scripts/verify-identity-configuration.mjs',
      ].map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(path.join(root, file)))
          .digest('hex'),
      ]),
    ),
  );
  evidence.success = true;
} catch (error) {
  evidence.success = false;
  evidence.failure = error.message;
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(parent, { recursive: true, force: true });
  evidence.cleanup = true;
  evidence.completedAt = new Date().toISOString();
  if (process.env.GCR_IDENTITY_CONFIGURATION_EVIDENCE)
    await writeFile(
      process.env.GCR_IDENTITY_CONFIGURATION_EVIDENCE,
      JSON.stringify(evidence, null, 2) + '\n',
      { flag: 'wx' },
    );
  console.log(JSON.stringify(evidence, null, 2));
}
