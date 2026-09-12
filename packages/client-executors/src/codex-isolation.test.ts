import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { runIsolatedCodex } from './codex-isolation.js';
import { prepareCodexAccountExecutor } from './codex.js';

it.skipIf(process.platform !== 'darwin')(
  'denies automatic instruction reads without copying or modifying the account namespace',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gcr-instruction-isolation-'));
    try {
      for (const file of ['AGENTS.md', 'AGENTS.override.md'])
        await writeFile(path.join(root, file), `PRIVATE_${file}`, { mode: 0o600 });
      await writeFile(path.join(root, 'auth.json'), 'synthetic-auth-fixture', { mode: 0o600 });
      const script = `const fs=require('fs');for(const name of ['AGENTS.md','AGENTS.override.md']){try{fs.readFileSync(name);process.exit(3)}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;}}process.stdout.write(fs.readFileSync('auth.json'));`;
      const result = await runIsolatedCodex({
        command: process.execPath,
        args: ['-e', script],
        cwd: root,
        env: { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: root },
        stdin: '',
        timeoutMs: 5000,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('synthetic-auth-fixture');
      expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('PRIVATE_AGENTS.md');
      await rm(path.join(root, 'AGENTS.md'));
      await symlink(path.join(root, 'auth.json'), path.join(root, 'AGENTS.md'));
      await expect(
        runIsolatedCodex({
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          cwd: root,
          env: { CODEX_HOME: root },
          stdin: '',
          timeoutMs: 5000,
        }),
      ).rejects.toMatchObject({ code: 'executor-unavailable' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
it('rejects a different model or reasoning effort before executing an account command', async () => {
  await expect(
    prepareCodexAccountExecutor({
      executablePath: '/nonexistent',
      model: 'another-model',
      reasoningEffort: 'xhigh',
    }),
  ).rejects.toMatchObject({ code: 'executor-unavailable' });
  await expect(
    prepareCodexAccountExecutor({
      executablePath: '/nonexistent',
      model: 'gpt-6-astra',
      reasoningEffort: 'high',
    }),
  ).rejects.toMatchObject({ code: 'executor-unavailable' });
});
