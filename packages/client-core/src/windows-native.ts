import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { LocalStoreError, type LocalStoreErrorCode } from './local-errors.js';

const maximum = 36 * 1024 * 1024;
const directory =
  typeof import.meta.url === 'string' ? path.dirname(fileURLToPath(import.meta.url)) : __dirname;
const nativeDirectory =
  path.basename(directory) === 'src' ? path.join(directory, '..', 'dist') : directory;

/** Windows worker_threads use a case-sensitive environment object. */
export function windowsEnvironmentValue(name: string): string | undefined {
  const key = Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : process.env[key];
}

export function windowsPrivateTemporary(prefix: string): string {
  if (!/^[a-z0-9-]+$/.test(prefix)) throw Error('Invalid temporary prefix.');
  const target = path.join(os.tmpdir(), `${prefix}${randomUUID()}`);
  const result = windowsNativeSync({ operation: 'directory', path: target });
  if (!result.path) throw new LocalStoreError('storage-unavailable', 'Missing temporary path.');
  return result.path;
}
export interface WindowsNativeResult {
  error?: string;
  bytes?: string;
  missing?: boolean;
  published?: boolean;
  path?: string;
  dataDirectory?: string;
  code?: number;
  stdout?: string;
  stderr?: string;
}

export function windowsNativeExecutable(): string {
  if (process.platform !== 'win32')
    throw new LocalStoreError('unsupported-platform', 'Windows helper required.');
  try {
    const executable = path.join(nativeDirectory, 'windows-native.exe');
    const manifest = JSON.parse(
      readFileSync(path.join(nativeDirectory, 'windows-native.json'), 'utf8'),
    ) as { version: string; sha256: string };
    const hash = createHash('sha256').update(readFileSync(executable)).digest('hex');
    if (manifest.version !== '1.0.2' || hash !== manifest.sha256) throw Error();
    return executable;
  } catch {
    throw new LocalStoreError('storage-unavailable', 'Windows helper is unavailable.');
  }
}

function decode(stdout: string): WindowsNativeResult {
  try {
    const value: unknown = JSON.parse(stdout.trim());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value as WindowsNativeResult;
  } catch {
    throw new LocalStoreError('storage-unavailable', 'Invalid Windows helper response.');
  }
}
export function checkWindowsStorage(result: WindowsNativeResult): WindowsNativeResult {
  if (result.error) {
    const codes: LocalStoreErrorCode[] = [
      'unsupported-platform',
      'credential-unavailable',
      'storage-unavailable',
      'insecure-storage',
      'corrupt-storage',
      'commit-unknown',
      'record-too-large',
    ];
    const code = codes.includes(result.error as LocalStoreErrorCode)
      ? (result.error as LocalStoreErrorCode)
      : 'storage-unavailable';
    throw new LocalStoreError(code, `Windows operation failed (${code}).`);
  }
  return result;
}

export function windowsNativeSync(request: Record<string, unknown>): WindowsNativeResult {
  const input = JSON.stringify(request) + '\n';
  if (Buffer.byteLength(input) > maximum)
    throw new LocalStoreError('record-too-large', 'Windows request exceeds its limit.');
  let stdout: string;
  try {
    stdout = execFileSync(windowsNativeExecutable(), [], {
      input,
      encoding: 'utf8',
      maxBuffer: maximum,
      timeout: 15_000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const result = error as { stdout?: string; status?: number };
    if (result.status === 1 && result.stdout) stdout = result.stdout;
    else throw new LocalStoreError('storage-unavailable', 'Windows helper failed.');
  }
  return checkWindowsStorage(decode(stdout));
}

type NativeOptions = { signal?: AbortSignal; timeoutMs?: number };
type StorageRequest = {
  input: string;
  bytes: number;
  publishing: boolean;
  resolve(value: WindowsNativeResult): void;
  signal: AbortSignal | undefined;
  abort(): void;
  timer: ReturnType<typeof setTimeout>;
};

/** One serialized pipe per Node process/worker, closed when idle or its owner exits. */
class WindowsStorageSession {
  private readonly child;
  private readonly queue: StorageRequest[] = [];
  private active: StorageRequest | undefined;
  private bytes = 0;
  private output = Buffer.alloc(0);
  private idle?: ReturnType<typeof setTimeout>;
  private closed = false;
  private failure: string | undefined;

  constructor(
    executable: string,
    private readonly onClose: () => void,
  ) {
    this.child = spawn(executable, ['--storage-session', String(process.pid)], {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.on('error', () => this.stop('storage-unavailable'));
    this.child.on('close', () => {
      this.stop('storage-unavailable');
      const error = this.failure ?? 'storage-unavailable';
      if (this.active) {
        this.finish(this.active, {
          error: this.active.publishing ? 'commit-unknown' : error,
        });
        this.active = undefined;
      }
      for (const request of this.queue.splice(0)) this.finish(request, { error });
    });
    this.child.stdin.on('error', () => this.stop('storage-unavailable'));
    this.child.stderr.on('data', () => this.stop('storage-unavailable'));
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.closed) return;
      if (!this.active || this.output.length + chunk.length > maximum) {
        this.stop('storage-unavailable');
        return;
      }
      this.output = Buffer.concat([this.output, chunk]);
      const end = this.output.indexOf(10);
      if (end < 0) return;
      if (end !== this.output.length - 1) {
        this.stop('storage-unavailable');
        return;
      }
      let result: WindowsNativeResult;
      try {
        result = decode(this.output.toString('utf8'));
      } catch {
        this.stop('storage-unavailable');
        return;
      }
      this.output.fill(0);
      this.output = Buffer.alloc(0);
      const request = this.active;
      this.active = undefined;
      this.finish(request, result);
      this.next();
    });
  }

  request(input: string, publishing: boolean, options: NativeOptions) {
    const bytes = Buffer.byteLength(input);
    if (this.closed || this.queue.length >= 64 || this.bytes + bytes > maximum)
      return Promise.resolve({ error: 'storage-unavailable' });
    clearTimeout(this.idle);
    return new Promise<WindowsNativeResult>((resolve) => {
      const abort = () => {
        if (this.active === request) this.stop('cancelled');
        else {
          const index = this.queue.indexOf(request);
          if (index >= 0) {
            this.queue.splice(index, 1);
            this.finish(request, { error: 'cancelled' });
          }
        }
      };
      const request: StorageRequest = {
        input,
        bytes,
        publishing,
        resolve,
        signal: options.signal,
        abort,
        timer: setTimeout(() => {
          if (this.active === request) this.stop('timeout');
          else {
            const index = this.queue.indexOf(request);
            if (index >= 0) {
              this.queue.splice(index, 1);
              this.finish(request, { error: 'timeout' });
            }
          }
        }, options.timeoutMs ?? 15000),
      };
      this.bytes += bytes;
      this.queue.push(request);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      this.next();
    });
  }

  private finish(request: StorageRequest, result: WindowsNativeResult) {
    clearTimeout(request.timer);
    request.signal?.removeEventListener('abort', request.abort);
    this.bytes -= request.bytes;
    request.input = '';
    request.resolve(result);
  }

  private next() {
    if (this.closed || this.active) return;
    this.active = this.queue.shift();
    if (this.active) this.child.stdin.write(this.active.input);
    else
      this.idle = setTimeout(() => {
        this.closed = true;
        this.onClose();
        this.child.stdin.end();
      }, 100);
  }

  private stop(error: string) {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    clearTimeout(this.idle);
    this.onClose();
    this.child.kill();
    this.output.fill(0);
    this.output = Buffer.alloc(0);
    if (this.active) clearTimeout(this.active.timer);
    for (const request of this.queue) clearTimeout(request.timer);
  }
}

let storageSession: WindowsStorageSession | undefined;
const storageOperations = new Set([
  'credential',
  'directory',
  'validate-directory',
  'read',
  'publish',
]);

/** Keep stdin open in process mode: EOF is the native parent's death signal. */
export function windowsNative(
  request: Record<string, unknown>,
  options: NativeOptions = {},
): Promise<WindowsNativeResult> {
  const input = JSON.stringify(request) + '\n';
  if (Buffer.byteLength(input) > maximum)
    return Promise.reject(new LocalStoreError('record-too-large', 'Windows request too large.'));
  if (options.signal?.aborted) return Promise.resolve({ error: 'cancelled' });
  const executable = windowsNativeExecutable();
  if (storageOperations.has(String(request.operation))) {
    storageSession ??= new WindowsStorageSession(executable, () => {
      storageSession = undefined;
    });
    return storageSession.request(input, request.operation === 'publish', options);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: string | undefined;
    const stop = (reason: string) => {
      failure ??= reason;
      child.kill();
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? 15_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximum) stop('output-limit');
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximum) stop('output-limit');
    });
    child.on('error', () => {
      failure ??= 'executable-unavailable';
    });
    child.stdin.on('error', () => {
      failure ??= 'process-failed';
    });
    child.on('close', () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (failure) {
        resolve({ error: failure });
        return;
      }
      try {
        resolve(decode(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    if (request.operation === 'process') child.stdin.write(input);
    else child.stdin.end(input);
  });
}
