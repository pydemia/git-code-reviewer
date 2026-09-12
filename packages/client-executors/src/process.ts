// Adapted from Commit Defender src/ai/providers.ts at 35575ad (Apache-2.0).
// Adds process-group termination, a hard kill deadline and bounded byte streams.
import { spawn } from 'node:child_process';

export class ExecutorError extends Error {
  constructor(
    readonly code:
      | 'cancelled'
      | 'timeout'
      | 'output-limit'
      | 'executable-unavailable'
      | 'process-failed'
      | 'cleanup-failed'
      | 'executor-unavailable'
      | 'invalid-response',
  ) {
    super(code);
    this.name = code === 'cancelled' ? 'AbortError' : 'ExecutorError';
  }
}

export interface ManagedProcessInput {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs: number;
  outputBytes?: number;
  signal?: AbortSignal;
}

/** POSIX process groups only. A child that deliberately creates another session is
 * outside this primitive's guarantee. Enabled adapters must expose no command tools
 * or user-configured subprocess launchers that could escape their group. */
export async function runManagedProcess(input: ManagedProcessInput): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  if (!['darwin', 'linux'].includes(process.platform))
    throw new ExecutorError('executor-unavailable');
  if (input.signal?.aborted) throw new ExecutorError('cancelled');
  const maximum = input.outputBytes ?? 4 * 1024 * 1024;
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 600_000 ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 16 * 1024 * 1024 ||
    Buffer.byteLength(input.stdin) > 2 * 1024 * 1024
  )
    throw new ExecutorError('executor-unavailable');
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: { ...input.env },
      detached: true,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let failure: ExecutorError | undefined;
    let total = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let closed = false;
    let code: number | null = null;
    let done = false;
    let terminating = false;
    let killed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => stop(new ExecutorError('timeout')), input.timeoutMs);

    const finish = (): void => {
      if (done || !closed || !killed) return;
      done = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      input.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
    };
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          failure ??= new ExecutorError('cleanup-failed');
      }
    };
    function stop(error?: ExecutorError): void {
      failure ??= error;
      if (terminating) return;
      terminating = true;
      child.stdin.destroy();
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => {
        signalGroup('SIGKILL');
        killed = true;
        finish();
        if (!done)
          drainTimer = setTimeout(() => {
            // Never return success while an inherited stream keeps the run open.
            failure ??= new ExecutorError('cleanup-failed');
            child.stdout.destroy();
            child.stderr.destroy();
            closed = true;
            finish();
          }, 750);
      }, 250);
    }
    const abort = (): void => stop(new ExecutorError('cancelled'));
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    const collect = (target: Buffer[], chunk: Buffer): void => {
      if (failure || done) return;
      if (chunk.length > maximum - total) {
        stop(new ExecutorError('output-limit'));
        return;
      }
      total += chunk.length;
      target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      stop(
        new ExecutorError(error.code === 'ENOENT' ? 'executable-unavailable' : 'process-failed'),
      );
    });
    // Even a successful leader can leave descendants holding pipe descriptors.
    child.on('exit', () => stop());
    child.on('close', (exitCode) => {
      closed = true;
      code = exitCode;
      stop();
      finish();
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && !terminating) stop(new ExecutorError('process-failed'));
    });
    child.stdin.end(input.stdin);
  });
}
