// Actual Compose infrastructure verification. Uses disposable credentials and a
// new project/volume; never starts the application or touches a cluster.
import assert from 'node:assert/strict';
import { execFile as callback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { prepareFreshIdentity } from './prepare-identity-compose.mjs';

const exec = promisify(callback);
const root = fileURLToPath(new URL('../', import.meta.url));
const parent = await mkdtemp(path.join(tmpdir(), 'gcr-compose-runtime-'));
const directory = path.join(parent, 'identity');
const images = {
  GCR_RUNTIME_IMAGE: 'node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32',
  GCR_POSTGRES_IMAGE:
    'postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73',
  GCR_IDENTITY_IMAGE: process.env.GCR_IDENTITY_IMAGE,
};
const report = {
  startedAt: new Date().toISOString(),
  node: process.version,
  images,
  checks: [],
  cleanup: false,
  clusterAccess: false,
  applicationStarted: false,
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const privateValues = [];
const redact = (value) => {
  let text = String(value);
  for (const secret of privateValues) if (secret) text = text.replaceAll(secret, '[redacted]');
  return text;
};
const docker = async (args) =>
  (
    await exec('docker', args, { cwd: root, timeout: 180_000, maxBuffer: 2 * 1024 ** 2 })
  ).stdout.trim();
const logs = async (id) => {
  const result = await exec('docker', ['logs', '--tail', '100', id], {
    timeout: 30_000,
    maxBuffer: 2 * 1024 ** 2,
  });
  return result.stdout + result.stderr;
};
let prepared, base, boot;
const compose = (bootstrap, args) => docker([...(bootstrap ? boot : base), ...args]);
const progress = (step) => {
  report.lastStep = step;
  process.stderr.write(`${new Date().toISOString()} ${step}\n`);
};
const check = (name) => report.checks.push(name);
const ids = async (service) =>
  (await compose(false, ['ps', '-a', '-q', service])).split('\n').filter(Boolean);
const inspect = async (id) => JSON.parse(await docker(['inspect', id]))[0];
async function ready(service, count) {
  const started = Date.now(),
    deadline = started + 600_000;
  while (Date.now() < deadline) {
    const current = await ids(service);
    assert.equal(current.length, count, `${service} replica count`);
    const states = await Promise.all(current.map(inspect));
    for (const state of states) assert(state.State.Running, `${service} exited before readiness`);
    if (states.every((state) => state.State.Health?.Status === 'healthy')) {
      report.readiness ??= [];
      report.readiness.push({ service, count, milliseconds: Date.now() - started });
      return states;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw Error(`${service} did not become healthy within 600 seconds`);
}
async function configuration(mode) {
  const result = JSON.parse(
    await compose(true, [
      'run',
      '--rm',
      '--no-deps',
      'identity-configure',
      mode,
      '/run/config/identity/plan.json',
    ]),
  );
  report.configuration ??= [];
  report.configuration.push(result);
  return result;
}
const probeSource = await readFile(
  new URL('./identity-container-probe.mjs', import.meta.url),
  'utf8',
);
async function probe(mode, replica) {
  const address =
    replica?.NetworkSettings.Networks[`${prepared.projectName}_identity-admin`]?.IPAddress;
  if (replica) assert(address, 'replica private admin address');
  const targeting = path.join(parent, 'probe-target.json');
  if (address)
    await writeFile(
      targeting,
      JSON.stringify({
        services: { 'identity-configure': { extra_hosts: [`keycloak:${address}`] } },
      }),
    );
  return JSON.parse(
    await docker([
      ...boot,
      ...(address ? ['-f', targeting] : []),
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'node',
      '--volume',
      `${path.join(parent, 'probe.mjs')}:/run/config/probe.mjs:ro`,
      '--volume',
      `${path.join(directory, 'session-secret')}:/run/secrets/fixture-user-password:ro`,
      'identity-configure',
      '/run/config/probe.mjs',
      mode,
    ]),
  );
}
try {
  assert.match(
    images.GCR_IDENTITY_IMAGE ?? '',
    /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/,
    'Set GCR_IDENTITY_IMAGE to a locally available optimized image digest',
  );
  report.probeSha256 = hash(probeSource);
  report.scriptSha256 = hash(await readFile(new URL(import.meta.url)));
  report.sourceSha256 = {};
  for (const file of [
    'compose.identity.yaml',
    'compose.identity.bootstrap.yaml',
    'deploy/identity/postgres-entrypoint.sh',
    'deploy/identity/keycloak-entrypoint.sh',
    'deploy/identity/configure.mjs',
    'deploy/identity/configuration.mjs',
    'packages/db/dist/provision-cli.js',
    'packages/db/dist/shared-postgres.js',
  ])
    report.sourceSha256[file] = hash(await readFile(path.join(root, file)));
  for (const image of Object.values(images)) await docker(['image', 'inspect', image]);
  prepared = await prepareFreshIdentity(directory, images);
  report.project = prepared.projectName;
  report.secretGid = prepared.secretGid;
  for (const file of await readdir(directory))
    if (/password|secret|username|key$/.test(file))
      privateValues.push((await readFile(path.join(directory, file), 'utf8')).trim());
  const overlay = path.join(parent, 'fixture.json');
  await writeFile(
    overlay,
    JSON.stringify({
      services: {
        postgres: {
          restart: 'no',
          networks: { 'identity-db': { aliases: ['wrong-database-host'] } },
        },
        keycloak: { restart: 'no' },
        'identity-db-provision': {
          entrypoint: ['node', '/workspace/packages/db/dist/provision-cli.js'],
          volumes: [`${root}:/workspace:ro`],
        },
      },
    }),
  );
  await writeFile(path.join(parent, 'probe.mjs'), probeSource);
  base = [
    'compose',
    '--project-name',
    prepared.projectName,
    '--env-file',
    path.join(directory, 'compose.env'),
    '-f',
    path.join(root, 'compose.yaml'),
    '-f',
    path.join(root, 'compose.identity.yaml'),
    '-f',
    overlay,
  ];
  boot = [...base, '-f', path.join(root, 'compose.identity.bootstrap.yaml')];
  progress('Start actual PostgreSQL Compose adapter with a fresh owned volume');
  await compose(false, ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'postgres']);
  const [pg] = await ready('postgres', 1);
  assert.equal(pg.HostConfig.ReadonlyRootfs, true);
  assert.equal(pg.HostConfig.Memory, 1024 ** 3);
  report.postgresVersion = await docker(['exec', pg.Id, 'postgres', '--version']);
  report.postgresTlsKey = await docker([
    'exec',
    pg.Id,
    'stat',
    '-c',
    '%U:%G %a',
    '/tmp/postgres-tls/server.key',
  ]);
  assert.equal(report.postgresTlsKey, 'postgres:postgres 600');
  const provision = async () =>
    JSON.parse(
      await compose(false, [
        'run',
        '--rm',
        '--no-deps',
        'identity-db-provision',
        '--apply',
        '/run/config/database/plan.json',
      ]),
    );
  report.provision = [await provision()];
  check('actual-PostgreSQL-17-adapter-file-secret-TLS-and-separated-role-provisioning');
  progress('Start optimized Keycloak using actual bootstrap file mounts');
  await compose(true, ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'keycloak']);
  const [first] = await ready('keycloak', 1);
  assert.equal(first.Config.User, '1000:1000');
  assert.equal(first.HostConfig.ReadonlyRootfs, true);
  assert(first.HostConfig.GroupAdd.includes(String(prepared.secretGid)));
  for (const state of [first, pg])
    for (const secret of privateValues)
      assert(!JSON.stringify(state).includes(secret), 'Secret plaintext in Docker configuration');
  check('actual-nonroot-Keycloak-file-secrets-readonly-root-and-no-inspect-plaintext');
  progress('Configure the real realm and clients; verify repeat application and limited token');
  const initial = await configuration('--inspect');
  assert.equal(initial.converged, false);
  const applied = await configuration('--apply');
  assert.equal(applied.converged, true);
  const baseline = await probe('create');
  report.identity = baseline;
  assert.equal(baseline.uid, 1000);
  const repeated = await configuration('--apply');
  assert.equal(repeated.converged, true);
  assert.deepEqual(repeated.actions, []);
  assert.deepEqual(await probe('snapshot'), baseline);
  check('actual-configurer-apply-repeat-user-key-client-and-password-preservation');
  check('actual-configured-service-account-token-manage-users-and-view-events-only');
  progress('Replace bootstrap container with two normal replicas on the same database');
  await compose(true, ['stop', 'keycloak']);
  await compose(true, ['rm', '-f', 'keycloak']);
  await compose(false, ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'keycloak']);
  const replicas = await ready('keycloak', 2);
  let clusterLogs = '';
  for (const replica of replicas) {
    assert(!replica.Config.Env.some((value) => /BOOTSTRAP_ADMIN/.test(value)));
    assert(!replica.Mounts.some((mount) => /bootstrap-admin/.test(mount.Destination)));
    clusterLogs += await logs(replica.Id);
    assert.deepEqual(await probe('snapshot', replica), baseline);
  }
  assert.match(clusterLogs, /ISPN000094.*\(2\)/);
  assert.match(clusterLogs, /JGroups Encryption enabled \(mTLS\)/);
  report.twoReplicaConnections = JSON.parse(
    await docker([
      'exec',
      pg.Id,
      'psql',
      '-U',
      'gcr_dba',
      '-d',
      'postgres',
      '-Atc',
      "SELECT json_agg(t) FROM (SELECT a.datname, s.ssl, count(*)::int AS connections FROM pg_stat_activity a JOIN pg_stat_ssl s USING (pid) WHERE a.usename = 'gcr_keycloak' GROUP BY 1,2) t",
    ]),
  );
  assert.equal(report.twoReplicaConnections.length, 1);
  assert.equal(report.twoReplicaConnections[0].datname, 'git_code_reviewer_keycloak');
  assert.equal(report.twoReplicaConnections[0].ssl, true);
  assert(
    report.twoReplicaConnections[0].connections >= 2 &&
      report.twoReplicaConnections[0].connections <= 12,
  );
  check('two-normal-replicas-without-bootstrap-secrets-preserve-identity-and-credential');
  check('jdbc-ping-two-member-cluster-and-TLS-database-connections-within-two-pool-ceiling');
  progress('Replace one normal replica while the other serves the retained identity');
  await docker(['stop', '--time', '120', replicas[0].Id]);
  assert.match(await logs(replicas[0].Id), /Keycloak stopped in/);
  assert.equal((await inspect(replicas[1].Id)).State.Running, true);
  assert.deepEqual(await probe('snapshot', replicas[1]), baseline);
  await docker(['rm', replicas[0].Id]);
  await compose(false, ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'keycloak']);
  const replaced = await ready('keycloak', 2);
  assert(replaced.some((replica) => replica.Id === replicas[1].Id));
  assert(!replaced.some((replica) => replica.Id === replicas[0].Id));
  for (const replica of replaced) assert.deepEqual(await probe('snapshot', replica), baseline);
  check('single-replica-replacement-keeps-peer-serving-the-same-user-password-and-keys');
  progress('Stop replicas, repeat DBA provisioning, recreate PostgreSQL on the retained volume');
  await compose(false, ['stop', 'keycloak']);
  report.provision.push(await provision());
  await compose(false, ['stop', 'postgres']);
  await compose(false, ['rm', '-f', 'postgres']);
  await compose(false, ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'postgres']);
  await ready('postgres', 1);
  await compose(false, ['start', 'keycloak']);
  const restarted = await ready('keycloak', 2);
  for (const replica of restarted) assert.deepEqual(await probe('snapshot', replica), baseline);
  assert.equal((await configuration('--inspect')).converged, true);
  check('retained-volume-PostgreSQL-recreation-and-DBA-repeat-preserve-Keycloak-identities');
  progress('Reject wrong database CA and hostname with the same optimized image');
  await compose(false, ['stop', 'keycloak']);
  report.tlsRejections = [];
  for (const [name, environment, pattern] of [
    [
      'wrong-ca',
      'KC_DB_TLS_TRUST_STORE_FILE=/run/secrets/keycloak-tls-cert',
      /PKIX|certificate|certification|trust anchor/i,
    ],
    [
      'wrong-hostname',
      'KC_DB_URL_HOST=wrong-database-host',
      /hostname.*verif|could not be verified|subject alternative|No name matching/i,
    ],
  ]) {
    let rejection;
    try {
      await compose(false, ['run', '--rm', '--no-deps', '-e', environment, 'keycloak']);
    } catch (error) {
      assert.equal(error.killed, false, 'TLS test must exit, not be terminated by command timeout');
      assert(Number.isInteger(error.code) && error.code !== 0);
      assert.match(error.stdout + error.stderr, pattern);
      rejection = { name, exitCode: error.code };
    }
    assert(rejection, name + ' unexpectedly started');
    report.tlsRejections.push(rejection);
  }
  check('optimized-Keycloak-startup-rejects-wrong-database-CA-and-hostname');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failedStep = report.lastStep;
  report.error = redact(error.message);
  if (base) {
    report.configurationReadback = await configuration('--inspect').catch((error) => ({
      error: redact(error.message),
    }));
    report.configurationDifferences = await probe('diagnose').catch((error) => ({
      error: redact(error.message),
    }));
    report.diagnostics = {};
    for (const service of ['postgres', 'keycloak'])
      for (const id of await ids(service).catch(() => [])) {
        const state = await inspect(id).catch(() => undefined);
        report.diagnostics[id] = {
          state: state?.State,
          logs: redact(await logs(id).catch(() => 'unavailable')),
        };
      }
  }
  process.exitCode = 1;
} finally {
  if (base) {
    progress('Remove only the owned Compose project, volume, networks, and generated files');
    try {
      await compose(false, ['down', '--volumes', '--remove-orphans', '--timeout', '120']);
      assert.equal(
        await docker([
          'ps',
          '-a',
          '-q',
          '--filter',
          `label=com.docker.compose.project=${prepared.projectName}`,
        ]),
        '',
      );
      assert.equal(
        await docker([
          'volume',
          'ls',
          '-q',
          '--filter',
          `label=com.docker.compose.project=${prepared.projectName}`,
        ]),
        '',
      );
      assert.equal(
        await docker([
          'network',
          'ls',
          '-q',
          '--filter',
          `label=com.docker.compose.project=${prepared.projectName}`,
        ]),
        '',
      );
      report.cleanup = true;
    } catch (error) {
      report.cleanupError = redact(error.message);
      process.exitCode = 1;
    }
  }
  await rm(parent, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
}
