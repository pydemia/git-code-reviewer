// Copy beside a clean consumer's node_modules. Runs pinned packages, never a real model.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '@gcr/client-core';
import * as executors from '@gcr/client-executors';

assert.equal(process.platform, 'darwin');
const executorEntry = import.meta.resolve('@gcr/client-executors');
const processModule = new URL('./process.js', executorEntry);
const isolationModule = new URL('./codex-isolation.js', executorEntry);
const { runManagedProcess } = await import(processModule.href);
const { runIsolatedCodex } = await import(isolationModule.href);
const root = await mkdtemp(path.join(os.tmpdir(), 'gcr-w04-macos-'));
const native = new core.PlatformLocalKeyStore(`com.commitdefender.w04.${randomUUID()}`);
const refs = new Set();
const keys = {
  read: (id) => native.read(id),
  write: async (id, bytes) => {
    refs.add(id);
    await native.write(id, bytes);
  },
  remove: (id) => native.remove(id),
};
const reader = new core.PlatformCentralCredentialStore();
const readerRef = `w04-macos-${randomUUID()}`;
const report = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  core: core.clientCorePackage.version,
  executors: executors.clientExecutorsPackage.version,
  realKeychain: true,
  realModelCalls: 0,
  productionRequests: 0,
  checks: [],
  moduleHashes: {},
};
for (const url of [
  import.meta.resolve('@gcr/client-core'),
  executorEntry,
  processModule,
  isolationModule,
]) {
  report.moduleHashes[fileURLToPath(url)] = createHash('sha256')
    .update(await readFile(new URL(url)))
    .digest('hex');
}
let records, service;
try {
  const scope = { kind: 'profile', profileId: `w04-${randomUUID()}` };
  const options = { dataDirectory: path.join(root, 'data'), scope, keys };
  records = await core.LocalRecordStore.open(options);
  await records.write('settings', 'fixture', { synthetic: true }, 0);
  records.close();
  records = await core.LocalRecordStore.open(options);
  assert.deepEqual((await records.read('settings', 'fixture')).value, { synthetic: true });
  const blobs = path.join(
    options.dataDirectory,
    'profiles',
    scope.profileId,
    'local',
    'profile',
    'settings',
    'fixture',
    'blobs',
  );
  const blob = path.join(blobs, (await readdir(blobs))[0]);
  const original = await readFile(blob);
  const changed = Buffer.from(original);
  changed[changed.length - 1] ^= 1;
  await writeFile(blob, changed);
  await assert.rejects(records.read('settings', 'fixture'), { code: 'corrupt-storage' });
  await writeFile(blob, original);
  assert.deepEqual((await records.read('settings', 'fixture')).value, { synthetic: true });
  records.close();
  records = undefined;
  const keyRefFile = path.join(
    options.dataDirectory,
    'profiles',
    scope.profileId,
    'local',
    'key-ref.json',
  );
  const metadata = JSON.parse(await readFile(keyRefFile, 'utf8'));
  const reference = `${scope.profileId}.${metadata.id}`;
  await native.remove(reference);
  assert.equal(await native.read(reference), undefined);
  await assert.rejects(core.LocalRecordStore.open(options), { code: 'credential-unavailable' });
  assert.equal(await native.read(reference), undefined);
  report.checks.push(
    'Keychain-backed persistence, corrupt ciphertext rejection, missing-key rejection without regeneration',
  );

  const secret = `gcr_key_${randomUUID()}_${randomBytes(32).toString('base64url')}`;
  await reader.write(readerRef, secret);
  assert.equal(await new core.PlatformCentralCredentialStore().read(readerRef), secret);
  await reader.remove(readerRef);
  assert.equal(await reader.read(readerRef), undefined);
  report.checks.push('actual Keychain reader credential write/reopen/delete');

  const location = {
    profileId: `w04-service-${randomUUID()}`,
    dataDirectory: path.join(root, 'service'),
  };
  const serviceOptions = {
    ...location,
    keys,
    run: async () => {
      throw Error('No model execution authorized');
    },
  };
  service = await core.startLocalService(serviceOptions);
  const address = service.address;
  const stat = await lstat(address);
  assert(stat.isSocket());
  assert.equal(stat.uid, process.getuid());
  assert.equal(stat.mode & 0o077, 0);
  assert.equal((await core.callLocalService(location, { action: 'status' })).status, 'running');
  await assert.rejects(core.startLocalService(serviceOptions));
  assert.equal((await core.callLocalService(location, { action: 'status' })).status, 'running');
  await core.callLocalService(location, { action: 'stop' });
  assert.equal((await service.closed).problem, null);
  service = undefined;
  await assert.rejects(lstat(address), { code: 'ENOENT' });
  service = await core.startLocalService(serviceOptions);
  assert.equal((await core.callLocalService(location, { action: 'status' })).status, 'running');
  await service.close();
  assert.equal((await service.closed).problem, null);
  service = undefined;
  await assert.rejects(lstat(address), { code: 'ENOENT' });
  report.checks.push(
    'frozen core Unix socket private ownership, duplicate owner denial, stop/restart/close with real Keychain',
  );

  const env = { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: root };
  await writeFile(path.join(root, 'AGENTS.md'), 'PRIVATE_MARKER', { mode: 0o600 });
  await writeFile(path.join(root, 'AGENTS.override.md'), 'PRIVATE_OVERRIDE', { mode: 0o600 });
  await writeFile(path.join(root, 'auth.json'), 'synthetic-auth', { mode: 0o600 });
  const isolated = await runIsolatedCodex({
    command: process.execPath,
    args: [
      '-e',
      "const fs=require('fs');for(const f of ['AGENTS.md','AGENTS.override.md']){try{fs.readFileSync(f);process.exit(3)}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;}}process.stdout.write(fs.readFileSync('auth.json'))",
    ],
    cwd: root,
    env,
    stdin: '',
    timeoutMs: 5000,
  });
  assert.equal(isolated.code, 0);
  assert.equal(isolated.stdout, 'synthetic-auth');
  assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), 'PRIVATE_MARKER');
  await assert.rejects(
    runManagedProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: root,
      env,
      stdin: '',
      timeoutMs: 100,
    }),
    { code: 'timeout' },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runManagedProcess({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: root,
      env,
      stdin: '',
      timeoutMs: 1000,
      signal: controller.signal,
    }),
    { code: 'cancelled' },
  );
  report.checks.push(
    'frozen executor macOS sandbox instruction boundary, native timeout and cancelled status',
  );
} finally {
  records?.close();
  if (service) {
    await service.close();
    await service.closed;
  }
  await reader.remove(readerRef);
  assert.equal(await reader.read(readerRef), undefined);
  for (const reference of refs) {
    await native.remove(reference);
    assert.equal(await native.read(reference), undefined);
  }
  await rm(root, { recursive: true, force: true });
  await assert.rejects(lstat(root), { code: 'ENOENT' });
  report.cleanup = {
    temporaryRootRemoved: true,
    keychainReferencesRemoved: refs.size,
    readerCredentialRemoved: true,
    ownedServiceClosed: true,
  };
}
report.status = 'passed';
console.log(JSON.stringify(report, null, 2));
