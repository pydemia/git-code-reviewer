// Run beside installed @gcr packages. Explicitly invokes the current Codex account
// on synthetic source only; set GCR_CODEX_EXECUTABLE to the selected CLI binary.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  captureLocalSource,
  discoverLocalIdentity,
  resolveLocalContext,
  resolveLocalExecutionPolicy,
  LocalReviewSourcePort,
  clientCorePackage,
} from '@gcr/client-core';
import { prepareCodexAccountExecutor } from '@gcr/client-executors';

assert(process.env.GCR_CODEX_EXECUTABLE, 'Select the authenticated Codex executable explicitly.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcr-executor-fixture-'));
const repo = path.join(root, 'repo');
fs.mkdirSync(repo);
const git = (...args) =>
  execFileSync(
    'git',
    [
      '-C',
      repo,
      '-c',
      'user.name=GCR Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      stdio: 'pipe',
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    },
  );
const witnesses = Array.from({ length: 3 }, () => randomBytes(16).toString('hex'));
let snapshot;
let evidence;
try {
  git('init', '-b', 'main');
  fs.writeFileSync(
    path.join(repo, 'cache.py'),
    `# read-witness: ${witnesses[0]}\ndef load(ids, cache, database):\n    return {key: cache[key] if key in cache else database[key] for key in ids}\n`,
  );
  fs.writeFileSync(
    path.join(repo, 'caller.py'),
    `# read-witness: ${witnesses[2]}\nfrom cache import load\n\ndef batch():\n    result = load(["a", "b"], {"a": 1}, {"a": 1, "b": 2})\n    return result["a"] + result["b"]\n`,
  );
  fs.writeFileSync(
    path.join(repo, 'private.py'),
    `PRIVATE_NOT_APPROVED_${randomBytes(16).toString('hex')}\n`,
  );
  git('add', '.');
  git('commit', '-m', 'synthetic base');
  fs.writeFileSync(
    path.join(repo, 'cache.py'),
    `# read-witness: ${witnesses[1]}\ndef load(ids, cache, database):\n    cached = {key: cache[key] for key in ids if key in cache}\n    if cached:\n        return cached\n    return {key: database[key] for key in ids}\n`,
  );
  git('add', 'cache.py');
  snapshot = captureLocalSource({ cwd: repo, kind: 'index', paths: ['cache.py'] });
  const client = discoverLocalIdentity(repo, 'executor-synthetic-profile');
  const context = await resolveLocalContext({
    client,
    snapshot,
    stores: [],
    requiredSources: [{ path: 'caller.py', side: 'source' }],
  });
  assert.equal(context.status, 'ready');
  const executor = await prepareCodexAccountExecutor({
    executablePath: process.env.GCR_CODEX_EXECUTABLE,
    model: 'gpt-6-astra',
    reasoningEffort: 'xhigh',
  });
  const prepared = resolveLocalExecutionPolicy({
    client,
    context,
    snapshot,
    executor: executor.descriptor,
    workspaceTrusted: true,
    approval: {
      client,
      executor: executor.descriptor,
      paths: ['cache.py', 'caller.py'],
      allowBase: true,
      allowRelated: true,
      allowKnowledge: false,
    },
    budget: { modelCalls: 1, durationMs: 120000, sourceBytes: 1048576, toolCalls: 100 },
  });
  assert.equal(prepared.status, 'ready');
  const policy = prepared.policy;
  fs.rmSync(repo, { recursive: true, force: true });
  const budget = policy.createRunBudget();
  const port = new LocalReviewSourcePort(snapshot, policy, budget);
  await assert.rejects(port.execute('read_file', { path: 'private.py' }));
  await assert.rejects(port.execute('read_file', { path: path.join(repo, 'cache.py') }));
  budget.reserveModelCall();
  const responseSchema = {
    type: 'object',
    properties: {
      defect: { type: 'boolean' },
      affectedPath: { type: 'string' },
      line: { type: 'integer' },
      missingKey: { type: 'string' },
      explanation: { type: 'string' },
      readWitnesses: { type: 'array', items: { type: 'string' } },
      contextMissing: { type: 'boolean' },
    },
    required: [
      'defect',
      'affectedPath',
      'line',
      'missingKey',
      'explanation',
      'readWitnesses',
      'contextMissing',
    ],
    additionalProperties: false,
  };
  const result = await executor.review({
    source: port,
    timeoutMs: 120000,
    responseSchema,
    prompt:
      'Review the staged change in cache.py against its base. Read the current caller.py and evaluate its concrete call. All source is available only through gcr_source tools. Read the source and base bodies; return all three distinct read-witness comment values you actually read. Identify any introduced behavioral defect and its triggering condition, with the source line and missing key if applicable. Do not execute tests. Return only the requested JSON.',
  });
  const report = JSON.parse(result.raw);
  process.stderr.write(
    `${JSON.stringify({ stage: 'synthetic-model-review', result, receipts: port.receipts })}\n`,
  );
  assert.equal(report.defect, true);
  assert.equal(report.affectedPath, 'cache.py');
  assert.equal(report.missingKey, 'b');
  assert.equal(report.contextMissing, false);
  assert.deepEqual([...new Set(report.readWitnesses)].sort(), witnesses.slice().sort());
  assert(port.receipts.filter((receipt) => receipt.tool === 'read_file').length >= 3);
  const cancellationBudget = policy.createRunBudget();
  cancellationBudget.reserveModelCall();
  const cancellationPort = new LocalReviewSourcePort(snapshot, policy, cancellationBudget);
  const controller = new AbortController();
  let cancellationToolCalls = 0;
  const cancellationStart = performance.now();
  await assert.rejects(
    executor.review({
      source: {
        async execute(name, args) {
          cancellationToolCalls++;
          const value = await cancellationPort.execute(name, args);
          controller.abort();
          return value;
        },
      },
      signal: controller.signal,
      timeoutMs: 30000,
      prompt: 'Read source cache.py with the fixed read_file tool before reviewing it.',
    }),
    { code: 'cancelled' },
  );
  assert(cancellationToolCalls > 0);
  const timeoutBudget = policy.createRunBudget();
  timeoutBudget.reserveModelCall();
  const timeoutPort = new LocalReviewSourcePort(snapshot, policy, timeoutBudget);
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  let timeoutToolCalls = 0;
  const timeoutStart = performance.now();
  try {
    await assert.rejects(
      executor.review({
        source: {
          async execute(name, args) {
            timeoutToolCalls++;
            const value = await timeoutPort.execute(name, args);
            await hold;
            return value;
          },
        },
        timeoutMs: 15000,
        prompt: 'Read source cache.py with the fixed read_file tool before reviewing it.',
      }),
      { code: 'timeout' },
    );
  } finally {
    release();
  }
  assert(timeoutToolCalls > 0);
  evidence = {
    platform: process.platform,
    node: process.version,
    packageVersion: clientCorePackage.version,
    syntheticData: true,
    model: result.model,
    reasoningEffort: result.reasoningEffort,
    executorInvocations: 3,
    sourceHash: snapshot.identity.hash,
    contextHash: context.context.identity.hash,
    originalRepositoryRemovedBeforeModel: true,
    unapprovedAndAbsoluteSourceDenied: true,
    actualReadWitnesses: true,
    report,
    receipts: port.receipts,
    completedReviewMs: result.elapsedMs,
    usage: result.usage,
    cancellation: {
      activeToolCalls: cancellationToolCalls,
      elapsedMs: Math.round(timeoutStart - cancellationStart),
    },
    timeout: {
      activeToolCalls: timeoutToolCalls,
      elapsedMs: Math.round(performance.now() - timeoutStart),
    },
    outputTokenHardLimitSupported: false,
    centralRequests: 0,
    cleanup: 'completed',
  };
} finally {
  snapshot?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
