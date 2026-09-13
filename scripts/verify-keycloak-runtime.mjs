// Real optimized Keycloak replicas on an owned TLS PostgreSQL fixture.
// Build deploy/identity/Dockerfile and @gcr/db first. No cluster or account access.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  createDatabase,
  provisionSharedPostgres,
  runMigrations,
} from '../packages/db/dist/index.js';

const exec = promisify(execFile);
const identifier = randomUUID();
const prefix = `gcr-idp-${identifier}`;
const label = `gcr.fixture.id=${identifier}`;
const directory = await mkdtemp(path.join(tmpdir(), 'gcr-idp-runtime-'));
const image = process.env.GCR_IDENTITY_IMAGE || 'gcr-identity:26.7.3-gcr.1-local';
const postgresImage =
  'postgres@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2';
const report = {
  startedAt: new Date().toISOString(),
  node: process.version,
  image,
  postgresImage,
  checks: [],
  requestTimeoutsMs: { health: 5000, fixtureAdministration: 30000 },
  startupTimeoutMs: 600_000,
  replicaMemoryBytes: 2 * 1024 ** 3,
  replicaCpuLimit: 2,
  replicas: [],
  clusterAccess: false,
  realModelCalls: 0,
};
const passwords = Object.fromEntries(
  ['postgres', 'gcr_app', 'gcr_migrator', 'gcr_keycloak', 'bootstrap', 'user'].map((role) => [
    role,
    randomBytes(24).toString('hex'),
  ]),
);
// Exercise literal dollar/property-expression characters, not just easy hex secrets.
passwords.gcr_keycloak += '${gcr_fixture_missing}$';
const secrets = new Set(Object.values(passwords));
const redact = (value) => {
  let text = String(value);
  for (const secret of secrets) text = text.replaceAll(secret, '[redacted]');
  return text.replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[database URL redacted]');
};
const hash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest('hex');
const docker = async (args, options = {}) =>
  (
    await exec('docker', args, { timeout: 90_000, maxBuffer: 4 * 1024 * 1024, ...options })
  ).stdout.trim();
const progress = (step) => {
  report.lastStep = step;
  process.stderr.write(`${new Date().toISOString()} ${step}\n`);
};
const check = (name) => report.checks.push(name);
const file = async (name, contents, mode = 0o600) => {
  const target = path.join(directory, name);
  await writeFile(target, contents, { mode });
  return target;
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 500));
const request = (origin, endpoint, options = {}) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const target = new URL(`${origin}${endpoint}`);
    const invoke = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const call = invoke(
      target,
      {
        ca,
        rejectUnauthorized: true,
        method: options.method,
        headers: options.headers,
        signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('error', reject);
        response.on('end', () => {
          if (options.timeoutMs === 30_000)
            report.slowestAdministrationRequestMs = Math.max(
              report.slowestAdministrationRequestMs ?? 0,
              Date.now() - started,
            );
          resolve({ status: response.statusCode, body });
        });
      },
    );
    call.on('error', (error) =>
      reject(
        new Error(
          `Fixture ${options.method ?? 'GET'} ${endpoint} failed: ${error.code ?? error.name}`,
        ),
      ),
    );
    call.end(options.body);
  });
let admin,
  ca,
  port,
  networkCreated = false;
const pgName = `${prefix}-postgres`;
const url = (role, database) => {
  const target = new URL(`postgresql://127.0.0.1:${port}/${database}`);
  target.username = role;
  target.password = passwords[role];
  return target.toString();
};
const withDatabase = async (role, database, operation) => {
  const pool = createDatabase(url(role, database), role === 'gcr_app' ? 2 : 1, { tlsCa: ca });
  try {
    return await operation(pool);
  } finally {
    await pool.end();
  }
};
const appSnapshot = () =>
  withDatabase('gcr_app', 'git_code_reviewer', async (pool) => ({
    users: (await pool.query('select id, oidc_subject, display_name from users order by id')).rows,
    ledger: (await pool.query('select * from schema_migrations order by version')).rows,
  }));
let plan;
const provision = () =>
  provisionSharedPostgres({
    admin: {
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password: passwords.postgres,
      database: 'postgres',
      ssl: { ca, rejectUnauthorized: true },
    },
    plan,
    passwords: {
      gcr_app: passwords.gcr_app,
      gcr_migrator: passwords.gcr_migrator,
      gcr_keycloak: passwords.gcr_keycloak,
    },
  });
async function start(name, overrides = {}) {
  const environment = {
    KC_DB_URL_HOST: 'postgres',
    KC_DB_URL_PORT: '5432',
    KC_DB_URL_DATABASE: 'git_code_reviewer_keycloak',
    KC_DB_USERNAME: 'gcr_keycloak',
    KCRAW_DB_PASSWORD: passwords.gcr_keycloak,
    KC_DB_TLS_MODE: 'verify-server',
    KC_DB_TLS_TRUST_STORE_FILE: '/run/gcr/ca.crt',
    KC_DB_POOL_INITIAL_SIZE: '1',
    KC_DB_POOL_MIN_SIZE: '1',
    KC_DB_POOL_MAX_SIZE: '10',
    KC_HOSTNAME: 'https://identity.example.test',
    KC_HTTP_ENABLED: 'false',
    KC_HTTPS_CERTIFICATE_FILE: '/run/gcr/server.crt',
    KC_HTTPS_CERTIFICATE_KEY_FILE: '/run/gcr/server.key',
    KC_HTTP_MANAGEMENT_SCHEME: 'http',
    KC_CACHE_STACK: 'jdbc-ping',
    KC_CACHE_EMBEDDED_MTLS_ENABLED: 'true',
    KC_SERVER_ASYNC_BOOTSTRAP: 'false',
    KC_HTTP_ACCESS_LOG_ENABLED: 'false',
    KC_BOOTSTRAP_ADMIN_USERNAME: 'fixture-admin',
    KC_BOOTSTRAP_ADMIN_PASSWORD: passwords.bootstrap,
    ...overrides,
  };
  const envFile = await file(
    `${name}.env`,
    Object.entries(environment)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  );
  const id = await docker([
    'run',
    '-d',
    '--pull=never',
    '--name',
    name,
    '--label',
    label,
    '--network',
    prefix,
    '--user',
    '1000:1000',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--memory',
    '2g',
    '--cpus',
    '2',
    '--tmpfs',
    '/tmp:uid=1000,gid=1000,mode=1770',
    '--tmpfs',
    '/opt/keycloak/data:uid=1000,gid=1000,mode=770',
    '--env-file',
    envFile,
    '--mount',
    `type=bind,source=${path.join(directory, 'ca.crt')},target=/run/gcr/ca.crt,readonly`,
    '--mount',
    `type=bind,source=${path.join(directory, 'other-ca.crt')},target=/run/gcr/other-ca.crt,readonly`,
    '--mount',
    `type=bind,source=${path.join(directory, 'server.crt')},target=/run/gcr/server.crt,readonly`,
    '--mount',
    `type=bind,source=${path.join(directory, 'server.key')},target=/run/gcr/server.key,readonly`,
    '-p',
    '127.0.0.1::8443',
    '-p',
    '127.0.0.1::9000',
    image,
  ]);
  const published = JSON.parse(
    await docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name]),
  );
  return {
    name,
    id,
    startedAt: Date.now(),
    origin: `https://127.0.0.1:${published['8443/tcp'][0].HostPort}`,
    health: `http://127.0.0.1:${published['9000/tcp'][0].HostPort}`,
  };
}
async function ready(instance) {
  const deadline = Date.now() + report.startupTimeoutMs;
  while (Date.now() < deadline) {
    const response = await request(instance.health, '/health/ready').catch(() => undefined);
    if (response?.status === 200) {
      const state = JSON.parse(response.body);
      assert.equal(state.status, 'UP');
      assert(state.checks.some((entry) => /database/i.test(entry.name) && entry.status === 'UP'));
      if (!report.replicas.some((entry) => entry.id === instance.id)) {
        report.replicas.push({ id: instance.id, startupMs: Date.now() - instance.startedAt });
        progress(`Replica ready: ${instance.name}`);
      }
      return state;
    }
    const running = await docker(['inspect', '--format', '{{.State.Running}}', instance.name]);
    assert.equal(running, 'true', `Keycloak stopped before readiness: ${instance.name}`);
    await pause();
  }
  throw Error('Keycloak did not become ready within the fixture startup boundary');
}
async function stop(instance) {
  await docker(['stop', '--time', '30', instance.name]);
  const logs = await docker(['logs', instance.name]);
  assert(
    /Keycloak stopped in/.test(logs),
    'Keycloak must receive SIGTERM and shut down gracefully',
  );
  await docker(['rm', '-v', instance.name]);
}
const realm = 'git-code-reviewer';
async function management(instance, endpoint, method = 'GET', value) {
  const auth = await request(instance.origin, '/realms/master/protocol/openid-connect/token', {
    timeoutMs: 30_000,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: 'fixture-admin',
      password: passwords.bootstrap,
    }).toString(),
  });
  assert.equal(auth.status, 200, 'Fixture bootstrap administrator authentication');
  const token = JSON.parse(auth.body).access_token;
  secrets.add(token);
  const response = await request(instance.origin, `/admin/realms${endpoint}`, {
    timeoutMs: 30_000,
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  assert(
    response.status >= 200 && response.status < 300,
    `Realm API ${method} ${endpoint}: ${response.status}`,
  );
  return response.body ? JSON.parse(response.body) : undefined;
}
async function identitySnapshot(instance) {
  const users = await management(instance, `/${realm}/users?username=fixture-user&exact=true`);
  assert.equal(users.length, 1);
  const keys = await management(instance, `/${realm}/keys`);
  return {
    user: users[0],
    activeKeys: keys.active,
    keys: keys.keys
      .map(({ kid, publicKey, certificate, status, algorithm }) => ({
        kid,
        publicKey,
        certificate,
        status,
        algorithm,
      }))
      .sort((a, b) => a.kid.localeCompare(b.kid)),
  };
}
async function verifyPassword(instance) {
  const response = await request(
    instance.origin,
    `/realms/${realm}/protocol/openid-connect/token`,
    {
      timeoutMs: 30_000,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'fixture-password-check',
        username: 'fixture-user',
        password: passwords.user,
      }).toString(),
    },
  );
  assert.equal(response.status, 200, 'Fixture user credential must survive replica replacement');
  const tokens = JSON.parse(response.body);
  for (const value of [tokens.access_token, tokens.refresh_token]) if (value) secrets.add(value);
}

try {
  report.scriptSha256 = hash(await readFile(new URL(import.meta.url)));
  report.dockerfileSha256 = hash(await readFile('deploy/identity/Dockerfile'));
  const inspected = JSON.parse(await docker(['image', 'inspect', image]));
  report.imageId = inspected[0].Id;
  report.architecture = inspected[0].Architecture;
  assert.deepEqual(inspected[0].Config.Cmd, ['start', '--optimized']);
  assert.equal(inspected[0].Config.User, '1000:1000');
  report.keycloakVersion = await docker([
    'run',
    '--rm',
    '--pull=never',
    '--network',
    'none',
    '--label',
    label,
    image,
    '--version',
  ]);
  assert.match(report.keycloakVersion, /26\.7\.3/);
  progress('Create owned TLS PostgreSQL and dedicated roles');
  await docker(['network', 'create', '--label', label, prefix]);
  networkCreated = true;
  const caConfig = await file(
    'ca.cnf',
    '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=GCR identity runtime fixture\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n',
  );
  for (const name of ['ca', 'other-ca']) {
    await exec('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-config',
      caConfig,
      '-keyout',
      path.join(directory, `${name}.key`),
      '-out',
      path.join(directory, `${name}.crt`),
    ]);
    await chmod(path.join(directory, `${name}.crt`), 0o644);
  }
  await exec('openssl', [
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=postgres',
    '-keyout',
    path.join(directory, 'server.key'),
    '-out',
    path.join(directory, 'server.csr'),
  ]);
  const leaf = await file(
    'leaf.cnf',
    'basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:postgres,DNS:identity.example.test,IP:127.0.0.1\n',
  );
  await exec('openssl', [
    'x509',
    '-req',
    '-in',
    path.join(directory, 'server.csr'),
    '-CA',
    path.join(directory, 'ca.crt'),
    '-CAkey',
    path.join(directory, 'ca.key'),
    '-CAcreateserial',
    '-days',
    '1',
    '-extfile',
    leaf,
    '-out',
    path.join(directory, 'server.crt'),
  ]);
  ca = await readFile(path.join(directory, 'ca.crt'), 'utf8');
  // Only these owned containers can reach the key via its private parent directory.
  await chmod(path.join(directory, 'server.key'), 0o644);
  await file(
    'pg_hba.conf',
    'local all all trust\nhostssl all all 0.0.0.0/0 scram-sha-256\nhostssl all all ::0/0 scram-sha-256\nhostnossl all all 0.0.0.0/0 reject\nhostnossl all all ::0/0 reject\n',
    0o644,
  );
  const pgEnv = await file(
    'postgres.env',
    `POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=${passwords.postgres}\nPOSTGRES_DB=postgres\nPGDATA=/var/lib/postgresql/data\n`,
  );
  await docker([
    'run',
    '-d',
    '--pull=never',
    '--name',
    pgName,
    '--label',
    label,
    '--network',
    prefix,
    '--network-alias',
    'postgres',
    '--network-alias',
    'wrong-host',
    '--tmpfs',
    '/var/lib/postgresql/data',
    '--env-file',
    pgEnv,
    '--memory',
    '1g',
    '-p',
    '127.0.0.1::5432',
    '--mount',
    `type=bind,source=${directory},target=/run/gcr,readonly`,
    '--entrypoint',
    '/bin/sh',
    postgresImage,
    '-ec',
    'cp /run/gcr/server.crt /tmp/server.crt; cp /run/gcr/server.key /tmp/server.key; chown postgres:postgres /tmp/server.*; chmod 600 /tmp/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key -c hba_file=/run/gcr/pg_hba.conf',
  ]);
  port = Number((await docker(['port', pgName, '5432/tcp'])).split(':').at(-1));
  admin = createDatabase(url('postgres', 'postgres'), 1, { tlsCa: ca });
  let databaseReady = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      await admin.query('select 1');
      databaseReady = true;
      break;
    } catch {
      await pause();
    }
  }
  assert(databaseReady, 'PostgreSQL TCP and verified TLS startup');
  plan = JSON.parse(await readFile('deploy/postgres/shared-plan.example.json', 'utf8'));
  delete plan.legacyOwner;
  await provision();
  await withDatabase('gcr_migrator', 'git_code_reviewer', (pool) => runMigrations(pool));
  await withDatabase('gcr_app', 'git_code_reviewer', (pool) =>
    pool.query(
      "insert into users (oidc_subject, display_name, role) values ('identity-runtime-fixture', 'Retained app user', 'reviewer')",
    ),
  );
  const initialApp = await appSnapshot();
  report.application = {
    userCount: initialApp.users.length,
    migrationCount: initialApp.ledger.length,
    sha256: hash(initialApp),
  };
  progress('Bootstrap optimized non-root Keycloak against its isolated TLS database');
  let first = await start(`${prefix}-first`);
  report.firstHealth = await ready(first);
  for (const endpoint of ['/health/live', '/health/started', '/metrics']) {
    assert.equal((await request(first.health, endpoint)).status, 200);
    assert.equal((await request(first.origin, endpoint)).status, 404);
  }
  check('Health and metrics are served only on the management port');
  check('Optimized image starts as UID/GID 1000 with read-only root and verified database TLS');
  check('KCRAW_DB_PASSWORD preserves literal property-expression characters');
  await management(first, '', 'POST', {
    realm,
    enabled: true,
    sslRequired: 'all',
    registrationAllowed: false,
  });
  await management(first, `/${realm}/users`, 'POST', {
    username: 'fixture-user',
    enabled: true,
    firstName: 'Fixture',
    lastName: 'User',
    email: 'fixture@example.test',
    emailVerified: true,
    credentials: [{ type: 'password', value: passwords.user, temporary: false }],
  });
  await management(first, `/${realm}/clients`, 'POST', {
    clientId: 'fixture-password-check',
    publicClient: true,
    directAccessGrantsEnabled: true,
    standardFlowEnabled: false,
    protocol: 'openid-connect',
  });
  const baseline = await identitySnapshot(first);
  await verifyPassword(first);
  report.identity = {
    userId: baseline.user.id,
    sha256: hash(baseline),
    keyCount: baseline.keys.length,
  };
  progress('Join a second replica using jdbc-ping and encrypted cache transport');
  const second = await start(`${prefix}-second`, {
    KC_BOOTSTRAP_ADMIN_USERNAME: 'must-not-be-created',
  });
  report.secondHealth = await ready(second);
  assert.deepEqual(await identitySnapshot(second), baseline);
  const unwanted = await management(first, '/master/users?username=must-not-be-created&exact=true');
  assert.deepEqual(unwanted, []);
  check(
    'Existing database startup does not recreate bootstrap administrator, users or signing keys',
  );
  const firstLogs = await docker(['logs', first.name]);
  const secondLogs = await docker(['logs', second.name]);
  assert(
    /ISPN000094.*\(2\)/.test(firstLogs + secondLogs),
    'jdbc-ping must form a two-member cluster',
  );
  assert(/TLS|mTLS|SSL/.test(firstLogs + secondLogs), 'Encrypted cache transport must be reported');
  check('Two replicas join the same jdbc-ping cluster');
  const connections = (
    await admin.query(
      "select a.datname, a.usename, s.ssl, count(*)::int as connections from pg_stat_activity a join pg_stat_ssl s on s.pid = a.pid where a.usename = 'gcr_keycloak' group by 1,2,3",
    )
  ).rows;
  assert.equal(connections.length, 1);
  assert.equal(connections[0].datname, 'git_code_reviewer_keycloak');
  assert.equal(connections[0].ssl, true);
  assert(connections[0].connections >= 2 && connections[0].connections <= 20);
  report.twoReplicaConnections = connections;
  check('Both replicas use only the identity database over TLS within the configured pool ceiling');
  await assert.rejects(
    withDatabase('gcr_keycloak', 'git_code_reviewer', (pool) => pool.query('select 1')),
  );
  await assert.rejects(
    withDatabase('gcr_app', 'git_code_reviewer_keycloak', (pool) => pool.query('select 1')),
  );
  check('Both runtime roles are denied access to the other database');
  progress('Replace one replica while the other keeps serving the existing realm');
  await stop(first);
  await ready(second);
  await verifyPassword(second);
  assert.deepEqual(await identitySnapshot(second), baseline);
  first = await start(`${prefix}-replacement`, {
    KC_BOOTSTRAP_ADMIN_USERNAME: 'must-not-be-created',
  });
  await ready(first);
  assert.deepEqual(await identitySnapshot(first), baseline);
  await verifyPassword(first);
  check('Graceful replica replacement preserves user credentials and realm signing keys');
  await stop(first);
  await stop(second);
  progress('Repeat DBA provisioning after real Keycloak schema initialization');
  await provision();
  const restarted = await start(`${prefix}-restarted`, {
    KC_BOOTSTRAP_ADMIN_USERNAME: 'must-not-be-created',
  });
  await ready(restarted);
  assert.deepEqual(await identitySnapshot(restarted), baseline);
  await verifyPassword(restarted);
  assert.deepEqual(await appSnapshot(), initialApp);
  check('Repeated DBA provisioning and full Keycloak restart preserve both applications');
  await stop(restarted);
  for (const [kind, overrides, pattern] of [
    [
      'wrong-ca',
      { KC_DB_TLS_TRUST_STORE_FILE: '/run/gcr/other-ca.crt' },
      /PKIX|certificate|certification|trust anchor/i,
    ],
    [
      'wrong-host',
      { KC_DB_URL_HOST: 'wrong-host' },
      /hostname.*verif|could not be verified|subject alternative|No name matching/i,
    ],
  ]) {
    progress(`Reject database TLS ${kind}`);
    const invalid = await start(`${prefix}-${kind}`, overrides);
    let exited = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      const response = await request(invalid.health, '/health/ready').catch(() => undefined);
      assert.notEqual(response?.status, 200, `${kind} must never become ready`);
      const state = JSON.parse(
        await docker(['inspect', '--format', '{{json .State}}', invalid.name]),
      );
      if (!state.Running) {
        assert.notEqual(state.ExitCode, 0);
        exited = true;
        break;
      }
      await pause();
    }
    assert(exited, `${kind} startup must terminate`);
    const diagnostics = await exec('docker', ['logs', invalid.name], { timeout: 15_000 });
    assert.match(diagnostics.stdout + diagnostics.stderr, pattern);
    check(`Database TLS ${kind} is rejected before readiness`);
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = redact(error?.message || error).slice(0, 6000);
  report.diagnostics = [];
  report.databaseActivity = (
    await admin
      ?.query(
        "select usename, datname, state, wait_event_type, wait_event, extract(epoch from clock_timestamp()-query_start)::int as query_age_seconds from pg_stat_activity where usename='gcr_keycloak'",
      )
      .catch(() => undefined)
  )?.rows;
  const owned = await docker(['ps', '-aq', '--filter', `label=${label}`]).catch(() => '');
  for (const name of owned.split('\n').filter(Boolean)) {
    const logs = await exec('docker', ['logs', '--tail', '40', name], { timeout: 15_000 }).catch(
      () => undefined,
    );
    if (logs) report.diagnostics.push({ name, tail: redact(logs.stdout + logs.stderr) });
  }
  process.exitCode = 1;
} finally {
  await admin?.end();
  for (const name of (await docker(['ps', '-aq', '--filter', `label=${label}`]))
    .split('\n')
    .filter(Boolean)) {
    assert.equal(
      await docker(['inspect', '--format', '{{ index .Config.Labels "gcr.fixture.id" }}', name]),
      identifier,
    );
    await docker(['rm', '-f', '-v', name]);
  }
  if (networkCreated) {
    assert.equal(
      await docker([
        'network',
        'inspect',
        '--format',
        '{{ index .Labels "gcr.fixture.id" }}',
        prefix,
      ]),
      identifier,
    );
    await docker(['network', 'rm', prefix]);
  }
  await rm(directory, { recursive: true, force: true });
  report.ownedResourcesRemoved = true;
  report.finishedAt = new Date().toISOString();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
