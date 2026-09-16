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
    if (manifest.version !== '1.0.1' || hash !== manifest.sha256) throw Error();
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

/** Keep stdin open in process mode: EOF is the native parent's death signal. */
export function windowsNative(
  request: Record<string, unknown>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<WindowsNativeResult> {
  const input = JSON.stringify(request) + '\n';
  if (Buffer.byteLength(input) > maximum)
    return Promise.reject(new LocalStoreError('record-too-large', 'Windows request too large.'));
  if (options.signal?.aborted) return Promise.resolve({ error: 'cancelled' });
  const executable = windowsNativeExecutable();
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
