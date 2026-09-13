// Compose model and compiled-config verification; never starts Docker services.
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../apps/runtime/dist/config.js';
import { loadSamlProtocolConfig } from '../apps/runtime/dist/auth/saml-config.js';
import { prepareFreshIdentity } from './prepare-identity-compose.mjs';

const execFile = promisify(execFileCallback);
const root = fileURLToPath(new URL('../', import.meta.url));
const parent = await mkdtemp(path.join(tmpdir(), 'gcr-compose-model-'));
const directory = path.join(parent, 'identity');
const evidence = {
  startedAt: new Date().toISOString(),
  node: process.version,
  checks: [],
  cleanup: false,
  startedContainers: 0,
  databaseConnected: false,
  metadataResponse: 'fixture',
  realKeycloak: false,
};
const check = (name) => evidence.checks.push(name);
try {
  const settings = {
    GCR_RUNTIME_IMAGE: `example.invalid/gcr@sha256:${'a'.repeat(64)}`,
    GCR_IDENTITY_IMAGE: `example.invalid/identity@sha256:${'b'.repeat(64)}`,
    GCR_POSTGRES_IMAGE: `postgres@sha256:${'c'.repeat(64)}`,
  };
  const prepared = await prepareFreshIdentity(directory, settings);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const secretNames = [
    'dba-password',
    'app-db-password',
    'migrator-db-password',
    'keycloak-db-password',
    'session-secret',
    'credential-encryption-key',
    'identity-admin-client-secret',
    'bootstrap-admin-password',
    'bootstrap-admin-username',
    'sp-signing-key',
    'proxy-tls-key',
    'keycloak-tls-key',
    'postgres-tls-key',
  ];
  const privateValues = await Promise.all(
    secretNames.map((name) => readFile(path.join(directory, name), 'utf8')),
  );
  assert.equal(new Set(privateValues).size, privateValues.length);
  for (const name of secretNames) {
    const item = await stat(path.join(directory, name));
    assert.equal(item.mode & 0o777, 0o640, name);
    assert.equal(item.gid, prepared.secretGid);
  }
  assert.equal((await stat(path.join(directory, 'ca.key'))).mode & 0o777, 0o600);
  check('new-private-directory-distinct-secrets-and-readable-consumer-group');
  const ca = new X509Certificate(await readFile(path.join(directory, 'ca.crt')));
  for (const [name, host] of [
    ['proxy', 'gcr.test'],
    ['proxy', 'identity.test'],
    ['keycloak', 'keycloak'],
    ['postgres', 'postgres'],
  ]) {
    const cert = new X509Certificate(await readFile(path.join(directory, `${name}-tls-cert`)));
    assert(cert.verify(ca.publicKey));
    assert.equal(cert.checkHost(host), host);
    assert(Date.parse(cert.validTo) > Date.now());
  }
  check('separate-public-private-and-database-TLS-leaves-signed-by-local-CA');
  const files = await readdir(directory);
  const hashes = async () =>
    Object.fromEntries(
      await Promise.all(
        files.map(async (name) => [
          name,
          createHash('sha256')
            .update(await readFile(path.join(directory, name)))
            .digest('hex'),
        ]),
      ),
    );
  const before = await hashes();
  await assert.rejects(() => prepareFreshIdentity(directory, settings), { code: 'EEXIST' });
  assert.deepEqual(await hashes(), before);
  await assert.rejects(() =>
    prepareFreshIdentity(path.join(parent, 'invalid'), {
      ...settings,
      GCR_RUNTIME_IMAGE: 'gcr:latest',
    }),
  );
  await assert.rejects(() =>
    prepareFreshIdentity(path.join(root, 'identity-test-credentials'), settings),
  );
  check('repeat-preparation-never-overwrites-and-unpinned-images-or-Git-directory-refused');
  const plan = JSON.parse(await readFile(path.join(directory, 'database-plan.json'), 'utf8'));
  assert.equal(plan.legacyOwner, undefined);
  assert.equal(plan.identityDatabase, 'git_code_reviewer_keycloak');
  check('fresh-plan-omits-legacy-owner-and-preserves-two-database-contract');
  const composeEnv = Object.fromEntries(
    (await readFile(path.join(directory, 'compose.env'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const i = line.indexOf('=');
        return [line.slice(0, i), line.slice(i + 2, -1)];
      }),
  );
  // Poison legacy interpolation inputs. !override must discard them completely.
  const env = {
    ...process.env,
    ...composeEnv,
    POSTGRES_PASSWORD: 'fixture-do-not-inherit',
    SESSION_SECRET: 'fixture-do-not-inherit-session',
    DEV_USER_ROLE: 'admin',
    DEV_USER_SUBJECT: 'fixture-dev-user',
    APP_PORT: '4999',
    POSTGRES_PORT: '29999',
    GITHUB_MODE: 'fixture',
    BUILD_CA_CERT: 'fixture-unused',
  };
  const command = ['compose', '-f', 'compose.yaml', '-f', 'compose.identity.yaml'];
  async function render(extra = [], options = {}) {
    const output = await execFile(
      'docker',
      [
        ...command,
        ...extra,
        '--profile',
        'identity-ops',
        '--profile',
        'agent',
        'config',
        '--format',
        'json',
      ],
      { cwd: root, env: { ...env, ...options }, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return JSON.parse(output.stdout);
  }
  const model = await render();
  const service = model.services;
  const names = (entries = []) => entries.map((entry) => entry.source).sort();
  assert.deepEqual(
    Object.entries(service)
      .filter(([, s]) => s.image.startsWith('postgres@'))
      .map(([name]) => name),
    ['postgres'],
  );
  assert.deepEqual(names(service.postgres.volumes), ['git-code-reviewer-postgres']);
  assert.equal(
    model.volumes['git-code-reviewer-postgres'].name,
    `${prepared.projectName}_git-code-reviewer-postgres`,
  );
  assert.match(prepared.projectName, /^gcr-identity-[a-f0-9]{16}$/);
  assert.equal(service.keycloak.volumes, undefined);
  check('one-original-PostgreSQL-service-and-persistent-volume-no-identity-database-volume');
  assert.equal(service.server.ports, undefined);
  assert.equal(service.postgres.ports, undefined);
  const published = Object.entries(service)
    .filter(([, s]) => s.ports?.length)
    .map(([name]) => name);
  assert.deepEqual(published, ['identity-proxy']);
  assert.equal(service['identity-proxy'].ports[0].host_ip, '127.0.0.1');
  assert.equal(service['identity-proxy'].ports[0].target, 8443);
  assert.equal(service['identity-proxy'].ports[0].published, '8443');
  check('only-loopback-HTTPS-published-inherited-app-and-DB-ports-removed');
  for (const name of ['server', 'worker', 'migrate', 'retention']) {
    const values = service[name].environment;
    for (const key of [
      'DATABASE_URL',
      'SESSION_SECRET',
      'CREDENTIAL_ENCRYPTION_KEY',
      'DEV_USER_SUBJECT',
      'DEV_USER_ROLE',
      'LOCAL_BOOTSTRAP_ADMIN_PASSWORD',
    ])
      assert.equal(values[key], undefined, `${name}/${key}`);
    assert.equal(values.NODE_ENV, 'production');
    assert.equal(values.DATABASE_ISOLATED_ROLES, 'true');
    assert.equal(service[name].user, '1000:1000');
    assert.equal(service[name].read_only, true);
    assert.deepEqual(service[name].cap_drop, ['ALL']);
  }
  assert.equal(service.server.environment.AUTH_MODE, 'saml');
  assert.equal(service.worker.environment.AUTH_MODE, 'saml');
  assert.equal(service.server.environment.AUTO_JOIN_DEFAULT_TENANT, 'false');
  assert.equal(service.server.environment.GITHUB_MODE, 'registry');
  assert.equal(service.migrate.build, undefined);
  for (const privateValue of privateValues) assert(!JSON.stringify(model).includes(privateValue));
  check('development-bypass-build-and-secret-values-absent-from-merged-model');
  assert.deepEqual(names(service.server.secrets), [
    'app-db-password',
    'credential-encryption-key',
    'identity-admin-client-secret',
    'session-secret',
    'sp-signing-cert',
    'sp-signing-key',
  ]);
  assert.deepEqual(names(service.worker.secrets), [
    'app-db-password',
    'credential-encryption-key',
    'identity-admin-client-secret',
  ]);
  assert.deepEqual(names(service.migrate.secrets), ['migrator-db-password']);
  assert.deepEqual(names(service.retention.secrets), ['app-db-password']);
  assert.deepEqual(names(service.keycloak.secrets), [
    'keycloak-db-password',
    'keycloak-tls-cert',
    'keycloak-tls-key',
  ]);
  assert.deepEqual(names(service['identity-proxy'].secrets), ['proxy-tls-cert', 'proxy-tls-key']);
  assert.equal(service['source-sandbox'].secrets, undefined);
  assert.equal(service['source-sandbox'].environment, undefined);
  assert.equal(service['source-sandbox'].network_mode, 'none');
  assert(!Object.values(model.secrets).some((s) => s.file?.endsWith('/ca.key')));
  check('role-specific-secret-mounts-and-no-CA-key-or-bootstrap-secret-in-normal-runtime');
  assert.deepEqual(Object.keys(service.migrate.networks), ['migration-db']);
  assert.deepEqual(Object.keys(service['identity-db-provision'].networks), ['dba-db']);
  assert.deepEqual(Object.keys(service.retention.networks), ['app-db']);
  for (const [left, right] of [
    ['migrate', 'keycloak'],
    ['retention', 'keycloak'],
    ['identity-db-provision', 'keycloak'],
  ])
    assert.equal(
      Object.keys(service[left].networks).filter((network) => network in service[right].networks)
        .length,
      0,
    );
  assert.equal(
    service.keycloak.environment.KC_PROXY_TRUSTED_ADDRESSES,
    service['identity-proxy'].networks['identity-public'].ipv4_address,
  );
  assert.deepEqual(service['identity-proxy'].networks.application.aliases, [
    'gcr.test',
    'identity.test',
  ]);
  check('DB-maintenance-and-migration-bridges-separated-from-identity-admin-peers');
  assert.equal(service['identity-db-provision'].profiles[0], 'identity-ops');
  assert.equal(service['identity-db-provision'].command[0], '--inspect');
  for (const s of Object.values(service)) assert(!s.depends_on?.['identity-db-provision']);
  assert.equal(service.keycloak.deploy.replicas, 2);
  assert.equal(service.keycloak.environment.KC_CACHE_STACK, 'jdbc-ping');
  assert.equal(service.keycloak.environment.KC_DB_TLS_MODE, 'verify-server');
  assert.equal(service.worker.stop_grace_period, '1h0m0s');
  assert.equal(service.postgres.environment.GCR_POSTGRES_MAJOR, '17');
  assert.equal(service.postgres.environment.POSTGRES_PASSWORD, undefined);
  assert.equal(service.postgres.environment.POSTGRES_USER, 'gcr_dba');
  check('explicit-DBA-inspection-first-two-replicas-verified-TLS-and-worker-drain');
  const bootstrap = await render(['-f', 'compose.identity.bootstrap.yaml']);
  assert.equal(bootstrap.services.keycloak.deploy.replicas, 1);
  assert.deepEqual(
    names(bootstrap.services.keycloak.secrets),
    [
      ...names(service.keycloak.secrets),
      'bootstrap-admin-password',
      'bootstrap-admin-username',
    ].sort(),
  );
  for (const name of Object.keys(service).filter((name) => name !== 'keycloak'))
    assert.deepEqual(bootstrap.services[name], service[name]);
  check('bootstrap-overlay-only-adds-temporary-Keycloak-admin-and-single-replica');
  const custom = await render([], {
    GCR_HTTPS_PORT: '19443',
    GCR_PUBLIC_HOST: 'review.custom.test',
    GCR_IDENTITY_HOST: 'login.custom.test',
  });
  assert.equal(custom.services['identity-proxy'].ports[0].target, 19443);
  assert.equal(custom.services['identity-proxy'].ports[0].published, '19443');
  assert.equal(
    custom.services.server.environment.PUBLIC_BASE_URL,
    'https://review.custom.test:19443',
  );
  assert.equal(
    custom.services.worker.environment.SAML_IDP_ISSUER,
    'https://login.custom.test:19443/realms/git-code-reviewer',
  );
  check('custom-HTTPS-port-and-hostnames-consistent-inside-and-outside-network');
  for (const [name, runtimeCommand, expectedRole, pool] of [
    ['server', 'serve', 'gcr_app', 6],
    ['worker', 'worker', 'gcr_app', 6],
    ['migrate', 'migrate', 'gcr_migrator', 2],
    ['retention', 'retention', 'gcr_app', 2],
  ]) {
    const values = { ...service[name].environment };
    for (const [key, value] of Object.entries(values)) {
      const mount = [...(service[name].secrets ?? []), ...(service[name].configs ?? [])].find(
        (item) =>
          (item.target.startsWith('/') ? item.target : `/run/secrets/${item.target}`) === value,
      );
      if (mount) values[key] = (model.secrets[mount.source] ?? model.configs[mount.source]).file;
    }
    if (name === 'server')
      values.SESSION_SECRET = await readFile(path.join(directory, 'session-secret'), 'utf8');
    if (name === 'server' || name === 'worker')
      values.CREDENTIAL_ENCRYPTION_KEY = await readFile(
        path.join(directory, 'credential-encryption-key'),
        'utf8',
      );
    const config = loadConfig(values, runtimeCommand);
    assert.equal(new URL(config.DATABASE_URL).username, expectedRole);
    assert.equal(config.DATABASE_POOL_MAX, pool);
    assert.equal(config.DATABASE_TLS_MODE, 'verify-full');
    if (name === 'server') {
      const cert = (await readFile(path.join(directory, 'keycloak-tls-cert'), 'utf8')).replace(
        /-----[^-]+-----|\s/g,
        '',
      );
      const issuer = config.SAML_IDP_ISSUER,
        entry = config.SAML_IDP_ENTRY_POINT;
      const xml = `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${issuer}"><IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${cert}</X509Certificate></X509Data></KeyInfo></KeyDescriptor><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${entry}"/><SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${entry}"/></IDPSSODescriptor></EntityDescriptor>`;
      const protocol = await loadSamlProtocolConfig(config, async (url, options) => {
        assert.equal(url, config.SAML_IDP_METADATA_URL);
        assert.equal(options.redirect, 'error');
        return new Response(xml, { headers: { 'content-type': 'application/samlmetadata+xml' } });
      });
      assert.equal(protocol.entityId, config.SAML_ENTITY_ID);
    }
  }
  check('four-compiled-runtime-commands-load-rendered-role-TLS-and-SAML-configuration');
  for (const file of ['runtime-entrypoint.sh', 'postgres-entrypoint.sh'])
    await execFile('/bin/sh', ['-n', path.join(root, 'deploy/identity', file)]);
  await execFile('/bin/bash', ['-n', path.join(root, 'deploy/identity/keycloak-entrypoint.sh')]);
  check('entrypoint-shell-syntax');
  const sources = [
    'compose.identity.yaml',
    'compose.identity.bootstrap.yaml',
    'scripts/prepare-identity-compose.mjs',
    'deploy/identity/runtime-entrypoint.sh',
    'deploy/identity/keycloak-entrypoint.sh',
    'deploy/identity/postgres-entrypoint.sh',
    'deploy/identity/pg_hba.conf',
    'apps/runtime/dist/config.js',
    'apps/runtime/dist/auth/saml-config.js',
  ];
  evidence.sourceSha256 = Object.fromEntries(
    await Promise.all(
      sources.map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(path.join(root, file)))
          .digest('hex'),
      ]),
    ),
  );
  evidence.composeVersion = (
    await execFile('docker', ['compose', 'version', '--short'])
  ).stdout.trim();
  evidence.success = true;
} catch (error) {
  evidence.success = false;
  evidence.failure =
    error instanceof assert.AssertionError ? error.message : (error.code ?? error.message);
  process.exitCode = 1;
} finally {
  await rm(parent, { recursive: true, force: true });
  evidence.cleanup = true;
  evidence.completedAt = new Date().toISOString();
  if (process.env.GCR_IDENTITY_COMPOSE_EVIDENCE)
    await writeFile(
      process.env.GCR_IDENTITY_COMPOSE_EVIDENCE,
      JSON.stringify(evidence, null, 2) + '\n',
      { flag: 'wx' },
    );
  console.log(JSON.stringify(evidence, null, 2));
}
