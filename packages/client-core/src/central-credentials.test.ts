import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PlatformCentralCredentialStore, type CredentialCommand } from './local-credentials.js';
const secret = `gcr_key_${randomUUID()}_${randomBytes(32).toString('base64url')}`;
describe('central OS credential adapter', () => {
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
