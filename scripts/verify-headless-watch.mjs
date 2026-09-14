// Opt-in verification of a packaged CLI, detached watcher and current-account review.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

assert.equal(process.env.GCR_WATCH_ALLOW_MODEL, '1');
const consumer = process.env.GCR_WATCH_CONSUMER;
const executable = process.env.GCR_WATCH_CODEX;
const evidence = process.env.GCR_WATCH_EVIDENCE;
for (const value of [consumer, executable, evidence]) assert(value && path.isAbsolute(value));
const core = await import(
  pathToFileURL(path.join(consumer, 'node_modules/@gcr/client-core/dist/index.js')).href
);
const cli = path.join(consumer, 'node_modules/@gcr/cli/dist/main.js');
const temporary = await realpath(await mkdtemp('/tmp/gcr-watch-live-'));
const repo = path.join(temporary, 'repo'),
  data = path.join(temporary, 'data');
const profileId = `watch-live-${randomUUID()}`;
const common = ['--cwd', repo, '--profile', profileId, '--data-dir', data];
const proof = {
  status: 'running',
  fixture: temporary,
  profileId,
  consumer,
  model: 'gpt-6-astra',
  reasoningEffort: 'xhigh',
  startedAt: new Date().toISOString(),
};
await writeFile(evidence, '', { flag: 'wx', mode: 0o600 });
const checkpoint = () =>
  writeFile(evidence, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
const environment = { ...process.env };
for (const key of Object.keys(environment)) if (key.startsWith('GIT_')) delete environment[key];
const exec = promisify(execFile);
const invoke = async (...args) => {
  let result;
  try {
    result = await exec(process.execPath, [cli, ...args, ...common], {
      env: environment,
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    if (![1, 2].includes(error.code)) throw Error('CLI observation unavailable');
    result = error;
  }
  return { code: result.code ?? 0, value: JSON.parse(result.stdout) };
};
const git = (...args) =>
  exec(
    'git',
    [
      '-C',
      repo,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      env: { ...environment, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      timeout: 30000,
    },
  );
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readOwnedReference = async (directory) => {
  try {
    return JSON.parse(
      await readFile(path.join(directory, 'profiles', profileId, 'local/key-ref.json'), 'utf8'),
    );
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};
let started = false;
try {
  await mkdir(repo);
  await git('init', '-b', 'main');
  const files = {
    'sum.ts': 'export const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);\n',
    'caller.ts': "import { sum } from './sum.ts';\nexport const emptyTotal = () => sum([]);\n",
    'sum.test.ts':
      "import assert from 'node:assert/strict';\nimport { sum } from './sum.ts';\nassert.equal(sum([]), 0);\nassert.equal(sum([1,2]), 3);\n",
    'package.json': '{"private":true,"type":"module"}\n',
  };
  for (const [file, value] of Object.entries(files)) await writeFile(path.join(repo, file), value);
  await git('add', '.');
  await git('commit', '-m', 'base');
  started = true;
  const service = await invoke('service', 'start');
  assert.equal(service.code, 0);
  assert(service.value.features.includes('headless-watch-v1'));
  proof.servicePid = service.value.pid;
  assert.notEqual(proof.servicePid, process.pid);
  assert.equal(
    (
      await invoke(
        'service',
        'allow',
        '--trigger',
        'save',
        '--executor-path',
        executable,
        '--timeout-ms',
        '600000',
      )
    ).code,
    0,
  );
  assert.equal((await invoke('watch', 'start', '--trigger', 'save', '--external-changes')).code, 0);
  proof.watchCommandExitedBeforeWrite = true;
  await checkpoint();
  const defect = 'export const sum = (values: number[]) => values.reduce((a, b) => a + b);\n';
  await writeFile(path.join(repo, 'sum.ts'), defect);
  let receipt,
    lastLog = Date.now();
  const receiptDeadline = Date.now() + 60000;
  for (;;) {
    // Continue observing the same PID/receipt; an observation timeout never restarts a model.
    assert(alive(proof.servicePid), 'Owned service exited before a terminal receipt');
    try {
      const status = await invoke('watch', 'status');
      if (status.code === 0) {
        proof.watch = status.value;
        receipt = status.value[0]?.receipt;
        if (receipt) {
          if (proof.receiptId) assert.equal(receipt.id, proof.receiptId);
          proof.receiptId = receipt.id;
          if (!['queued', 'running'].includes(receipt.state)) break;
        }
      }
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      proof.transientObservationFailures = (proof.transientObservationFailures ?? 0) + 1;
    }
    if (!receipt && Date.now() > receiptDeadline)
      throw Error('No receipt observed; model was not restarted');
    if (Date.now() - lastLog > 30000) {
      process.stdout.write(
        `Observing owned service ${proof.servicePid}; receipt ${receipt?.state ?? 'pending'}\n`,
      );
      await checkpoint();
      lastLog = Date.now();
    }
    await sleep(2000);
  }
  assert.equal(receipt.state, 'finished');
  assert.equal(receipt.result.status, 'completed');
  const result = await invoke('result', receipt.result.runId);
  const report = result.value;
  proof.report = report;
  assert.equal(report.status, 'completed');
  assert.equal(report.trigger, 'save');
  assert.equal(report.identity.source.kind, 'working-tree');
  assert.equal(report.identity.executor.id, 'codex-account');
  assert.equal(report.identity.executor.model, 'gpt-6-astra');
  assert(report.findings.length > 0);
  // Same bytes generate no new receipt after two normal polling intervals.
  await writeFile(path.join(repo, 'sum.ts'), defect);
  await sleep(6000);
  const final = await invoke('watch', 'status');
  assert.equal(final.value[0].receipt.id, receipt.id);
  assert.equal(final.value[0].pendingFiles, 0);
  const requests = await invoke('requests');
  assert.equal(requests.code, 0);
  assert.equal(requests.value.length, 1);
  assert.equal(requests.value[0].state, 'finished');
  assert.equal(requests.value[0].generation, 1);
  proof.reviewRequests = requests.value;
  proof.sameBytesReusedReceipt = true;
  proof.status = 'verified';
} catch (error) {
  proof.status = 'failed';
  proof.failure =
    error instanceof assert.AssertionError
      ? error.message
      : 'Verification failed; inspect owned fixture';
  process.exitCode = 1;
} finally {
  let safeToClean = !started;
  if (started) {
    try {
      const status = await invoke('service', 'status');
      if (status.code === 0) {
        proof.servicePid ??= status.value.pid;
        const live = status.value.jobs.filter((job) => ['queued', 'running'].includes(job.state));
        if (live.length) {
          proof.liveReceipts = live.map((job) => ({ id: job.id, state: job.state }));
        } else {
          await invoke('watch', 'stop');
          await invoke('service', 'stop');
          const until = Date.now() + 60000;
          while (alive(proof.servicePid) && Date.now() < until) await sleep(500);
          safeToClean = !alive(proof.servicePid);
        }
      }
    } catch {
      /* Unknown ownership/outcome retains the fixture and keys. */
    }
  }
  proof.cleanup = safeToClean ? 'stopped' : 'pending; live or unobserved service retained';
  if (safeToClean) {
    try {
      const keys = new core.PlatformLocalKeyStore();
      proof.removedProfileKeys = 0;
      for (const directory of [
        data,
        path.join(data, 'review-requests'),
        path.join(data, 'local-service'),
      ]) {
        const ref = await readOwnedReference(directory);
        if (!ref) continue;
        assert.equal(ref.profileId, profileId);
        assert.match(ref.id, /^[a-f0-9-]{36}$/);
        await keys.remove(`${profileId}.${ref.id}`);
        proof.removedProfileKeys++;
      }
      await rm(temporary, { recursive: true, force: true });
      proof.cleanup = 'service stopped; owned fixture and keys removed';
    } catch {
      proof.cleanup = 'pending; owned key cleanup failed';
      process.exitCode = 1;
    }
  } else process.exitCode = 1;
  proof.cliSha256 = createHash('sha256')
    .update(await readFile(cli))
    .digest('hex');
  proof.finishedAt = new Date().toISOString();
  await checkpoint();
  process.stdout.write(
    JSON.stringify({ status: proof.status, runId: proof.report?.runId, cleanup: proof.cleanup }) +
      '\n',
  );
}
