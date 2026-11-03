// Opt-in real-account verification of the packaged background CLI with owned Git hooks.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const consumer = process.env.GCR_SERVICE_CONSUMER;
const executable = process.env.GCR_SERVICE_CODEX;
const evidence = process.env.GCR_SERVICE_EVIDENCE;
for (const value of [consumer, executable, evidence]) assert(value && path.isAbsolute(value));
const core = await import(
  pathToFileURL(path.join(consumer, 'node_modules/@gcr/client-core/dist/index.js')).href
);
const cli = path.join(consumer, 'node_modules/@gcr/cli/dist/main.js');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'gcr-service-live-'));
const repo = path.join(temporary, 'repo'),
  hooks = path.join(temporary, 'hooks'),
  data = path.join(temporary, 'data');
const profileId = `gcr-service-${randomUUID()}`;
const common = ['--cwd', repo, '--profile', profileId, '--data-dir', data];
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
const environment = { ...process.env };
for (const key of Object.keys(environment)) if (key.startsWith('GIT_')) delete environment[key];
const invoke = async (...args) => {
  let output;
  try {
    output = await promisify(execFile)(process.execPath, [cli, ...args, ...common], {
      env: environment,
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    if (typeof error.code !== 'number' || ![1, 2].includes(error.code))
      throw Error('CLI process did not return a command result');
    output = error;
  }
  return { code: output.code ?? 0, value: JSON.parse(output.stdout) };
};
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
      timeout: 60000,
      env: { ...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    },
  ).trim();
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};
const waitFor = async (read, done, timeout = 300000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() >= deadline) throw Error('Observation deadline reached; no job was restarted');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};
const hookCommand = (action) => [process.execPath, cli, action, ...common].map(quote).join(' ');
const verifyJob = async (receipt, trigger) => {
  const observed = await invoke('service', 'job', '--id', receipt.id);
  assert.equal(observed.code, 0);
  assert(
    ['queued', 'running'].includes(observed.value.state),
    'Git must return before this review completes',
  );
  proof.events.push({ trigger, receipt, stateAfterGitReturned: observed.value.state });
  await checkpoint();
  const terminal = await waitFor(
    () => invoke('service', 'job', '--id', receipt.id),
    (result) => result.code === 0 && !['queued', 'running'].includes(result.value.state),
  );
  assert.equal(terminal.value.state, 'finished');
  assert.equal(terminal.value.result.status, 'completed');
  const { value: report } = await invoke('result', terminal.value.result.runId);
  assert.equal(report.status, 'completed');
  assert.equal(report.trigger, trigger);
  assert.equal(report.identity.executor.model, 'gpt-6-astra');
  assert.equal(report.identity.executor.id, 'codex-account');
  assert(report.findings.length > 0);
  Object.assign(proof.events.at(-1), { result: terminal.value.result, report });
  await checkpoint();
  return report;
};
let pid;
let startAttempted = false;
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
  const base = git('rev-parse', 'HEAD'),
    remote = path.join(temporary, 'remote.git');
  git('init', '--bare', remote);
  git('remote', 'add', 'fixture', remote);
  git('push', 'fixture', 'main');
  startAttempted = true;
  const started = await invoke('service', 'start');
  assert.equal(started.code, 0);
  assert.equal(started.value.status, 'running');
  pid = started.value.pid;
  assert(Number.isSafeInteger(pid));
  assert.notEqual(pid, process.pid);
  proof.servicePid = pid;
  const repeated = await invoke('service', 'start');
  assert.equal(repeated.value.pid, pid);
  const allowed = await invoke(
    'service',
    'allow',
    '--trigger',
    'commit',
    '--trigger',
    'push',
    '--executor-path',
    executable,
    '--model',
    'gpt-6-astra',
    '--reasoning-effort',
    'xhigh',
    '--timeout-ms',
    '240000',
  );
  assert.equal(allowed.code, 0);
  const commitOutput = path.join(temporary, 'commit.json'),
    pushOutput = path.join(temporary, 'push.json');
  // Temporary explicit adapters only. Managed installation and optional wait are separate gates.
  await writeFile(
    path.join(hooks, 'pre-commit'),
    `#!/bin/sh\n${hookCommand('enqueue')} --trigger commit > ${quote(commitOutput)} 2> ${quote(path.join(temporary, 'commit.stderr'))}\nexit 0\n`,
    { mode: 0o700 },
  );
  await writeFile(
    path.join(hooks, 'pre-push'),
    `#!/bin/sh\n${hookCommand('enqueue-push')} > ${quote(pushOutput)} 2> ${quote(path.join(temporary, 'push.stderr'))}\nexit 0\n`,
    { mode: 0o700 },
  );
  await writeFile(path.join(repo, 'unrelated.ts'), 'export const unrelated = 2;\n');
  git('add', 'unrelated.ts');
  await writeFile(
    path.join(repo, 'sum.ts'),
    'export const sum = (values: number[]) => values.reduce((a, b) => a + b);\n',
  );
  git('commit', '--only', '-m', 'partial commit fixture defect', '--', 'sum.ts');
  const accepted = JSON.parse(await readFile(commitOutput, 'utf8'));
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.reviewCompletion, 'not-awaited');
  const committed = await verifyJob(accepted.receipt, 'commit');
  const source = git('rev-parse', 'HEAD');
  assert.equal(committed.identity.source.sourceTree, git('rev-parse', 'HEAD^{tree}'));
  assert.equal(committed.identity.source.baseCommit, base);
  assert.equal(git('show', ':unrelated.ts'), 'export const unrelated = 2;');
  assert.equal(git('show', 'HEAD:unrelated.ts'), 'export const unrelated = 1;');
  git('push', 'fixture', 'main');
  const batch = JSON.parse(await readFile(pushOutput, 'utf8'));
  assert.equal(batch.status, 'accepted');
  assert.equal(batch.refs.length, 1);
  const pushed = await verifyJob(batch.refs[0].receipt, 'push');
  assert.equal(pushed.identity.source.kind, 'commit-tree');
  assert.equal(pushed.identity.source.sourceCommit, source);
  assert.equal(pushed.identity.source.baseCommit, base);
  assert.equal(git('--git-dir', remote, 'rev-parse', 'refs/heads/main'), source);
  const requests = await invoke('requests');
  proof.requests = requests.value;
  assert.equal(requests.code, 0);
  assert.equal(requests.value.length, 2);
  assert(requests.value.every((row) => row.generation === 1 && row.state === 'finished'));
  proof.status = 'verified';
  proof.modelReviewInvocations = 2;
  proof.partialCommitTreeMatched = true;
  proof.unrelatedIndexPreserved = true;
  proof.localRemoteUpdated = true;
  proof.gitReturnedBeforeBothReviewsCompleted = true;
} catch (error) {
  proof.status = 'failed';
  proof.failure =
    error instanceof assert.AssertionError
      ? error.message
      : 'Service verification failed; inspect the owned fixture.';
  proof.fixtureOnFailure = temporary;
  process.exitCode = 1;
} finally {
  let stopped = !startAttempted;
  if (startAttempted && !pid) {
    try {
      const observed = await invoke('service', 'status');
      if (observed.code === 0 && Number.isSafeInteger(observed.value.pid)) pid = observed.value.pid;
    } catch {
      /* An observation failure never proves that the spawned service exited. */
    }
    if (!pid)
      proof.cleanupErrors = ['Service startup outcome unknown; owned keys and fixture retained.'];
  }
  if (pid) {
    try {
      await invoke('service', 'stop');
      await waitFor(
        async () => alive(pid),
        (value) => !value,
        60000,
      );
      stopped = true;
    } catch {
      proof.cleanupErrors = ['Service shutdown unconfirmed; owned keys and fixture retained.'];
    }
  }
  if (stopped) {
    const keys = new core.PlatformLocalKeyStore();
    for (const directory of [
      data,
      path.join(data, 'review-requests'),
      path.join(data, 'local-service'),
    ]) {
      const profile = path.join(directory, 'profiles', profileId);
      try {
        const ref = JSON.parse(await readFile(path.join(profile, 'local/key-ref.json'), 'utf8'));
        assert.equal(ref.profileId, profileId);
        assert.match(ref.id, /^[a-f0-9-]{36}$/);
        await keys.remove(`${profileId}.${ref.id}`);
        await rm(profile, { recursive: true, force: true });
      } catch (error) {
        if (error.code !== 'ENOENT')
          (proof.cleanupErrors ??= []).push('Owned profile key cleanup failed.');
      }
    }
  }
  proof.cleanup = proof.cleanupErrors?.length
    ? 'incomplete'
    : 'service stopped; owned keys and encrypted records removed';
  if (proof.cleanupErrors?.length) process.exitCode = 1;
  proof.finishedAt = new Date().toISOString();
  proof.cliSha256 = createHash('sha256')
    .update(await readFile(cli))
    .digest('hex');
  await checkpoint();
  if (proof.status === 'verified' && !proof.cleanupErrors?.length)
    await rm(temporary, { recursive: true, force: true });
}
