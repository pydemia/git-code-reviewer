// Real local CLI + synthetic loopback only. Never performs an account model call.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { windowsPrivateTemporary } from '../packages/client-core/dist/windows-native.js';
import {
  codexAccountEnvironment,
  reviewModelCatalog,
} from '../packages/client-executors/dist/codex-config.js';
import { probeCodexCatalog } from '../packages/client-executors/dist/catalog-probe.js';
assert.equal(process.platform, 'win32');
assert(process.env.W01_CODEX && path.isAbsolute(process.env.W01_CODEX));
const root = windowsPrivateTemporary('w01-codex-catalog-');
const evidence = {
  platform: process.platform,
  arch: process.arch,
  model: 'gpt-5.6-luna',
  effort: 'high',
  accountCalls: 0,
  syntheticProvider: true,
  probes: [],
};
try {
  const command = process.env.W01_CODEX;
  const env = { ...codexAccountEnvironment(), CODEX_HOME: root };
  evidence.cliVersion = execFileSync(command, ['--version'], {
    env,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  const catalog = reviewModelCatalog(
    execFileSync(command, ['debug', 'models', '--bundled'], {
      env,
      encoding: 'utf8',
      maxBuffer: 2097152,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    evidence.model,
    evidence.effort,
  );
  for (const conversation of [false, true]) {
    const directory = path.join(root, conversation ? 'conversation' : 'review');
    await mkdir(directory);
    await writeFile(path.join(directory, 'models.json'), catalog);
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
  evidence.error = error.code;
  throw error;
} finally {
  await rm(root, { recursive: true, force: true });
  evidence.temporaryAccountPathsRemoved = true;
  await writeFile(
    '.documents/execution/windows-support/evidence/W01-codex-catalog.json',
    JSON.stringify(evidence, null, 2) + '\n',
  );
}
