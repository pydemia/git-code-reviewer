import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PlatformCentralCredentialStore, type CredentialCommand } from './local-credentials.js';
import { windowsNativeSync } from './windows-native.js';
const secret = `gcr_key_${randomUUID()}_${randomBytes(32).toString('base64url')}`;
describe('central OS credential adapter', () => {
  it.skipIf(process.platform !== 'win32')(
    'reopens Windows reader credentials in a new process and deletes missing entries idempotently',
    async () => {
      const reference = `w02-${randomUUID()}`;
      const store = new PlatformCentralCredentialStore();
      try {
        await expect(store.remove(reference)).resolves.toBeUndefined();
        expect(await store.read(reference)).toBeUndefined();
        await store.write(reference, secret);
        const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
        const digest = execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import {createHash} from 'node:crypto';
             const {PlatformCentralCredentialStore}=await import(${JSON.stringify(moduleUrl)});
             const secret=await new PlatformCentralCredentialStore().read(process.argv[1]);
             if (!secret) throw Error('Missing test credential');
             process.stdout.write(createHash('sha256').update(secret).digest('hex'));`,
            reference,
          ],
          { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: 'pipe' },
        );
        expect(digest).toBe(createHash('sha256').update(secret).digest('hex'));
        const malformed = windowsNativeSync({
          operation: 'credential',
          service: 'com.commitdefender.central-auth.v1',
          reference,
          action: 'write',
          bytes: Buffer.from('invalid-reader-credential').toString('base64'),
        });
        expect(malformed.error).toBeUndefined();
        await expect(store.read(reference)).rejects.toMatchObject({
          code: 'credential-unavailable',
        });
        await store.remove(reference);
        await expect(store.remove(reference)).resolves.toBeUndefined();
        expect(await store.read(reference)).toBeUndefined();
      } finally {
        const removed = windowsNativeSync({
          operation: 'credential',
          service: 'com.commitdefender.central-auth.v1',
          reference,
          action: 'remove',
        });
        expect(removed.error).toBeUndefined();
      }
    },
    30000,
  );
  it.each(['darwin', 'linux'] as const)(
    'uses a separate %s namespace and stdin for secret writes',
    async (platform) => {
      const calls: Array<{ file: string; args: readonly string[]; input?: string }> = [];
      const command: CredentialCommand = async (file, args, input) => {
        calls.push({ file, args, ...(input ? { input } : {}) });
        return {
          code: 0,
          stdout: args.includes('-w') || args[0] === 'lookup' ? secret : '',
          stderr: '',
        };
      };
      const store = new PlatformCentralCredentialStore(platform, command);
      await store.write('gcr-fixture', secret);
      expect(calls[0]!.input).toContain(secret);
      expect(calls.every((c) => !c.args.join(' ').includes(secret))).toBe(true);
      expect(JSON.stringify(calls)).toContain('com.commitdefender.central-auth.v1');
      await store.remove('gcr-fixture');
    },
  );
  it('rejects multiline/keychain-command injection and hides OS diagnostics', async () => {
    let calls = 0;
    const store = new PlatformCentralCredentialStore('darwin', async () => {
      calls++;
      return { code: 1, stdout: '', stderr: secret };
    });
    await expect(
      store.write('gcr-fixture', secret + '\ndelete-generic-password'),
    ).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(store.read('gcr-fixture')).rejects.not.toThrow(secret);
  });
  it('distinguishes missing entries from malformed stored credentials', async () => {
    expect(
      await new PlatformCentralCredentialStore('darwin', async () => ({
        code: 44,
        stdout: '',
        stderr: '',
      })).read('gcr-fixture'),
    ).toBeUndefined();
    await expect(
      new PlatformCentralCredentialStore('darwin', async () => ({
        code: 0,
        stdout: 'not-an-api-key',
        stderr: '',
      })).read('gcr-fixture'),
    ).rejects.toThrow();
  });
});
