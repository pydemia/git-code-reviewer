import { randomBytes, randomUUID } from 'node:crypto';
import { openSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PlatformCentralCredentialStore, PlatformLocalKeyStore } from './local-credentials.js';
import { LocalRecordStore } from './local-records.js';
import { defaultLocalDataDirectory } from './local-identity.js';
import {
  privateDirectory,
  privateRoot,
  publishImmutable,
  readPrivateFile,
} from './private-files.js';
import { windowsNativeSync } from './windows-native.js';

describe.skipIf(process.platform !== 'win32')('native Windows security primitives', () => {
  it('refuses a concurrent writer and bounds snapshot bytes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'w01-snapshot-'));
    const file = path.join(root, 'source.ts');
    try {
      await writeFile(file, 'source\r\n');
      const request = { operation: 'snapshot-read', path: file, maximum: 8 };
      expect(windowsNativeSync(request).bytes).toBe(Buffer.from('source\r\n').toString('base64'));
      const fd = openSync(file, 'r+');
      try {
        expect(() => windowsNativeSync(request)).toThrow();
      } finally {
        closeSync(fd);
      }
      expect(() => windowsNativeSync({ ...request, maximum: 7 })).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('uses the OS profile path and separate persistent credential namespaces', async () => {
    const original = process.env.LOCALAPPDATA;
    const id = `w01-${randomUUID()}`;
    const local = new PlatformLocalKeyStore();
    const model = new PlatformLocalKeyStore('com.commitdefender.model-credentials.v1');
    const central = new PlatformCentralCredentialStore();
    const key = randomBytes(32);
    const reader = `gcr_key_${randomUUID()}_${randomBytes(32).toString('base64url')}`;
    try {
      process.env.LOCALAPPDATA = '\\\\untrusted\\network';
      expect(defaultLocalDataDirectory()).toBe(path.join(original!, 'CommitDefender'));
      expect(await local.read(id)).toBeUndefined();
      await local.write(id, key);
      await model.write(id, Buffer.alloc(32, 7));
      await central.write(id, reader);
      expect(await new PlatformLocalKeyStore().read(id)).toEqual(key);
      expect(await model.read(id)).toEqual(Buffer.alloc(32, 7));
      expect(await central.read(id)).toBe(reader);
      await expect(local.write(id, Buffer.alloc(1))).rejects.toMatchObject({
        code: 'credential-unavailable',
      });
      expect(await local.read(id)).toEqual(key);
    } finally {
      if (original === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = original;
      await Promise.all([local.remove(id), model.remove(id), central.remove(id)]);
      expect(await local.read(id)).toBeUndefined();
      expect(await model.read(id)).toBeUndefined();
      expect(await central.read(id)).toBeUndefined();
      key.fill(0);
    }
  }, 30_000);

  it('publishes once under concurrency and refuses broad ACLs and junctions', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'w01-files-'));
    try {
      const root = await privateRoot(path.join(parent, '공백 경로'));
      const file = path.join(root, 'revision');
      const values = Array.from({ length: 6 }, (_, n) => Buffer.alloc(8192, n));
      const results = await Promise.all(values.map((bytes) => publishImmutable(file, bytes)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await readPrivateFile(file, 8192)).toEqual(values[results.indexOf(true)]);
      expect(await readPrivateFile(path.join(root, 'absent'), 5)).toBeUndefined();
      await expect(readPrivateFile(file, 5)).rejects.toMatchObject({ code: 'record-too-large' });
      expect((await readdir(root)).some((name) => name.startsWith('.pending'))).toBe(false);
      const target = await privateDirectory(root, 'target');
      await symlink(target, path.join(root, 'junction'), 'junction');
      await expect(privateRoot(path.join(root, 'junction'))).rejects.toMatchObject({
        code: 'insecure-storage',
      });
      await expect(
        publishImmutable(path.join(root, 'junction', 'escape'), Buffer.from('x')),
      ).rejects.toMatchObject({ code: 'insecure-storage' });
      execFileSync('icacls.exe', [file, '/grant', '*S-1-5-32-545:R'], { stdio: 'pipe' });
      await expect(readPrivateFile(file, 8192)).rejects.toMatchObject({ code: 'insecure-storage' });
      const acl = execFileSync('icacls.exe', [file], { encoding: 'utf8' });
      await expect(readPrivateFile(file, 8192)).rejects.toMatchObject({ code: 'insecure-storage' });
      expect(execFileSync('icacls.exe', [file], { encoding: 'utf8' })).toBe(acl);
      const inherited = path.join(parent, 'existing');
      await mkdir(inherited);
      execFileSync('icacls.exe', [inherited, '/grant', '*S-1-5-32-545:(OI)(CI)R'], {
        stdio: 'pipe',
      });
      await expect(privateRoot(inherited)).rejects.toMatchObject({ code: 'insecure-storage' });
      expect(() =>
        windowsNativeSync({ operation: 'directory', path: '\\\\server\\share' }),
      ).toThrowError();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 30_000);

  it('reopens encrypted records, preserves CAS and rejects corrupt committed bytes', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'w01-records-'));
    const dataDirectory = path.join(parent, 'data');
    const profileId = `w01-${randomUUID()}`;
    const keys = new PlatformLocalKeyStore();
    const stores: LocalRecordStore[] = [];
    try {
      const options = { dataDirectory, scope: { kind: 'profile' as const, profileId } };
      const first = await LocalRecordStore.open(options);
      stores.push(first);
      await first.write('settings', 'fixture', { secret: 'W01_PRIVATE_CANARY' }, 0);
      const second = await LocalRecordStore.open(options);
      stores.push(second);
      expect(await second.read('settings', 'fixture')).toMatchObject({
        revision: 1,
        value: { secret: 'W01_PRIVATE_CANARY' },
      });
      const race = await Promise.allSettled([
        first.write('settings', 'fixture', { winner: 'one' }, 1),
        second.write('settings', 'fixture', { winner: 'two' }, 1),
      ]);
      expect(race.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
      const rejected = race.find((value) => value.status === 'rejected');
      expect(rejected).toMatchObject({ reason: { code: 'revision-conflict' } });
      const record = path.join(
        dataDirectory,
        'profiles',
        profileId,
        'local',
        'profile',
        'settings',
        'fixture',
      );
      await writeFile(path.join(record, '.pending-interrupted'), 'partial');
      expect((await second.read('settings', 'fixture'))?.revision).toBe(2);
      for (const name of await readdir(path.join(record, 'blobs'))) {
        const bytes = await readFile(path.join(record, 'blobs', name));
        expect(bytes.includes('W01_PRIVATE_CANARY')).toBe(false);
      }
      const marker = JSON.parse(await readFile(path.join(record, '000000000002.json'), 'utf8'));
      await writeFile(path.join(record, 'blobs', marker.blob), 'damaged');
      await expect(first.read('settings', 'fixture')).rejects.toMatchObject({
        code: 'corrupt-storage',
      });
    } finally {
      for (const store of stores) store.close();
      const ref = path.join(dataDirectory, 'profiles', profileId, 'local', 'key-ref.json');
      try {
        const value = JSON.parse(await readFile(ref, 'utf8'));
        await keys.remove(`${profileId}.${value.id}`);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    }
  }, 60_000);
});
