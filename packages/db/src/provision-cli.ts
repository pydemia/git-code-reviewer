import { readFile } from 'node:fs/promises';
import {
  inspectSharedPostgres,
  provisionSharedPostgres,
  SharedPostgresError,
  type SharedPostgresPlan,
} from './shared-postgres.js';

async function required(name: string): Promise<string> {
  const value = process.env[name];
  if (!value) throw new SharedPostgresError(`Missing configuration: ${name}`);
  return value;
}

async function secret(name: string): Promise<string> {
  try {
    const value = (await readFile(await required(name), 'utf8')).trim();
    if (value) return value;
  } catch {
    /* Do not expose paths, URLs, certificates or credentials in errors. */
  }
  throw new SharedPostgresError(`Invalid secret file: ${name}`);
}

try {
  const [mode, file, ...extra] = process.argv.slice(2);
  if (!['--inspect', '--apply'].includes(mode ?? '') || !file || extra.length)
    throw new SharedPostgresError(
      'Usage: node packages/db/dist/provision-cli.js --inspect|--apply plan.json',
    );
  const host = await required('GCR_DBA_HOST');
  const port = Number(await required('GCR_DBA_PORT'));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new SharedPostgresError('Invalid configuration: GCR_DBA_PORT');
  const allowPlaintext =
    process.env.GCR_DBA_ALLOW_LOOPBACK_PLAINTEXT === 'true' &&
    ['127.0.0.1', '::1', 'localhost'].includes(host);
  const ssl = process.env.GCR_DBA_CA_FILE
    ? { ca: await secret('GCR_DBA_CA_FILE'), rejectUnauthorized: true }
    : allowPlaintext
      ? false
      : undefined;
  if (ssl === undefined)
    throw new SharedPostgresError(
      'GCR_DBA_CA_FILE is required outside an explicit loopback fixture',
    );
  const options = {
    admin: {
      host,
      port,
      database: await required('GCR_DBA_DATABASE'),
      user: await required('GCR_DBA_USER'),
      password: await secret('GCR_DBA_PASSWORD_FILE'),
      ssl,
    },
    plan: JSON.parse(await readFile(file, 'utf8')) as SharedPostgresPlan,
  };
  const report =
    mode === '--apply'
      ? await provisionSharedPostgres({
          ...options,
          passwords: {
            gcr_app: await secret('GCR_APP_PASSWORD_FILE'),
            gcr_migrator: await secret('GCR_MIGRATOR_PASSWORD_FILE'),
            gcr_keycloak: await secret('GCR_KEYCLOAK_PASSWORD_FILE'),
          },
        })
      : await inspectSharedPostgres(options);
  process.stdout.write(`${JSON.stringify({ mode, ...report }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof SharedPostgresError ? error.message : 'Shared PostgreSQL provisioning failed; inspect DBA server diagnostics privately'}\n`,
  );
  process.exitCode = 1;
}
