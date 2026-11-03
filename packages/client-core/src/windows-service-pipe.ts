import { spawn } from 'node:child_process';
import { windowsNativeExecutable } from './windows-native.js';
import { LocalServiceError } from './service-jobs.js';

const maximumLine = 12 * 1024 * 1024 + 256;

/** The native listener owns the SID-only DACL and local-only pipe handles. */
export async function startWindowsServicePipe(
  name: string,
  reply: (frame: Buffer) => Promise<Buffer>,
  failed: () => void,
) {
  const child = spawn(windowsNativeExecutable(), ['--pipe-server', String(process.pid)], {
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stopping = false;
  let ready = false;
  let input = Buffer.alloc(0);
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const active = new Set<number>();
  const fault = () => {
    if (stopping) return;
    stopping = true;
    rejectReady(new LocalServiceError('service-unavailable'));
    child.kill();
    if (ready) failed();
  };
  const exited = new Promise<void>((resolve) => {
    child.once('close', () => {
      fault();
      resolve();
    });
  });
  child.once('error', fault);
  child.stdin.on('error', fault);
  // Diagnostics are deliberately not forwarded: IPC frames contain local source.
  child.stderr.on('data', fault);
  child.stdout.on('data', (chunk: Buffer) => {
    input = Buffer.concat([input, chunk]);
    for (;;) {
      const end = input.indexOf(10);
      if (end < 0) break;
      if (end > maximumLine) return fault();
      const line = input.subarray(0, end);
      input = input.subarray(end + 1);
      try {
        const event = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(line));
        if (!ready) {
          if (event.ready !== true) return fault();
          ready = true;
          resolveReady();
          continue;
        }
        if (
          !Number.isSafeInteger(event.id) ||
          event.id < 1 ||
          typeof event.bytes !== 'string' ||
          active.has(event.id) ||
          active.size >= 8
        )
          return fault();
        const id = event.id as number;
        active.add(id);
        void reply(Buffer.from(event.bytes, 'base64'))
          .then((bytes) => {
            if (!stopping)
              child.stdin.write(JSON.stringify({ id, bytes: bytes.toString('base64') }) + '\n');
          })
          .catch(fault)
          .finally(() => active.delete(id));
      } catch {
        return fault();
      }
    }
    if (input.length > maximumLine) fault();
  });
  const timer = setTimeout(fault, 15000);
  child.stdin.write(JSON.stringify({ name }) + '\n');
  try {
    await started;
  } catch (error) {
    await exited;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return {
    async close() {
      stopping = true;
      child.stdin.end();
      const deadline = setTimeout(() => child.kill(), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}
