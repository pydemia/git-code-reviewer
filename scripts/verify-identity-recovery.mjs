// App-database recovery rehearsal with synthetic data. Run only inside the
// owned native PostgreSQL harness. No operational DB or Keycloak is contacted.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createDatabase, runMigrations } from '../packages/db/dist/index.js';
import {
  beginSamlLogin,
  consumeSamlLogin,
  linkExistingSamlIdentity,
  persistentNameId,
} from '../apps/runtime/dist/auth/saml-state.js';
import {
  requestIdentityLifecycle,
  identityLifecycleTransaction,
} from '../apps/runtime/dist/identity/lifecycle.js';
import { revokeUserIdentitySecurity } from '../apps/runtime/dist/identity/revocation.js';
import { buildServer } from '../apps/runtime/dist/server.js';
import { loadConfig } from '../apps/runtime/dist/config.js';
import {
  hashLocalPassword,
  verifyLocalPassword,
} from '../apps/runtime/dist/services/local-accounts.js';
import { certificate, idpMetadata } from './saml-contract-fixtures.mjs';

const exec = promisify(execFile);
const sourceUrl = new URL(process.env.GCR_TEST_DATABASE_URL ?? 'http://invalid');
const nativeData = process.env.GCR_TEST_POSTGRES_DIRECTORY;
const bin = process.env.GCR_TEST_POSTGRES_BIN;
assert(sourceUrl.protocol === 'postgresql:' && sourceUrl.hostname === '127.0.0.1');
assert(nativeData && bin && path.isAbsolute(bin));
const marker = JSON.parse(
  await readFile(path.join(path.dirname(nativeData), 'owner.json'), 'utf8'),
);
assert.equal(marker.data, nativeData);
assert(path.basename(path.dirname(nativeData)).startsWith('gcr-native-pg-'));
const admin = createDatabase(sourceUrl.href);
assert.equal(
  await realpath((await admin.query('show data_directory')).rows[0].data_directory),
  await realpath(nativeData),
);
const directory = await mkdtemp(path.join(tmpdir(), 'gcr-identity-recovery-'));
const names = [],
  pools = [],
  apps = [];
const evidence = {
  startedAt: new Date().toISOString(),
  node: process.version,
  postgres: (await admin.query('show server_version')).rows[0].server_version,
  checks: [],
  cleanup: false,
  realKeycloak: false,
  operationalChanges: false,
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const check = (name) => evidence.checks.push(name);
const stage = (name) => {
  evidence.lastStep = name;
};
const environment = {
  ...process.env,
  PGHOST: sourceUrl.hostname,
  PGPORT: sourceUrl.port,
  PGUSER: decodeURIComponent(sourceUrl.username),
  PGPASSWORD: decodeURIComponent(sourceUrl.password),
};
const binding = {
  issuer: 'https://identity.example.test/realms/recovery',
  entityId: 'https://gcr.example.test/auth/saml/metadata',
  acsUrl: 'https://gcr.example.test/auth/saml/acs',
  sloUrl: 'https://gcr.example.test/auth/saml/slo',
};
async function freshDatabase() {
  const name = `gcr_recovery_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create database ${name}`);
  names.push(name);
  const url = new URL(sourceUrl);
  url.pathname = '/' + name;
  const database = createDatabase(url.href);
  pools.push(database);
  return { name, database, url: url.href };
}
const disable = (userId, expectedSubject) => ({
  kind: 'disable',
  requestId: randomUUID(),
  target: { kind: 'existing', userId, expectedSubject },
  revokeAllSessions: true,
});
async function restoredApplication(database) {
  const sp = await certificate(directory, 'recovery-sp');
  const idp = await certificate(directory, 'recovery-idp');
  const protocol = {
    acs: binding.acsUrl,
    slo: binding.sloUrl,
    entityId: binding.entityId,
    idpIssuer: binding.issuer,
    entryPoint: binding.issuer + '/protocol/saml',
    privateKey: sp.key,
    publicCert: sp.cert,
    idpCerts: [idp.cert],
  };
  const metadataFile = path.join(directory, 'idp.xml');
  await writeFile(metadataFile, idpMetadata(protocol, [idp.cert]), { mode: 0o600 });
  await writeFile(
    path.join(directory, 'index.html'),
    '<!doctype html><title>Recovery fixture</title>',
  );
  const config = loadConfig({
    DATABASE_URL: database.url,
    AUTH_MODE: 'saml',
    NODE_ENV: 'production',
    GITHUB_MODE: 'disabled',
    PUBLIC_BASE_URL: new URL(binding.entityId).origin,
    SESSION_SECRET: randomBytes(32).toString('hex'),
    AUTO_JOIN_DEFAULT_TENANT: 'false',
    WEB_DIST: directory,
    ARTIFACT_ROOT: path.join(directory, 'artifacts'),
    SAML_IDP_ISSUER: binding.issuer,
    SAML_IDP_ENTRY_POINT: protocol.entryPoint,
    SAML_IDP_METADATA_URL: binding.issuer + '/descriptor',
    SAML_IDP_METADATA_FILE: metadataFile,
    SAML_PRIVATE_KEY_FILE: sp.keyPath,
    SAML_PUBLIC_CERT_FILE: sp.certPath,
  });
  const app = await buildServer(config);
  apps.push(app);
  await app.ready();
  return app;
}
const preservedTables = [
  'users',
  'local_credentials',
  'tenant_memberships',
  'repository_grants',
  'review_memories',
  'analysis_runs',
  'reports',
];
const snapshot = async (database, tables) =>
  Object.fromEntries(
    await Promise.all(
      tables.map(async (table) => [
        table,
        (
          await database.query(
            `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) as data from ${table} t`,
          )
        ).rows[0].data,
      ]),
    ),
  );
const restore = (name, bytes) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      path.join(bin, 'pg_restore'),
      ['--exit-on-error', '--clean', '--if-exists', '--no-owner', '--no-acl', '--dbname', name],
      {
        env: environment,
        stdio: ['pipe', 'ignore', 'pipe'],
        timeout: 30_000,
        killSignal: 'SIGKILL',
      },
    );
    // Never expose SQL or a backup through child error output.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(Error('RESTORE_FAILED'))));
    child.stdin.end(bytes);
  });
try {
  stage('seed-owned-source-database');
  const original = await freshDatabase();
  await runMigrations(original.database);
  const owner = (
    await original.database.query(
      "insert into users(oidc_subject,display_name,role) values('recovery-admin','Recovery Admin','administrator') returning id",
    )
  ).rows[0].id;
  const user = (
    await original.database.query(
      "insert into users(oidc_subject,display_name,role,groups_json,personal_prompt) values('preserved-reviewer','Original Reviewer','reviewer','[\"engineering\"]','Original personal prompt') returning id",
    )
  ).rows[0].id;
  const localPassword = randomBytes(24).toString('base64url');
  await original.database.query(
    "insert into local_credentials(user_id,username,password_hash) values($1,'original-reviewer',$2)",
    [user, await hashLocalPassword(localPassword)],
  );
  const legacySession = randomBytes(32).toString('base64url');
  await original.database.query(
    "insert into user_sessions(id_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 hour')",
    [hash(legacySession), user],
  );
  const tenant = (await original.database.query("select id from tenants where slug='default'"))
    .rows[0].id;
  const instance = (
    await original.database.query(
      "insert into github_instances(name,api_base_url,web_base_url) values('Fixture','https://github.example.test/api','https://github.example.test') returning id",
    )
  ).rows[0].id;
  const repo = (
    await original.database.query(
      "insert into repositories(instance_id,github_id,installation_id,owner,name,tenant_id) values($1,1,'1','fixture','repo',$2) returning id",
      [instance, tenant],
    )
  ).rows[0].id;
  await original.database.query('insert into tenant_memberships(tenant_id,user_id) values($1,$2)', [
    tenant,
    user,
  ]);
  await original.database.query(
    "insert into repository_grants(repository_id,subject_or_group,role) values($1,'preserved-reviewer','reviewer')",
    [repo],
  );
  await original.database.query(
    "insert into review_memories(tenant_id,repository_id,scope,owner_user_id,kind,state,summary,search_text,aggregation_key,content_hash,source_kind) values($1,$2,'personal',$3,'decision','candidate','Original memory','original',$4,$5,'manual')",
    [tenant, repo, user, hash('aggregate'), hash('content')],
  );
  const pr = (
    await original.database.query(
      "insert into pull_requests(repository_id,github_id,number,title,state,author_login,html_url,base_ref,base_sha,head_ref,head_sha,github_updated_at) values($1,1,1,'Preserved review','open','fixture','https://github.example.test/fixture/repo/pull/1','main',$2,'feature',$3,clock_timestamp()) returning id",
      [repo, 'a'.repeat(40), 'b'.repeat(40)],
    )
  ).rows[0].id;
  const request = (
    await original.database.query(
      "insert into snapshot_requests(pull_request_id,base_sha,head_sha,state) values($1,$2,$3,'materialized') returning id",
      [pr, 'a'.repeat(40), 'b'.repeat(40)],
    )
  ).rows[0].id;
  const source = (
    await original.database.query(
      "insert into snapshots(request_id,version,resolution,policy_version) values($1,1,'exact','recovery-fixture') returning id",
      [request],
    )
  ).rows[0].id;
  const analysis = (
    await original.database.query(
      "insert into analysis_runs(snapshot_id,analysis_key,state,progress) values($1,'recovery-analysis','completed',100) returning id",
      [source],
    )
  ).rows[0].id;
  await original.database.query(
    "insert into reports(analysis_run_id,schema_version,grade,summary,has_critical_findings,coverage,impact) values($1,1,'adequate','Preserved report',false,'{}','{}')",
    [analysis],
  );
  const identity = {
    issuer: binding.issuer,
    entityId: binding.entityId,
    nameID: `G-${randomUUID()}`,
    nameIDFormat: persistentNameId,
    nameQualifier: binding.issuer,
    spNameQualifier: binding.entityId,
  };
  const identityId = await linkExistingSamlIdentity(original.database, binding, {
    actorId: owner,
    userId: user,
    expectedSubject: 'preserved-reviewer',
    keycloakUserId: randomUUID(),
    identity,
  });
  await original.database.query(
    "update user_identities set provisioning_state='provisioned',enabled=true,identity_verified_at=clock_timestamp(),security_checked_at=statement_timestamp(),security_fresh_until=statement_timestamp()+interval '5 minutes' where id=$1",
    [identityId],
  );
  const login = await beginSamlLogin(original.database, binding, '/worklist');
  const verified = {
    ...identity,
    requestId: login.requestId,
    responseId: `_${randomUUID()}`,
    assertionId: `_${randomUUID()}`,
    sessionIndex: randomUUID(),
    sessionExpiresAt: Date.now() + 240_000,
  };
  const session = await consumeSamlLogin(original.database, binding, login, verified);
  const pending = await beginSamlLogin(original.database, binding, '/worklist');
  const oldState = await snapshot(original.database, [
    ...preservedTables,
    'user_identities',
    'schema_migrations',
    'user_sessions',
    'saml_transactions',
  ]);
  stage('encrypted-logical-backup');
  const dump = (
    await exec(
      path.join(bin, 'pg_dump'),
      ['--format=custom', '--no-owner', '--no-acl', '--dbname', original.name],
      { env: environment, encoding: 'buffer', maxBuffer: 8 * 1024 ** 2, timeout: 30_000 },
    )
  ).stdout;
  const key = randomBytes(32),
    nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(dump), cipher.final()]),
    tag = cipher.getAuthTag();
  const backupFile = path.join(directory, 'application.dump.aesgcm');
  await writeFile(backupFile, Buffer.concat([nonce, tag, encrypted]), { mode: 0o600, flag: 'wx' });
  evidence.backupSha256 = hash(await readFile(backupFile));
  const decrypt = (bytes) => {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  };
  const damaged = Buffer.from(await readFile(backupFile));
  damaged[damaged.length - 1] ^= 1;
  assert.throws(() => decrypt(damaged));
  check('encrypted-pg-dump-authentication-rejects-tampered-backup-before-restore');
  // Simulates a known security decision recorded after the backup. It must be
  // obtained outside the restored copy; the old copy cannot tell us it existed.
  stage('record-post-backup-block-outside-restore');
  await requestIdentityLifecycle(
    original.database,
    binding,
    owner,
    disable(user, 'preserved-reviewer'),
  );
  const currentBlock = (
    await original.database.query('select id,oidc_subject,enabled from users where id=$1', [user])
  ).rows[0];
  assert.equal(currentBlock.enabled, false);
  const currentSource = await snapshot(original.database, [
    ...preservedTables,
    'user_identities',
    'user_client_credential_epochs',
  ]);
  stage('restore-into-another-owned-database');
  const restored = await freshDatabase();
  const plaintext = decrypt(await readFile(backupFile));
  assert.equal(hash(plaintext), hash(dump));
  await restore(restored.name, plaintext);
  plaintext.fill(0);
  dump.fill(0);
  key.fill(0);
  assert.deepEqual(await snapshot(restored.database, Object.keys(oldState)), oldState);
  check(
    'actual-pg-restore-preserves-user-owner-grants-memory-analysis-report-and-all-migration-checksums',
  );
  const restoredMapping = {
    actorId: owner,
    userId: user,
    expectedSubject: 'preserved-reviewer',
    keycloakUserId: oldState.user_identities[0].keycloak_user_id,
    identity,
  };
  assert.equal(
    await linkExistingSamlIdentity(restored.database, binding, restoredMapping),
    identityId,
  );
  await assert.rejects(
    () =>
      linkExistingSamlIdentity(restored.database, binding, {
        ...restoredMapping,
        userId: owner,
        expectedSubject: 'recovery-admin',
      }),
    { code: 'SAML_MAPPING_CONFLICT' },
  );
  await assert.rejects(
    () =>
      linkExistingSamlIdentity(restored.database, binding, {
        ...restoredMapping,
        keycloakUserId: randomUUID(),
      }),
    { code: 'SAML_MAPPING_CONFLICT' },
  );
  check('restored-mapping-is-idempotent-and-refuses-another-app-owner-or-recreated-idp-user');
  assert.equal(
    (await restored.database.query('select enabled from users where id=$1', [user])).rows[0]
      .enabled,
    true,
  );
  assert.equal(
    (
      await restored.database.query(
        'select count(*)::int as count from user_sessions where id_hash=$1',
        [hash(session.sessionToken)],
      )
    ).rows[0].count,
    1,
  );
  stage('restored-application-authentication');
  const app = await restoredApplication(restored);
  const me = (token) =>
    app.inject({ url: '/api/v1/me', headers: { cookie: `gcr_session=${token}` } });
  const unsealed = await me(session.sessionToken);
  assert.equal(unsealed.statusCode, 200);
  assert.equal(unsealed.json().id, user);
  check('unsealed-restore-demonstrates-old-session-and-pre-block-account-state-return');
  assert.equal(
    await verifyLocalPassword(localPassword, oldState.local_credentials[0].password_hash),
    true,
  );
  assert.equal((await me(legacySession)).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/auth/local/login',
        headers: { origin: new URL(binding.entityId).origin },
        payload: { username: 'original-reviewer', password: localPassword },
      })
    ).statusCode,
    404,
  );
  check('restored-valid-local-password-and-legacy-session-cannot-bypass-saml-mode');
  stage('reconcile-known-block-and-revoke-restored-auth-state');
  // Maintenance remains closed throughout. Reapply the external decision via
  // the existing checked lifecycle path; never match users by email or rename.
  await assert.rejects(
    () =>
      requestIdentityLifecycle(restored.database, binding, owner, disable(user, 'different-owner')),
    { code: 'IDENTITY_OPERATION_CONFLICT' },
  );
  assert.equal(
    (await restored.database.query('select enabled from users where id=$1', [user])).rows[0]
      .enabled,
    true,
  );
  await requestIdentityLifecycle(
    restored.database,
    binding,
    owner,
    disable(currentBlock.id, currentBlock.oidc_subject),
  );
  await identityLifecycleTransaction(restored.database, async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext('gcr:user-administration'))");
    const users = (await client.query('select id from users order by id for update')).rows;
    for (const entry of users) await revokeUserIdentitySecurity(client, entry.id);
    await client.query('delete from auth_transactions');
    await client.query('delete from saml_transactions');
  });
  assert.equal(
    (await restored.database.query('select count(*)::int as count from user_sessions')).rows[0]
      .count,
    0,
  );
  assert.equal(
    (await restored.database.query('select count(*)::int as count from saml_transactions')).rows[0]
      .count,
    0,
  );
  await assert.rejects(
    () =>
      consumeSamlLogin(restored.database, binding, pending, {
        ...verified,
        requestId: pending.requestId,
        responseId: `_${randomUUID()}`,
        assertionId: `_${randomUUID()}`,
      }),
    { code: 'SAML_TRANSACTION_INVALID' },
  );
  assert.equal((await me(session.sessionToken)).statusCode, 401);
  const blocked = (
    await restored.database.query(
      'select u.enabled as user_enabled,i.enabled,i.security_fresh_until,i.idp_disabled_by_gcr,i.security_epoch from users u join user_identities i on i.user_id=u.id where u.id=$1',
      [user],
    )
  ).rows[0];
  assert.equal(blocked.user_enabled, false);
  assert.equal(blocked.enabled, false);
  assert.equal(blocked.security_fresh_until, null);
  assert.equal(blocked.idp_disabled_by_gcr, true);
  assert(Number(blocked.security_epoch) > Number(oldState.user_identities[0].security_epoch));
  assert.equal(
    (
      await restored.database.query(
        'select count(*)::int as count from user_client_credential_epochs',
      )
    ).rows[0].count,
    2,
  );
  assert.equal(
    (
      await restored.database.query(
        'select count(*)::int as count from identity_security_logout_outbox',
      )
    ).rows[0].count,
    1,
  );
  check(
    'restored-session-and-authn-request-revoked-known-block-preserved-and-remote-logout-durable',
  );
  const after = await snapshot(
    restored.database,
    preservedTables.filter((table) => table !== 'users'),
  );
  for (const [table, rows] of Object.entries(after)) assert.deepEqual(rows, oldState[table]);
  const restoredUsers = (await snapshot(restored.database, ['users'])).users;
  const stableUser = (row) =>
    Object.fromEntries(
      Object.entries(row).filter(([key]) => !['enabled', 'updated_at'].includes(key)),
    );
  for (const row of restoredUsers)
    assert.deepEqual(stableUser(row), stableUser(oldState.users.find((old) => old.id === row.id)));
  assert.deepEqual(await snapshot(original.database, Object.keys(currentSource)), currentSource);
  check(
    'auth-recovery-keeps-repository-permissions-personal-data-and-review-history-without-rolling-back-source-database',
  );
  evidence.success = true;
  evidence.preservedRowCounts = Object.fromEntries(
    preservedTables.map((table) => [table, oldState[table].length]),
  );
  evidence.migrations = oldState.schema_migrations.length;
  evidence.limitations = [
    'No Keycloak DB, IdP session, SMTP, browser or production storage restore was exercised.',
    'A known post-backup block was obtained from the separate source fixture. Unknown or unavailable security history must keep operational authentication closed.',
    'P04 access/refresh/API-key implementations do not yet exist; this verifies only their durable revocation epoch port.',
    'This native PostgreSQL fixture does not prove the pinned PostgreSQL 17 container, DBA ACL or shared-instance restore gate.',
  ];
} catch (error) {
  evidence.success = false;
  evidence.failureType = error.name;
  if (typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code))
    evidence.failureCode = error.code;
  process.exitCode = 1;
} finally {
  for (const app of apps) await app.close();
  for (const pool of pools) await pool.end();
  for (const name of names) {
    assert(/^gcr_recovery_[a-f0-9]{32}$/.test(name));
    await admin.query(`drop database ${name}`);
  }
  await admin.end();
  await rm(directory, { recursive: true, force: true });
  evidence.cleanup = true;
  evidence.finishedAt = new Date().toISOString();
  const output = process.env.GCR_IDENTITY_RECOVERY_EVIDENCE;
  if (output) {
    assert(path.isAbsolute(output));
    await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  console.log(JSON.stringify(evidence, null, 2));
}
