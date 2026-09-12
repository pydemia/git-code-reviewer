import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, link, unlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { errorCode, LocalStoreError } from './local-errors.js';

function privateMode(stat: { uid: number; mode: number }, expected: 'file' | 'directory'): void {
  if (
    (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new LocalStoreError(
      'insecure-storage',
      `Local ${expected} must be owned by the current user with private permissions.`,
    );
  }
}
export async function privateRoot(directory: string): Promise<string> {
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new LocalStoreError('insecure-storage', 'Local storage root must be a real directory.');
  privateMode(stat, 'directory');
  const root = await realpath(directory);
  if (created) {
    const first = await realpath(created);
    for (
      let current = root;
      current === first || current.startsWith(first + path.sep);
      current = path.dirname(current)
    ) {
      await syncDirectory(path.dirname(current));
    }
  }
  return root;
}
export async function privateDirectory(parent: string, name: string): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) || name === '.' || name === '..')
    throw new LocalStoreError('insecure-storage', 'Invalid local storage component.');
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
    throw new LocalStoreError('insecure-storage', 'Local storage parent is not a directory.');
  privateMode(parentStat, 'directory');
  const target = path.join(parent, name);
  let created = false;
  try {
    await mkdir(target, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new LocalStoreError(
      'insecure-storage',
      'Local storage component is not a real directory.',
    );
  privateMode(stat, 'directory');
  if (created) await syncDirectory(parent);
  return target;
}
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function readPrivateFile(file: string, maxBytes: number): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new LocalStoreError('insecure-storage', 'Expected a regular local file.');
    privateMode(stat, 'file');
    if (stat.size > maxBytes)
      throw new LocalStoreError('record-too-large', 'Stored local record exceeds its size limit.');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > stat.size || offset > maxBytes)
      throw new LocalStoreError('corrupt-storage', 'Stored local record changed while being read.');
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

/** Publish a fully written immutable file with an exclusive hard link; never replace its name. */
export async function publishImmutable(file: string, bytes: Uint8Array): Promise<boolean> {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.pending-${randomUUID()}`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    try {
      await link(temporary, file);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return false;
      throw error;
    }
    try {
      await syncDirectory(directory);
    } catch {
      throw new LocalStoreError(
        'commit-unknown',
        'Local file was published but durability could not be confirmed. Re-read before retrying.',
      );
    }
    return true;
  } finally {
    await handle.close().catch(() => undefined);
    // An interrupted publication can leave a private .pending file. Readers never select it.
    await unlink(temporary).catch(() => undefined);
  }
}
