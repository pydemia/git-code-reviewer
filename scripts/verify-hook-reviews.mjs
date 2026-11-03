// Explicit real-account verification against an installed CLI artifact and local Git remote.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const consumer = process.env.GCR_HOOK_CONSUMER;
const executable = process.env.GCR_HOOK_CODEX;
const evidence = process.env.GCR_HOOK_EVIDENCE;
for (const value of [consumer, executable, evidence]) assert(value && path.isAbsolute(value));
const core = await import(
  pathToFileURL(path.join(consumer, 'node_modules/@gcr/client-core/dist/index.js')).href
);
const cli = path.join(consumer, 'node_modules/@gcr/cli/dist/main.js');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'gcr-hook-live-'));
const repo = path.join(temporary, 'repo'),
  hooks = path.join(temporary, 'hooks');
const profileId = `gcr-hook-${randomUUID()}`;
const proof = {
  status: 'running',
  profileId,
  model: 'gpt-6-astra',
  reasoningEffort: 'xhigh',
  events: [],
};
await writeFile(evidence, '', { flag: 'wx', mode: 0o600 });
const checkpoint = () =>
  writeFile(evidence, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
const git = (...args) =>
  execFileSync(
    'git',
    [
      '-C',
      repo,
      '-c',
      `core.hooksPath=${hooks}`,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 300000,
      env: {
        ...process.env,
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_INDEX_FILE: undefined,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        ...(process.env.NODE_EXTRA_CA_CERTS
          ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }
          : {}),
      },
    },
  ).trim();
const command = (action) =>
  [
    process.execPath,
    cli,
    action,
    '--cwd',
    repo,
    '--profile',
    profileId,
    '--executor-path',
    executable,
    '--model',
    'gpt-6-astra',
    '--reasoning-effort',
    'xhigh',
    '--timeout-ms',
    '240000',
  ]
    .map(quote)
    .join(' ');
const reportCheck = (report, trigger) => {
  assert.equal(report.trigger, trigger);
  assert.equal(report.status, 'completed');
  assert(report.findings.length > 0);
  assert.equal(report.identity.executor.model, 'gpt-6-astra');
  assert.equal(report.identity.executor.id, 'codex-account');
};
try {
  await mkdir(repo);
  await mkdir(hooks);
  git('init', '-b', 'main');
  const files = {
    'sum.ts': 'export const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);\n',
    'caller.ts': "import { sum } from './sum.ts';\nexport const emptyTotal = () => sum([]);\n",
    'sum.test.ts':
      "import assert from 'node:assert/strict';\nimport { sum } from './sum.ts';\nassert.equal(sum([]), 0);\nassert.equal(sum([1,2]), 3);\n",
    'unrelated.ts': 'export const unrelated = 1;\n',
    'package.json': '{"private":true,"type":"module"}\n',
  };
  for (const [file, body] of Object.entries(files)) await writeFile(path.join(repo, file), body);
  git('add', '.');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const remote = path.join(temporary, 'remote.git');
  git('init', '--bare', remote);
  git('remote', 'add', 'fixture', remote);
  git('push', 'fixture', 'main');
  const commitOutput = path.join(temporary, 'commit.json'),
    pushOutput = path.join(temporary, 'push.json'),
    pushInput = path.join(temporary, 'push.txt');
  // Foreground verification adapters deliberately preserve advisory Git exit behavior.
  // These temporary scripts are not the installed asynchronous hook/service integration.
  await writeFile(
    path.join(hooks, 'pre-commit'),
    `#!/bin/sh\n${command('review')} --trigger commit > ${quote(commitOutput)} 2> ${quote(path.join(temporary, 'commit.stderr'))}\nexit 0\n`,
    { mode: 0o700 },
  );
  await writeFile(
    path.join(hooks, 'pre-push'),
    `#!/bin/sh\ncat > ${quote(pushInput)}\n${command('push-review')} < ${quote(pushInput)} > ${quote(pushOutput)} 2> ${quote(path.join(temporary, 'push.stderr'))}\nexit 0\n`,
    { mode: 0o700 },
  );
  await writeFile(path.join(repo, 'unrelated.ts'), 'export const unrelated = 2;\n');
  git('add', 'unrelated.ts');
  await writeFile(
    path.join(repo, 'sum.ts'),
    'export const sum = (values: number[]) => values.reduce((a, b) => a + b);\n',
  );
  git('commit', '--only', '-m', 'partial commit with fixture defect', '--', 'sum.ts');
  const committed = JSON.parse(await readFile(commitOutput, 'utf8'));
  proof.events.push({ trigger: 'commit', report: committed });
  await checkpoint();
  reportCheck(committed, 'commit');
  const source = git('rev-parse', 'HEAD');
  assert.equal(committed.identity.source.sourceTree, git('rev-parse', 'HEAD^{tree}'));
  assert.equal(committed.identity.source.baseCommit, base);
  assert.equal(git('show', ':unrelated.ts'), 'export const unrelated = 2;');
  assert.equal(git('show', 'HEAD:unrelated.ts'), 'export const unrelated = 1;');
  git('push', 'fixture', 'main');
  const batch = JSON.parse(await readFile(pushOutput, 'utf8'));
  assert.equal(batch.status, 'processed');
  assert.equal(batch.refs.length, 1);
  const pushed = batch.refs[0].review;
  proof.events.push({ trigger: 'push', report: pushed });
  await checkpoint();
  reportCheck(pushed, 'push');
  assert.equal(pushed.identity.source.kind, 'commit-tree');
  assert.equal(pushed.identity.source.sourceCommit, source);
  assert.equal(pushed.identity.source.baseCommit, base);
  assert.equal(git('--git-dir', remote, 'rev-parse', 'refs/heads/main'), source);
  const identity = core.discoverLocalIdentity(repo, profileId),
    scope = {
      kind: 'repository',
      profileId,
      repositoryKey: identity.repositoryKey,
      worktreeKey: identity.worktreeKey,
    };
  const requests = await core.ReviewRequests.open({ scope });
  try {
    const rows = await requests.list();
    assert.equal(rows.length, 2);
    assert(rows.every((row) => row.generation === 1 && row.state === 'finished'));
    proof.requests = rows.map((row) => ({
      state: row.state,
      generation: row.generation,
      reasons: row.reasons,
      resultId: row.resultId,
    }));
  } finally {
    requests.close();
  }
  proof.status = 'verified';
  proof.modelReviewInvocations = 2;
  proof.partialCommitTreeMatched = true;
  proof.unrelatedIndexPreserved = true;
  proof.localRemoteUpdated = true;
  proof.advisoryGitOperationsSucceeded = true;
} catch (error) {
  proof.status = 'failed';
  proof.failure =
    error instanceof assert.AssertionError
      ? error.message
      : 'Hook verification failed; inspect the owned fixture artifacts.';
  proof.fixtureOnFailure = temporary;
  throw error;
} finally {
  const keys = new core.PlatformLocalKeyStore();
  for (const base of [
    core.defaultLocalDataDirectory(),
    path.join(core.defaultLocalDataDirectory(), 'review-requests'),
  ]) {
    const directory = path.join(base, 'profiles', profileId);
    try {
      const ref = JSON.parse(await readFile(path.join(directory, 'local/key-ref.json'), 'utf8'));
      assert.equal(ref.profileId, profileId);
      assert.match(ref.id, /^[a-f0-9-]{36}$/);
      await keys.remove(`${profileId}.${ref.id}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        proof.cleanupErrors ??= [];
        proof.cleanupErrors.push('Profile key cleanup failed; encrypted data retained for retry.');
        process.exitCode = 1;
        continue;
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
  proof.cleanup = proof.cleanupErrors?.length
    ? 'incomplete'
    : 'profile keys and encrypted records removed';
  proof.finishedAt = new Date().toISOString();
  proof.cliSha256 = createHash('sha256')
    .update(await readFile(cli))
    .digest('hex');
  await checkpoint();
  if (proof.status === 'verified' && !proof.cleanupErrors?.length)
    await rm(temporary, { recursive: true, force: true });
}
