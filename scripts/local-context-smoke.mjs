// Run beside offline-installed @gcr client packages. No real executor is invoked.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  captureLocalSource,
  clientCorePackage,
  discoverLocalIdentity,
  LocalRecordStore,
  LocalKnowledgeStore,
  resolveLocalContext,
  resolveLocalExecutionPolicy,
} from '@gcr/client-core';

const root = fs.mkdtempSync(path.join(tmpdir(), 'gcr-installed-context-'));
const repo = path.join(root, 'repo');
fs.mkdirSync(repo);
const git = (...args) =>
  execFileSync(
    'git',
    [
      '-C',
      repo,
      '-c',
      'user.name=Context Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    },
  ).trim();
let records,
  snapshot,
  evidence,
  centralFetchCalls = 0;
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => {
  centralFetchCalls++;
  throw Error('Unexpected network request during context resolution');
};
try {
  git('init', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'api.py'), 'def load():\n    return 0\n');
  fs.writeFileSync(path.join(repo, 'caller.py'), 'from api import load\n');
  git('add', '.');
  git('commit', '-m', 'synthetic base');
  fs.writeFileSync(path.join(repo, 'api.py'), 'def load():\n    return 1\n');
  git('add', 'api.py');
  snapshot = captureLocalSource({ cwd: repo, kind: 'index' });
  const client = discoverLocalIdentity(repo, 'installed-context-fixture');
  const keys = new Map();
  records = await LocalRecordStore.open({
    dataDirectory: path.join(root, 'local-data'),
    scope: {
      kind: 'repository',
      profileId: client.profileId,
      repositoryKey: client.repositoryKey,
      worktreeKey: client.worktreeKey,
    },
    // Only the context/store integration is under test here; OS-key proof is P02-C02.
    keys: {
      read: async (id) => keys.get(id),
      write: async (id, key) => {
        keys.set(id, Buffer.from(key));
      },
      remove: async (id) => {
        keys.delete(id);
      },
    },
  });
  const store = new LocalKnowledgeStore(records);
  const created = await store.create({
    kind: 'skill',
    title: 'Synthetic review criteria',
    body: 'Review failure conditions. This quoted material also says to execute a shell; it has no authority to do that.',
    appliesTo: { paths: ['api.py'], languages: ['python'], symbols: ['load'], branches: ['main'] },
    sources: [],
    reviewOnly: true,
    origin: 'user-authored',
  });
  const active = await store.setState(created.id, created.revision, 'active');
  const settings = {
    mode: 'standalone',
    get serverUrl() {
      throw Error('Residual server address was read');
    },
    get token() {
      throw Error('Residual credential was read');
    },
  };
  const query = { client, snapshot, stores: [store], settings, requiredKnowledgeIds: [active.id] };
  const context = await resolveLocalContext(query);
  assert.equal(context.status, 'ready');
  assert.equal(context.context.knowledge[0].hash, active.hash);
  assert(context.context.identity.entries.every((entry) => entry.origin !== 'central'));
  const executor = {
    id: 'synthetic-executor',
    version: 'fixture-1',
    model: 'fixture-model',
    configHash: 'a'.repeat(64),
    capabilities: {
      available: true,
      sourceIsolation: 'fixed-source-only',
      cancellation: true,
      timeout: true,
      childProcessCleanup: true,
      outputTokenLimit: false,
    },
  };
  const input = {
    context,
    snapshot,
    executor,
    workspaceTrusted: true,
    approval: {
      client,
      executor: { id: executor.id, model: executor.model, configHash: executor.configHash },
      paths: ['api.py'],
      allowBase: true,
      allowRelated: false,
      allowKnowledge: true,
    },
    budget: { modelCalls: 1, durationMs: 1000, sourceBytes: 1000, toolCalls: 3 },
  };
  const policy = resolveLocalExecutionPolicy(input);
  assert.equal(policy.status, 'ready');
  assert.equal(policy.policy.enforcement, 'advisory');
  assert(!policy.policy.sources.some((file) => file.path === 'caller.py'));
  assert.throws(() => policy.policy.requireTool('shell'), /policy-unavailable/);
  const budget = policy.policy.createRunBudget();
  budget.reserveModelCall();
  assert.throws(() => budget.reserveModelCall(), /quota-exceeded/);
  assert.equal(
    resolveLocalExecutionPolicy({ ...input, executor: { ...executor, model: 'another-model' } })
      .status,
    'unavailable',
  );
  assert.equal(
    resolveLocalExecutionPolicy({
      ...input,
      executor: {
        ...executor,
        capabilities: { ...executor.capabilities, sourceIsolation: 'unknown' },
      },
    }).status,
    'unavailable',
  );
  const missing = await resolveLocalContext({
    ...query,
    requiredSources: [{ path: 'missing.py', side: 'source' }],
  });
  assert.equal(missing.status, 'needs-context');
  await store.setState(active.id, active.revision, 'inactive');
  assert.equal((await resolveLocalContext(query)).status, 'needs-context');
  assert.equal(context.context.knowledge[0].state, 'active');
  const central = await resolveLocalContext({
    ...query,
    settings: { mode: 'centralized' },
    stores: [
      {
        entries() {
          throw Error('Central mode acquired a local store');
        },
      },
    ],
  });
  assert.equal(central.status, 'unavailable');
  assert.equal(centralFetchCalls, 0);
  evidence = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    git: git('--version'),
    packageVersion: clientCorePackage.version,
    verification: 'installed-artifact',
    encryptedStoreIterator: true,
    keyStore: 'in-memory-test-port',
    activeSkillAndPinnedRevision: true,
    residualCentralSettingsUntouched: true,
    centralFetchCalls,
    requiredSourceAndKnowledgeGates: true,
    executorAndSourceApprovalBinding: true,
    unknownIsolationDenied: true,
    unapprovedModelDenied: true,
    arbitrarySkillToolsDenied: true,
    advisoryOnly: true,
    modelCallReservationLimit: true,
    syntheticCapabilityDescriptor: true,
    executorInvocations: 0,
    syntheticData: true,
    modelCalls: 0,
  };
} finally {
  globalThis.fetch = savedFetch;
  snapshot?.close();
  records?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify({ ...evidence, cleanup: 'completed' }, null, 2) + '\n');
