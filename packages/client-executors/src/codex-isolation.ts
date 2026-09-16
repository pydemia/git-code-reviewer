import { link, mkdtemp, open, realpath, lstat, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ExecutorError, runManagedProcess, type ManagedProcessInput } from './process.js';
import { windowsNative, checkWindowsStorage } from '@gcr/client-core/windows-native';

/** Codex 0.153.4 loads global AGENTS documents independently of project_doc_max_bytes.
 * macOS denies these reads; Windows/Linux expose only an auth-file hard link in a
 * private process-specific home. The original account and settings stay intact.
 * The model has no filesystem/command tools; this covers the host's automatic load.
 * Unverified platforms remain unavailable. */
export async function runIsolatedCodex(input: ManagedProcessInput) {
  if (process.platform === 'linux') return runLinuxCodex(input);
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

/** Keep the account on its original filesystem: /tmp may be another mount.
 * Linking the existing private inode avoids credential copies and retains the
 * verified CLI's in-place token refresh. Keyring-only accounts fail closed;
 * changing CODEX_HOME must not select a different keyring account or export it. */
async function runLinuxCodex(input: ManagedProcessInput) {
  if (input.signal?.aborted) throw new ExecutorError('cancelled');
  const original = path.resolve(
    input.env.CODEX_HOME ?? path.join(input.env.HOME ?? os.homedir(), '.codex'),
  );
  let root: string | undefined;
  let auth: Awaited<ReturnType<typeof open>> | undefined;
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(
      original,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const home = await directory.stat();
    if (home.uid !== process.getuid!() || (home.mode & 0o022) !== 0)
      throw new ExecutorError('executor-unavailable');
    const source = path.join(original, 'auth.json');
    try {
      auth = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
        !input.args.includes('model_provider="gcr_fixture"')
      )
        throw error;
    }
    const info = await auth?.stat();
    if (info && (!info.isFile() || info.uid !== home.uid || (info.mode & 0o077) !== 0))
      throw new ExecutorError('executor-unavailable');
    root = await mkdtemp(path.join(original, '.gcr-account-'));
    const privateHome = await lstat(root);
    const currentHome = await lstat(original);
    if (
      !currentHome.isDirectory() ||
      currentHome.dev !== home.dev ||
      currentHome.ino !== home.ino ||
      !privateHome.isDirectory() ||
      privateHome.uid !== home.uid ||
      (privateHome.mode & 0o077) !== 0
    )
      throw new ExecutorError('executor-unavailable');
    if (info) {
      const destination = path.join(root, 'auth.json');
      await link(source, destination);
      const linked = await lstat(destination);
      if (
        !linked.isFile() ||
        linked.dev !== info.dev ||
        linked.ino !== info.ino ||
        linked.uid !== info.uid ||
        (linked.mode & 0o077) !== 0
      )
        throw new ExecutorError('executor-unavailable');
    }
    return await runManagedProcess({
      ...input,
      env: { ...input.env, CODEX_HOME: root },
      args: [...input.args, '-c', 'cli_auth_credentials_store="file"'],
    });
  } catch (error) {
    if (error instanceof ExecutorError) throw error;
    // Do not include filesystem paths or account data in executor diagnostics.
    throw new ExecutorError('executor-unavailable');
  } finally {
    try {
      if (root) await rm(root, { recursive: true, force: true });
    } catch {
      throw new ExecutorError('cleanup-failed');
    } finally {
      try {
        await auth?.close();
      } finally {
        await directory?.close();
      }
    }
  }
}
