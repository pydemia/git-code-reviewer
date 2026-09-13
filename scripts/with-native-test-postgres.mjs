// Explicit native PostgreSQL test backend. This is not a replacement for the
// pinned container, shared-volume, TLS or deployment verification gates.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const [command, ...args] = process.argv.slice(2);
const bin = process.env.GCR_TEST_POSTGRES_BIN;
if (!command || !bin || !path.isAbsolute(bin))
  throw Error(
    'Set GCR_TEST_POSTGRES_BIN to a native PostgreSQL bin directory; pass command [args...].',
  );
const resolvedBin = await realpath(bin);
const directory = await mkdtemp(path.join(tmpdir(), 'gcr-native-pg-'));
const data = path.join(directory, 'data');
const owner = randomUUID();
const evidence = {
  startedAt: new Date().toISOString(),
  backend: 'native-postgresql',
  binaryDirectory: resolvedBin,
  cleanup: false,
};
const password = randomBytes(24).toString('hex');
const environment = { ...process.env, PGPASSWORD: password, PGUSER: 'gcr_test' };
let startupAttempted = false,
  child,
  interrupted = false,
  interruptTimer;
const native = (name, parameters, timeout = 30_000) =>
  exec(path.join(bin, name), parameters, { env: environment, timeout, maxBuffer: 1024 * 1024 });
const stop = () => {
  interrupted = true;
  if (child?.pid) {
    const pid = child.pid;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      /* already exited */
    }
    if (!interruptTimer)
      interruptTimer = setTimeout(() => {
        if (child?.pid === pid) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            /* already exited */
          }
        }
      }, 5000);
  }
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  await writeFile(path.join(directory, 'owner.json'), JSON.stringify({ owner, data }), {
    mode: 0o600,
  });
  const passwordFile = path.join(directory, 'password');
  await writeFile(passwordFile, password + '\n', { mode: 0o600 });
  evidence.version = (await native('postgres', ['--version'])).stdout.trim();
  await native('initdb', [
    '-D',
    data,
    '-U',
    'gcr_test',
    '--pwfile',
    passwordFile,
    '--auth-host=scram-sha-256',
    '--auth-local=scram-sha-256',
    '--encoding=UTF8',
    '--locale=C',
  ]);
  if (interrupted) throw Error('Fixture interrupted before startup');
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  // A port race must fail startup. It must never stop another PostgreSQL server.
  await writeFile(
    path.join(data, 'postgresql.auto.conf'),
    `listen_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = ''\nmax_connections = 100\nshared_buffers = '64MB'\n`,
    { mode: 0o600 },
  );
  startupAttempted = true;
  await native(
    'pg_ctl',
    ['-D', data, '-l', path.join(directory, 'postgres.log'), '-w', '-t', '30', 'start'],
    35_000,
  );
  if (interrupted) throw Error('Fixture interrupted after startup');
  await native('createdb', ['-h', '127.0.0.1', '-p', String(port), '-U', 'gcr_test', 'gcr_test']);
  const connection = `postgresql://gcr_test:${password}@127.0.0.1:${port}/gcr_test`;
  child = spawn(command, args, {
    detached: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      GCR_TEST_DATABASE_URL: connection,
      GCR_TEST_POSTGRES_BIN: evidence.binaryDirectory,
      GCR_TEST_POSTGRES_DIRECTORY: data,
    },
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  child = undefined;
  clearTimeout(interruptTimer);
  evidence.commandExitCode = code;
  process.exitCode = interrupted ? 130 : code;
} catch (error) {
  // Child command output is already visible. Do not dump credential-bearing env.
  evidence.failure = interrupted ? 'interrupted' : 'native-fixture-failed';
  process.stderr.write(
    `Native PostgreSQL fixture failed (${typeof error.code === 'number' ? error.code : 'setup'}).\n`,
  );
  process.exitCode = interrupted ? 130 : 1;
} finally {
  try {
    const marker = JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8'));
    assert.equal(marker.owner, owner);
    assert.equal(marker.data, data);
    const status = async () => {
      try {
        await native('pg_ctl', ['-D', data, 'status']);
        return true;
      } catch (error) {
        if (error.code === 3) return false;
        throw error;
      }
    };
    if (startupAttempted && (await status()))
      await native('pg_ctl', ['-D', data, '-m', 'fast', '-w', '-t', '30', 'stop'], 35_000);
    if (startupAttempted) assert.equal(await status(), false);
    await rm(directory, { recursive: true, force: true });
    evidence.cleanup = true;
  } catch {
    evidence.retainedDirectory = directory;
    evidence.cleanup = false;
    process.exitCode = 1;
    process.stderr.write(`Owned PostgreSQL cleanup was not confirmed; retained ${directory}.\n`);
  }
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  evidence.finishedAt = new Date().toISOString();
  const output = process.env.GCR_TEST_POSTGRES_EVIDENCE;
  if (output) {
    assert(path.isAbsolute(output));
    await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  process.stderr.write(
    `Native PostgreSQL fixture: ${evidence.version ?? 'unavailable'}, cleanup=${evidence.cleanup}.\n`,
  );
}
