import { spawn } from 'node:child_process';
import { LocalStoreError } from './local-errors.js';

/** Host port shared by the extension and headless process; never backed by repository settings. */
export interface LocalKeyStore {
  read(reference: string): Promise<Buffer | undefined>;
  write(reference: string, key: Uint8Array): Promise<void>;
  remove(reference: string): Promise<void>;
}
interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export type CredentialCommand = (
  file: string,
  args: readonly string[],
  input?: string,
) => Promise<CommandResult>;

/** Bounded helper execution. Errors deliberately exclude argv, stderr and secret output. */
const run: CredentialCommand = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    const fail = () => {
      if (rejected) return;
      rejected = true;
      child.kill('SIGKILL');
      reject(
        new LocalStoreError(
          'credential-unavailable',
          'OS credential store is unavailable or locked.',
        ),
      );
    };
    const timer = setTimeout(fail, 5_000);
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024) {
        fail();
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.stdin.on('error', fail);
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!rejected)
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
    });
    child.stdin.end(input);
  });
const unavailable = () =>
  new LocalStoreError('credential-unavailable', 'OS credential store is unavailable or locked.');
const token = (value: string): string => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/.test(value)) throw unavailable();
  return value;
};

/** macOS Keychain or the persistent Linux Secret Service collection. No plaintext fallback. */
export class PlatformLocalKeyStore implements LocalKeyStore {
  constructor(
    private readonly service = 'com.commitdefender.local-knowledge.v1',
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly command: CredentialCommand = run,
  ) {
    token(service);
    if (!['darwin', 'linux'].includes(platform))
      throw new LocalStoreError(
        'unsupported-platform',
        'No supported OS credential store adapter.',
      );
  }
  private async invoke(
    operation: 'read' | 'write' | 'remove',
    reference: string,
    key?: Uint8Array,
  ): Promise<CommandResult> {
    token(reference);
    if (this.platform === 'darwin') {
      if (operation === 'write') {
        if (key?.byteLength !== 32) throw unavailable();
        // Interactive command input keeps the generated key out of process arguments.
        return this.command(
          '/usr/bin/security',
          ['-i'],
          `add-generic-password -a ${reference} -s ${this.service} -w ${Buffer.from(key).toString('base64')}\n`,
        );
      }
      return this.command('/usr/bin/security', [
        operation === 'read' ? 'find-generic-password' : 'delete-generic-password',
        '-a',
        reference,
        '-s',
        this.service,
        ...(operation === 'read' ? ['-w'] : []),
      ]);
    }
    const args =
      operation === 'read'
        ? ['lookup']
        : operation === 'remove'
          ? ['clear']
          : ['store', '--label=Commit Defender local data key'];
    if (operation === 'write' && key?.byteLength !== 32) throw unavailable();
    return this.command(
      '/usr/bin/secret-tool',
      [...args, 'service', this.service, 'account', reference],
      operation === 'write' ? Buffer.from(key!).toString('base64') : undefined,
    );
  }
  async read(reference: string): Promise<Buffer | undefined> {
    const result = await this.invoke('read', reference);
    // Keychain's item-not-found is distinct from authorization errors. Secret-tool reports
    // an absent item with status 1 and no diagnostic; unavailable/locked service is an error.
    if (
      (this.platform === 'darwin' && result.code === 44) ||
      (this.platform === 'linux' &&
        result.code === 1 &&
        !result.stderr.trim() &&
        !result.stdout.trim())
    )
      return undefined;
    if (result.code !== 0) throw unavailable();
    const text = result.stdout.trim();
    if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) throw unavailable();
    const key = Buffer.from(text, 'base64');
    if (key.length !== 32 || key.toString('base64') !== text) throw unavailable();
    return key;
  }
  async write(reference: string, key: Uint8Array): Promise<void> {
    const result = await this.invoke('write', reference, key);
    // The interactive macOS tool can exit 0 after a command failure; verify the exact key.
    if (result.code !== 0) throw unavailable();
    const stored = await this.read(reference);
    try {
      if (!stored || !stored.equals(Buffer.from(key))) throw unavailable();
    } finally {
      stored?.fill(0);
    }
  }
  async remove(reference: string): Promise<void> {
    const result = await this.invoke('remove', reference);
    if (result.code !== 0 && !(this.platform === 'darwin' && result.code === 44))
      throw unavailable();
  }
}
