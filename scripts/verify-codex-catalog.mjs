// Real executable with synthetic loopback responses; never uses a real account.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  reviewModelCatalog,
  codexAccountEnvironment,
} from '../packages/client-executors/dist/codex-config.js';
import { probeCodexCatalog } from '../packages/client-executors/dist/catalog-probe.js';
import { windowsPrivateTemporary } from '../packages/client-core/dist/windows-native.js';

const [command, output] = process.argv.slice(2);
assert(
  command && path.isAbsolute(command) && output,
  'Usage: node scripts/verify-codex-catalog.mjs <absolute codex> <evidence.json>',
);
const root =
  process.platform === 'win32'
    ? windowsPrivateTemporary('gcr-catalog-check-')
    : await mkdtemp(path.join(os.tmpdir(), 'gcr-catalog-check-'));
const evidence = {
  recordedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  model: 'gpt-5.6-luna',
  effort: 'high',
  realAccountCalls: 0,
  syntheticProvider: true,
  probes: [],
};
try {
  const env = { ...codexAccountEnvironment(), HOME: root, CODEX_HOME: root };
  const run = (args) =>
    execFileSync(command, args, {
      env,
      encoding: 'utf8',
      maxBuffer: 2097152,
      timeout: 10000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  evidence.cliVersion = run(['--version']).trim();
  assert(['codex-cli 0.153.4', 'codex-cli 0.154.0'].includes(evidence.cliVersion));
  evidence.binarySha256 = createHash('sha256')
    .update(await readFile(command))
    .digest('hex');
  const catalog = reviewModelCatalog(
    run(['debug', 'models', '--bundled']),
    evidence.model,
    evidence.effort,
  );
  for (const conversation of [false, true]) {
    const directory = path.join(root, conversation ? 'conversation' : 'review');
    await mkdir(directory, { mode: 0o700 });
    await writeFile(path.join(directory, 'models.json'), catalog, { mode: 0o600 });
    await probeCodexCatalog(
      command,
      directory,
      (result) => {
        const { stdout, stderr, ...safe } = result;
        evidence.probes.push({ conversation, ...safe });
      },
      conversation,
      evidence.model,
      evidence.effort,
    );
  }
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.error = error.code ?? 'probe-failed';
  process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
  evidence.temporaryAccountPathsRemoved = true;
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
}
