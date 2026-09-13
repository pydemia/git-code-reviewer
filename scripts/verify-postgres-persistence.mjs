// Exercise the operational PostgreSQL image on owned disposable Docker volumes.
// Build @gcr/db first and pull the pinned amd64 image explicitly. No cluster access.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createDatabase, runMigrations } from '../packages/db/dist/index.js';

const exec = promisify(execFile);
const image =
  'registry-1.docker.io/bitnami/postgresql@sha256:e39896e0b1ba7b0d5b8de7ab8792118eaac3cc27f89659aa9fe2c788b395e204';
const startedAt = new Date().toISOString();
const directory = await mkdtemp(path.join(tmpdir(), 'gcr-postgres-persistence-'));
const identifier = randomUUID();
const ownedContainers = new Set();
const report = { startedAt, image, node: process.version, cases: [], clusterAccess: false };
const secretValues = new Set();
const redact = (value) => {
  let text = String(value);
  for (const secret of secretValues) text = text.replaceAll(secret, '[redacted]');
  return text.replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[database URL redacted]');
};
const progress = (step) => {
  report.lastStep = step;
  process.stderr.write(`${new Date().toISOString()} ${step}\n`);
};
const docker = async (args, options = {}) =>
  (
    await exec('docker', args, { timeout: 90_000, maxBuffer: 2 * 1024 * 1024, ...options })
  ).stdout.trim();
const hash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const summarize = (rows) => ({ count: rows.length, sha256: hash(canonical(rows)) });
const label = `gcr.fixture.id=${identifier}`;
const privateFile = async (name, contents) => {
  const filename = path.join(directory, name);
  await writeFile(filename, contents, { mode: 0o600 });
  return filename;
};

async function stop(name) {
  await docker(['stop', '--time', '30', name]);
  await docker(['rm', '-v', name]);
  ownedContainers.delete(name);
}

async function scenario(kind, ca, input, configuration) {
  progress(`${kind}: prepare owned volumes`);
  const prefix = `gcr-pg-persist-${kind}-${identifier}`;
  const dataVolume = `${prefix}-data`,
    certVolume = `${prefix}-certs`;
  for (const volume of [dataVolume, certVolume]) {
    await docker(['volume', 'create', '--label', label, volume]);
  }
  // Docker named volumes need an initial owner instead of Kubernetes fsGroup.
  await docker([
    'run',
    '--rm',
    '--label',
    label,
    '--pull=never',
    '--platform',
    'linux/amd64',
    '--user',
    '0:0',
    '--mount',
    `source=${dataVolume},target=/data`,
    '--mount',
    `source=${certVolume},target=/certs`,
    '--entrypoint',
    '/bin/sh',
    image,
    '-ec',
    'chown -R 1001:1001 /data /certs; chmod 700 /data /certs',
  ]);
  // The same image provides the chart's cp/chmod utilities, with the init
  // container running non-root and its root filesystem read-only.
  await docker([
    'run',
    '--rm',
    '--label',
    label,
    '--pull=never',
    '--platform',
    'linux/amd64',
    '--user',
    '1001:1001',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--mount',
    `source=${certVolume},target=/opt/bitnami/postgresql/certs,volume-nocopy`,
    '--mount',
    `type=bind,source=${input},target=/tmp/certs,readonly`,
    '--entrypoint',
    '/bin/sh',
    image,
    '-ec',
    'cp /tmp/certs/* /opt/bitnami/postgresql/certs/; chmod 600 /opt/bitnami/postgresql/certs/tls.key',
  ]);
  const passwords = Object.fromEntries(
    ['postgres', 'git_code_reviewer', 'gcr_app', 'gcr_migrator', 'gcr_keycloak'].map((role) => [
      role,
      randomBytes(24).toString('hex'),
    ]),
  );
  const passwordFiles = Object.fromEntries(
    await Promise.all(
      Object.entries(passwords).map(async ([role, password]) => [
        role,
        await privateFile(`${kind}-${role}`, password),
      ]),
    ),
  );
  for (const password of Object.values(passwords)) secretValues.add(password);
  const environment = await privateFile(
    `${kind}-bootstrap.env`,
    `POSTGRESQL_USERNAME=git_code_reviewer\nPOSTGRESQL_DATABASE=git_code_reviewer\nPOSTGRESQL_PASSWORD=${passwords.git_code_reviewer}\nPOSTGRESQL_POSTGRES_PASSWORD=${passwords.postgres}\nPOSTGRESQL_SHARED_PRELOAD_LIBRARIES=\n`,
  );
  let port,
    revision = 0,
    current;
  const ids = [];
  const url = (role, database) => {
    const value = new URL(`postgresql://127.0.0.1:${port}/${database}`);
    value.username = role;
    value.password = passwords[role];
    return value.toString();
  };
  const pool = (role, database = 'git_code_reviewer', tls = true, isolated = false) =>
    createDatabase(url(role, database), isolated && role === 'gcr_app' ? 2 : 1, {
      ...(tls ? { tlsCa: ca } : {}),
      ...(isolated ? { expectedRole: role } : {}),
    });
  const query = async (role, database, sql, tls = true, isolated = false) => {
    const db = pool(role, database, tls, isolated);
    try {
      return (await db.query(sql)).rows;
    } finally {
      await db.end();
    }
  };
  async function start(tls) {
    current = `${prefix}-${++revision}`;
    progress(`${kind}: start container ${revision}, TLS ${tls}`);
    const args = [
      'run',
      '-d',
      '--pull=never',
      '--platform',
      'linux/amd64',
      '--name',
      current,
      '--label',
      label,
      '--user',
      '1001:1001',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges:true',
      '--memory',
      '1g',
      '--shm-size',
      '128m',
      '-p',
      '127.0.0.1::5432',
      '--env-file',
      environment,
      '--mount',
      // Do not let Docker overwrite the empty volume's prepared ownership with
      // image mount-point metadata. Kubernetes uses fsGroup after mounting.
      `source=${dataVolume},target=/bitnami/postgresql,volume-nocopy`,
    ];
    for (const location of ['/tmp', '/opt/bitnami/postgresql/conf', '/opt/bitnami/postgresql/tmp'])
      args.push('--tmpfs', `${location}:rw,uid=1001,gid=1001,mode=0770`);
    if (tls)
      args.push(
        '--mount',
        `source=${certVolume},target=/opt/bitnami/postgresql/certs,readonly`,
        '--mount',
        `type=bind,source=${configuration},target=/bitnami/postgresql/conf,readonly`,
        '-e',
        'POSTGRESQL_ENABLE_TLS=yes',
        '-e',
        'POSTGRESQL_TLS_CERT_FILE=/opt/bitnami/postgresql/certs/tls.crt',
        '-e',
        'POSTGRESQL_TLS_KEY_FILE=/opt/bitnami/postgresql/certs/tls.key',
      );
    args.push(image);
    ids.push(await docker(args));
    ownedContainers.add(current);
    assert.equal(
      await docker([
        'inspect',
        '--format',
        '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}}',
        current,
      ]),
      '1001:1001 true',
    );
    port = Number((await docker(['port', current, '5432/tcp'])).split(':').at(-1));
    let ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      try {
        await query('postgres', 'postgres', 'select 1', tls);
        ready = true;
        break;
      } catch {
        const state = await docker(['inspect', '--format', '{{.State.Running}}', current]);
        if (state !== 'true') throw Error(`PostgreSQL ${kind} fixture stopped during startup`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    assert(ready, 'PostgreSQL startup deadline exceeded');
    const metadata = (
      await query(
        'postgres',
        'postgres',
        "select current_setting('server_version') as version,current_setting('ssl') as ssl,current_setting('max_connections') as max_connections",
        tls,
      )
    )[0];
    assert.match(metadata.version, /^18\.6\b/);
    assert.equal(metadata.ssl, tls ? 'on' : 'off');
    assert.equal(metadata.max_connections, '100');
    return metadata;
  }
  async function applicationSnapshot(role = 'gcr_app', tls = true) {
    const db = pool(role, 'git_code_reviewer', tls, role === 'gcr_app');
    try {
      return Object.fromEntries(
        await Promise.all(
          ['users', 'service_metadata', 'schema_migrations'].map(async (table) => [
            table,
            summarize((await db.query(`select to_jsonb(t) as row from ${table} t`)).rows),
          ]),
        ),
      );
    } finally {
      await db.end();
    }
  }
  async function completeSnapshot() {
    const roles = await query(
      'postgres',
      'postgres',
      "select to_jsonb(r) as row from pg_authid r where rolname in ('postgres','git_code_reviewer','gcr_app','gcr_migrator','gcr_keycloak')",
    );
    const databases = await query(
      'postgres',
      'postgres',
      'select datname,datdba,datacl,datallowconn,datconnlimit from pg_database',
    );
    const membership = await query('postgres', 'postgres', 'select * from pg_auth_members');
    const schemas = {};
    for (const database of ['git_code_reviewer', 'git_code_reviewer_keycloak']) {
      schemas[database] = summarize(
        await query(
          'postgres',
          database,
          `
        select jsonb_build_object('kind','schema','name',nspname,'owner',nspowner,
          'acl',coalesce(nspacl,acldefault('n',nspowner))) as row
          from pg_namespace where nspname='public'
        union all select jsonb_build_object('kind',relkind,'name',relname,'owner',relowner,
          'acl',coalesce(relacl,acldefault((case when relkind='S' then 's' else 'r' end)::"char",relowner)))
          from pg_class where relnamespace='public'::regnamespace
        union all select jsonb_build_object('kind','function','name',proname,'owner',proowner,
          'acl',coalesce(proacl,acldefault('f',proowner)))
          from pg_proc where pronamespace='public'::regnamespace
        union all select jsonb_build_object('kind','default','role',defaclrole,'namespace',defaclnamespace,
          'type',defaclobjtype,'acl',defaclacl) from pg_default_acl`,
        ),
      );
    }
    return {
      roles: summarize(roles),
      databases: summarize(databases),
      membership: summarize(membership),
      schemas,
      application: await applicationSnapshot(),
      identity: summarize(
        await query('gcr_keycloak', 'git_code_reviewer_keycloak', 'select * from identity_fixture'),
      ),
    };
  }
  async function apply(mode) {
    progress(`${kind}: DBA ${mode}`);
    const plan = await privateFile(
      `${kind}-plan.json`,
      await readFile('deploy/postgres/shared-plan.example.json', 'utf8'),
    );
    const result = await exec(process.execPath, ['packages/db/dist/provision-cli.js', mode, plan], {
      timeout: 90_000,
      env: {
        ...process.env,
        GCR_DBA_HOST: '127.0.0.1',
        GCR_DBA_PORT: String(port),
        GCR_DBA_DATABASE: 'postgres',
        GCR_DBA_USER: 'postgres',
        GCR_DBA_PASSWORD_FILE: passwordFiles.postgres,
        GCR_DBA_CA_FILE: path.join(input, 'ca.crt'),
        GCR_DBA_ALLOW_LOOPBACK_PLAINTEXT: 'false',
        GCR_APP_PASSWORD_FILE: passwordFiles.gcr_app,
        GCR_MIGRATOR_PASSWORD_FILE: passwordFiles.gcr_migrator,
        GCR_KEYCLOAK_PASSWORD_FILE: passwordFiles.gcr_keycloak,
      },
    });
    return JSON.parse(result.stdout);
  }
  async function isolation() {
    for (const role of ['gcr_app', 'gcr_migrator'])
      for (const database of ['git_code_reviewer_keycloak', 'postgres', 'template1'])
        await assert.rejects(query(role, database, 'select 1'), { code: '42501' });
    for (const database of ['git_code_reviewer', 'postgres', 'template1'])
      await assert.rejects(query('gcr_keycloak', database, 'select 1'), { code: '42501' });
    await assert.rejects(query('git_code_reviewer', 'git_code_reviewer', 'select 1'), {
      code: '28000',
    });
    await assert.rejects(query('gcr_app', 'git_code_reviewer', 'select 1', false), {
      code: '28000',
    });
    await assert.rejects(
      query('gcr_app', 'git_code_reviewer', 'create table forbidden_fixture(id int)', true, true),
      { code: '42501' },
    );
    await assert.rejects(
      query('gcr_app', 'git_code_reviewer', 'delete from schema_migrations', true, true),
      { code: '42501' },
    );
  }

  const initial = await start(kind === 'empty');
  const legacy = pool('git_code_reviewer', 'git_code_reviewer', kind === 'empty');
  let legacySnapshot;
  try {
    if (kind === 'existing') {
      await runMigrations(legacy);
      await legacy.query(
        "insert into users(oidc_subject,display_name,role) values ('persisted-fixture','Persisted fixture','administrator')",
      );
      await legacy.query(
        "insert into service_metadata(key,value) values ('persisted-fixture','{\"preserved\":true}')",
      );
      legacySnapshot = await applicationSnapshot('git_code_reviewer', false);
    } else {
      assert.equal(
        (
          await legacy.query(
            "select count(*)::int as count from pg_class where relnamespace='public'::regnamespace",
          )
        ).rows[0].count,
        0,
      );
    }
  } finally {
    await legacy.end();
  }
  if (kind === 'existing') {
    await stop(current);
    await start(true);
    assert.deepEqual(await applicationSnapshot('git_code_reviewer'), legacySnapshot);
  }
  await apply('--inspect');
  const provisioned = await apply('--apply');
  const migrator = pool('gcr_migrator', 'git_code_reviewer', true, true);
  try {
    await runMigrations(migrator);
  } finally {
    await migrator.end();
  }
  if (kind === 'existing') assert.deepEqual(await applicationSnapshot(), legacySnapshot);
  else
    await query(
      'gcr_app',
      'git_code_reviewer',
      "insert into users(oidc_subject,display_name,role) values ('new-fixture','New fixture','reviewer')",
      true,
      true,
    );
  await query(
    'gcr_keycloak',
    'git_code_reviewer_keycloak',
    "create table identity_fixture(id bigint generated always as identity primary key,marker text); insert into identity_fixture(marker) values ('preserved')",
  );
  await isolation();
  const before = await completeSnapshot();
  await stop(current);
  const restarted = await start(true);
  assert.deepEqual(await completeSnapshot(), before);
  await isolation();
  const startup = await exec('docker', ['logs', current], { timeout: 15_000 });
  assert.match(startup.stdout + startup.stderr, /Deploying PostgreSQL with persisted data/);
  await apply('--apply');
  assert.deepEqual(await completeSnapshot(), before);
  await isolation();
  await stop(current);
  progress(`${kind}: persistence and repeat provisioning passed`);
  assert.equal(new Set(ids).size, ids.length);
  return {
    kind,
    initial,
    restarted,
    distinctContainerIds: ids,
    applicationBeforeProvisioning: legacySnapshot,
    preserved: before,
    repeatApply: true,
    isolationAfterRestartAndRepeatApply: true,
    connectionBudget: provisioned.limits,
    syntheticIdentityData: true,
    nonRootReadOnlyCertificateCopy: true,
  };
}

try {
  const input = path.join(directory, 'input'),
    configuration = path.join(directory, 'configuration');
  await mkdir(input, { mode: 0o755 });
  await mkdir(configuration, { mode: 0o755 });
  const caConfig = await privateFile(
    'ca.cnf',
    '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=GCR PostgreSQL persistence fixture\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n',
  );
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
    path.join(directory, 'ca.key'),
    '-out',
    path.join(input, 'ca.crt'),
  ]);
  await exec('openssl', [
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=database.invalid',
    '-keyout',
    path.join(input, 'tls.key'),
    '-out',
    path.join(directory, 'leaf.csr'),
  ]);
  const leaf = await privateFile(
    'leaf.cnf',
    'basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n',
  );
  await exec('openssl', [
    'x509',
    '-req',
    '-in',
    path.join(directory, 'leaf.csr'),
    '-CA',
    path.join(input, 'ca.crt'),
    '-CAkey',
    path.join(directory, 'ca.key'),
    '-CAcreateserial',
    '-days',
    '1',
    '-extfile',
    leaf,
    '-out',
    path.join(input, 'tls.crt'),
  ]);
  await chmod(path.join(input, 'tls.key'), 0o644); // Only the init container can reach the private parent directory.
  await writeFile(
    path.join(configuration, 'pg_hba.conf'),
    'local all all trust\nhostssl all all 0.0.0.0/0 scram-sha-256\nhostssl all all ::0/0 scram-sha-256\nhostnossl all all 0.0.0.0/0 reject\nhostnossl all all ::0/0 reject\n',
  );
  const ca = await readFile(path.join(input, 'ca.crt'), 'utf8');
  report.scriptSha256 = hash(await readFile(new URL(import.meta.url), 'utf8'));
  report.imageStartupScriptSha256 = (
    await docker([
      'run',
      '--rm',
      '--pull=never',
      '--platform',
      'linux/amd64',
      '--entrypoint',
      'sha256sum',
      image,
      '/opt/bitnami/scripts/libpostgresql.sh',
    ])
  ).split(/\s/)[0];
  for (const kind of ['empty', 'existing'])
    report.cases.push(await scenario(kind, ca, input, configuration));
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = redact(error?.message ?? 'PostgreSQL persistence fixture failed').slice(0, 6000);
  report.containerDiagnostics = [];
  for (const name of ownedContainers) {
    const logs = await exec('docker', ['logs', '--tail', '20', name], { timeout: 15_000 }).catch(
      () => undefined,
    );
    if (logs) report.containerDiagnostics.push({ name, tail: redact(logs.stdout + logs.stderr) });
  }
  process.exitCode = 1;
} finally {
  const containers = (await docker(['ps', '-aq', '--filter', `label=${label}`]))
    .split('\n')
    .filter(Boolean);
  for (const name of containers) {
    const actual = await docker([
      'inspect',
      '--format',
      '{{ index .Config.Labels "gcr.fixture.id" }}',
      name,
    ]);
    assert.equal(actual, identifier);
    await docker(['rm', '-f', '-v', name]);
  }
  const volumes = (await docker(['volume', 'ls', '-q', '--filter', `label=${label}`]))
    .split('\n')
    .filter(Boolean);
  for (const volume of volumes) {
    const actual = await docker([
      'volume',
      'inspect',
      '--format',
      '{{ index .Labels "gcr.fixture.id" }}',
      volume,
    ]);
    assert.equal(actual, identifier);
    await docker(['volume', 'rm', volume]);
  }
  await rm(directory, { recursive: true, force: true });
  report.ownedResourcesRemoved = true;
  report.finishedAt = new Date().toISOString();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
