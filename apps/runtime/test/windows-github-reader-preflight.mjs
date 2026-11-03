import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CentralConnections,
  PlatformCentralCredentialStore,
  PlatformLocalKeyStore,
} from '../../../packages/client-core/dist/index.js';
import { windowsPrivateTemporary } from '../../../packages/client-core/dist/windows-native.js';

const live = JSON.parse(await readFile('tmp/w02-live/connection.json', 'utf8'));
const root = windowsPrivateTemporary('w02-github-preflight-');
const profileId = 'w02-github-preflight-' + randomUUID();
const hash = (text) => createHash('sha256').update(text).digest('hex');
const scope = {
  kind: 'repository',
  profileId,
  repositoryKey: hash(profileId),
  worktreeKey: hash(root),
};
const proof = { platform: process.platform, modelCalls: 0, status: 'running' };
const open = () => CentralConnections.open({ scope, dataDirectory: root });
let manager = await open(),
  connectionId;
try {
  const secret = await new PlatformCentralCredentialStore().read(live.credentialReference);
  assert(secret);
  const result = await manager.connect(live.config, secret, 'commit-defender');
  connectionId = result.id;
  manager.close();
  manager = await open();
  const request = { kind: 'pulls', pullNumber: 3 };
  const online = await manager.readHistory(connectionId, request);
  const offline = await manager.readHistory(connectionId, request, 'offline');
  assert.deepEqual(offline.data, online.data);
  assert.equal(online.data.items.length, 1);
  assert.equal(online.data.items[0].number, 3);
  assert.equal(online.data.items[0].messageCount, 0);
  assert.equal(online.data.items[0].coverage.state, 'collected');
  proof.result = {
    credentialReopened: true,
    exactOnlineOffline: true,
    pullNumber: 3,
    coverage: online.data.items[0].coverage,
    messageCount: 0,
    revision: online.data.revision,
    originalSourceValidation: 'pending comment authorization',
  };
  proof.status = 'passed';
} finally {
  if (connectionId) await manager.disconnect(connectionId);
  manager.close();
  const keys = new PlatformLocalKeyStore();
  const cleanup = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink());
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await cleanup(file);
      else if (entry.name === 'key-ref.json') {
        const reference = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(reference.profileId, profileId);
        await keys.remove(`${profileId}.${reference.id}`);
      }
    }
  };
  await cleanup(root);
  assert(path.basename(root).startsWith('w02-github-preflight-'));
  await rm(root, { recursive: true, force: true });
  proof.temporaryProfileAndCredentialsRemoved = true;
  await writeFile('tmp/w02-live/reader-preflight.json', JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
}
