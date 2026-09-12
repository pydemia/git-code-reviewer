import { realpath, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutorError, runManagedProcess, type ManagedProcessInput } from './process.js';

/** Codex 0.153.4 loads global AGENTS documents independently of project_doc_max_bytes.
 * Keep auth in its original namespace and deny these reads in the outer process.
 * The model has no filesystem/command tools; this covers the host's automatic load.
 * Other platforms stay unavailable until an equivalent boundary is verified. */
export async function runIsolatedCodex(input: ManagedProcessInput) {
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
