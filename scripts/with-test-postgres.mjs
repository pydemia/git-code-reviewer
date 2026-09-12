// Run a command with an owned, disposable PostgreSQL database. Credentials are
// passed only through a private env file / child environment, never argv or logs.
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const image = 'postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73';
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Usage: node scripts/with-test-postgres.mjs command [args...]');
const directory = await mkdtemp(path.join(tmpdir(), 'gcr-test-pg-'));
const name = `gcr-test-pg-${randomUUID()}`;
const password = randomBytes(24).toString('hex');
let owned = false,
  child,
  interrupted = false;
const docker = async (args) =>
  (await exec('docker', args, { timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim();
const stop = () => {
  interrupted = true;
  child?.kill('SIGTERM');
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const envFile = path.join(directory, 'postgres.env');
  await writeFile(
    envFile,
    `POSTGRES_USER=gcr_test\nPOSTGRES_DB=gcr_test\nPOSTGRES_PASSWORD=${password}\n`,
    { mode: 0o600 },
  );
  await docker([
    'run',
    '-d',
    '--pull=never',
    '--name',
    name,
    '--tmpfs',
    '/var/lib/postgresql/data',
    '-p',
    '127.0.0.1::5432',
    '--memory',
    '1g',
    '--env-file',
    envFile,
    image,
    '-c',
    'max_connections=200',
  ]);
  owned = true;
  const port = Number((await docker(['port', name, '5432/tcp'])).split(':').at(-1));
  let ready = false;
  for (let attempt = 0; attempt < 30 && !interrupted; attempt++) {
    try {
      ready = (
        await docker(['exec', name, 'pg_isready', '-U', 'gcr_test', '-d', 'gcr_test'])
      ).includes('accepting connections');
    } catch {
      /* initialization */
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready || interrupted) throw new Error('Disposable PostgreSQL did not become ready');
  const connection = `postgresql://gcr_test:${password}@127.0.0.1:${port}/gcr_test`;
  child = spawn(command, args, {
    stdio: 'inherit',
    env: { ...process.env, GCR_TEST_DATABASE_URL: connection },
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = interrupted ? 130 : code;
} finally {
  if (owned) await docker(['rm', '-f', '-v', name]);
  await rm(directory, { recursive: true, force: true });
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
