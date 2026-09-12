import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, chmod, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash, discoverLocalIdentity } from './local-identity.js';
import { PlatformLocalKeyStore, type CredentialCommand } from './local-credentials.js';
import {
  privateRoot,
  privateDirectory,
  publishImmutable,
  readPrivateFile,
} from './private-files.js';

async function temporary<T>(action: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), 'gcr-local-foundation-'));
  try {
    return await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('local identity and private storage publication', () => {
  it('hashes canonical JSON independently of object insertion order and refuses non-JSON/cyclic/oversized inputs', () => {
    expect(contentHash({ z: 1, a: { b: 2, a: 1 } })).toBe(contentHash({ a: { a: 1, b: 2 }, z: 1 }));
    expect(canonicalJson({ z: 1, a: 'é' })).toBe('{"a":"é","z":1}');
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [cycle, undefined, NaN, new Date(), new Array(1)])
      expect(() => canonicalJson(value)).toThrow();
    expect(() => canonicalJson('é'.repeat(20), 20)).toThrow('size limit');
  });
  it('separates same-name clones and worktrees and keeps repository identity independent of remote credentials', async () =>
    temporary(async (root) => {
      const git = (cwd: string, ...args: string[]) =>
        execFileSync(
          'git',
          ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
      const one = await privateDirectory(root, 'one');
      const two = await privateDirectory(root, 'two');
      git(one, 'init', '--initial-branch=main', 'project');
      git(two, 'init', '--initial-branch=main', 'project');
      const first = path.join(one, 'project'),
        second = path.join(two, 'project');
      git(
        first,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'fixture',
      );
      const before = discoverLocalIdentity(first, 'profile-one');
      expect(discoverLocalIdentity(second, 'profile-one').repositoryKey).not.toBe(
        before.repositoryKey,
      );
      git(
        first,
        'remote',
        'add',
        'origin',
        'https://synthetic:not-a-credential@example.invalid/team/project',
      );
      expect(discoverLocalIdentity(first, 'profile-one')).toEqual(before);
      git(first, 'worktree', 'add', '-b', 'other', path.join(root, 'linked'));
      const linked = discoverLocalIdentity(path.join(root, 'linked'), 'profile-one');
      expect(linked.repositoryKey).toBe(before.repositoryKey);
      expect(linked.worktreeKey).not.toBe(before.worktreeKey);
      expect(discoverLocalIdentity(first, 'profile-two').profileId).not.toBe(before.profileId);
      const alias = path.join(root, 'alias');
      await symlink(first, alias);
      expect(discoverLocalIdentity(alias, 'profile-one')).toEqual(before);
    }));
  it('publishes exactly one complete revision in a write race and never replaces a committed name', async () =>
    temporary(async (root) => {
      const directory = await privateRoot(root);
      const file = path.join(directory, 'revision.json');
      const values = Array.from({ length: 20 }, (_, i) => Buffer.from(String(i).repeat(10_000)));
      const results = await Promise.all(values.map((value) => publishImmutable(file, value)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await readPrivateFile(file, 500_000)).toEqual(values[results.indexOf(true)]);
      expect(await publishImmutable(file, Buffer.from('replacement'))).toBe(false);
      expect((await readdir(directory)).filter((name) => name.startsWith('.pending'))).toEqual([]);
    }));
  it('refuses symlink and shared-permission storage instead of repairing or following it', async () =>
    temporary(async (root) => {
      const target = await privateDirectory(root, 'target');
      const alias = path.join(root, 'alias');
      await symlink(target, alias);
      await expect(privateRoot(alias)).rejects.toMatchObject({ code: 'insecure-storage' });
      await expect(privateDirectory(root, 'alias')).rejects.toMatchObject({
        code: 'insecure-storage',
      });
      const file = path.join(target, 'record');
      await publishImmutable(file, Buffer.from('fixture'));
      await chmod(file, 0o644);
      await expect(readPrivateFile(file, 1024)).rejects.toMatchObject({ code: 'insecure-storage' });
      await chmod(file, 0o600);
      await symlink(file, path.join(target, 'link'));
      await expect(readPrivateFile(path.join(target, 'link'), 1024)).rejects.toBeDefined();
      expect((await readFile(file)).toString()).toBe('fixture');
      await chmod(target, 0o755);
      await expect(privateRoot(target)).rejects.toMatchObject({ code: 'insecure-storage' });
    }));
});

describe('OS key store command boundary', () => {
  it.each(['darwin', 'linux'] as const)(
    '%s writes a key through stdin and checks read-back without placing it in process arguments',
    async (platform) => {
      const key = randomBytes(32);
      const calls: Array<{ file: string; args: readonly string[]; input?: string }> = [];
      const command: CredentialCommand = async (file, args, input) => {
        calls.push({ file, args, ...(input !== undefined ? { input } : {}) });
        const read = args.includes('find-generic-password') || args.includes('lookup');
        return { code: 0, stdout: read ? key.toString('base64') + '\n' : '', stderr: '' };
      };
      const store = new PlatformLocalKeyStore('com.commitdefender.test', platform, command);
      await store.write('synthetic-key', key);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.input).toContain(key.toString('base64'));
      for (const call of calls) expect(call.args.join(' ')).not.toContain(key.toString('base64'));
      expect(await store.read('synthetic-key')).toEqual(key);
      await store.remove('synthetic-key');
    },
  );
  it('does not accept an interactive tool exit 0 when the key was not actually saved', async () => {
    let calls = 0;
    const command: CredentialCommand = async () =>
      ++calls === 1
        ? { code: 0, stdout: '', stderr: 'synthetic command failed' }
        : { code: 44, stdout: '', stderr: 'synthetic not found' };
    const store = new PlatformLocalKeyStore('com.commitdefender.test', 'darwin', command);
    await expect(store.write('synthetic-key', randomBytes(32))).rejects.toMatchObject({
      code: 'credential-unavailable',
    });
  });
  it('distinguishes not-found from locked/unavailable and never exposes helper output in its error', async () => {
    const missing = new PlatformLocalKeyStore('com.commitdefender.test', 'darwin', async () => ({
      code: 44,
      stdout: '',
      stderr: '',
    }));
    expect(await missing.read('synthetic-key')).toBeUndefined();
    const locked = new PlatformLocalKeyStore('com.commitdefender.test', 'darwin', async () => ({
      code: 36,
      stdout: 'synthetic-secret-output',
      stderr: 'synthetic-diagnostic',
    }));
    await expect(locked.read('synthetic-key')).rejects.toMatchObject({
      code: 'credential-unavailable',
      message: 'OS credential store is unavailable or locked.',
    });
    expect(() => new PlatformLocalKeyStore('com.commitdefender.test', 'win32')).toThrow(
      'No supported OS',
    );
    await expect(missing.read('key\ncommand')).rejects.toMatchObject({
      code: 'credential-unavailable',
    });
  });
});
