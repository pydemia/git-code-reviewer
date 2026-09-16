import { realpath, lstat, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ExecutorError, runManagedProcess, type ManagedProcessInput } from './process.js';
import { windowsNative, checkWindowsStorage } from '@gcr/client-core/windows-native';

/** Codex 0.153.4 loads global AGENTS documents independently of project_doc_max_bytes.
 * macOS denies these reads; Windows exposes only an auth-file hard link in a
 * private process-specific home. The original account and settings stay intact.
 * The model has no filesystem/command tools; this covers the host's automatic load.
 * Unverified platforms remain unavailable. */
export async function runIsolatedCodex(input: ManagedProcessInput) {
  if (process.platform === 'win32') {
    const original =
      input.env.CODEX_HOME ?? path.join(input.env.USERPROFILE ?? os.homedir(), '.codex');
    // Authentication is the same NTFS file, never a plaintext credential copy.
    // Only this child sees the new home. Global documents/config are untouched.
    const root = path.join(path.dirname(input.cwd), `account-${randomUUID()}`);
    try {
      checkWindowsStorage(await windowsNative({ operation: 'directory', path: root }));
      const linked = checkWindowsStorage(
        await windowsNative({
          operation: 'auth-link',
          source: path.join(original, 'auth.json'),
          path: path.join(root, 'auth.json'),
        }),
      );
      // Empty auth is allowed only by the synthetic probe's explicit provider.
      if (linked.missing && !input.args.includes('model_provider="gcr_fixture"'))
        throw new ExecutorError('executor-unavailable');
      return await runManagedProcess({
        ...input,
        env: { ...input.env, CODEX_HOME: root },
        args: [...input.args, '-c', 'cli_auth_credentials_store="file"'],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  if (process.platform !== 'darwin') throw new ExecutorError('executor-unavailable');
  const authHome = await realpath(
    input.env.CODEX_HOME ?? path.join(input.env.HOME ?? os.homedir(), '.codex'),
  );
  const denied: string[] = [];
  for (const name of ['AGENTS.md', 'AGENTS.override.md']) {
    const file = path.join(authHome, name);
    try {
      const info = await lstat(file);
      // Do not turn a dynamic symlink into a one-time pathname permission decision.
      if (!info.isFile() || info.isSymbolicLink()) throw new ExecutorError('executor-unavailable');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    denied.push(file);
  }
  const profile = `(version 1)\n(allow default)\n(deny file-read* ${denied.map((file) => `(literal ${JSON.stringify(file)})`).join(' ')})\n`;
  return runManagedProcess({
    ...input,
    command: '/usr/bin/sandbox-exec',
    args: ['-p', profile, input.command, ...input.args],
  });
}
