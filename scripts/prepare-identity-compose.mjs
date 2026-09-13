// Generate credentials and a private CA for a NEW local integration environment.
// Never adopt/reset an existing volume or modify OS trust, DNS, Docker, or auth.
import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFile = promisify(execFileCallback);
const root = fileURLToPath(new URL('../', import.meta.url));
const hostPattern =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
export async function prepareFreshIdentity(directory, environment = process.env) {
  if (!path.isAbsolute(directory)) throw Error('An absolute new identity directory is required');
  const absolute = path.resolve(directory);
  // Resolve the existing parent so a symlink cannot place credentials in Git.
  const parent = await realpath(path.dirname(absolute));
  directory = path.join(parent, path.basename(absolute));
  const repository = await realpath(root);
  if (
    directory === repository ||
    directory.startsWith(repository + path.sep) ||
    /['\r\n\0]/.test(directory)
  )
    throw Error('Choose a new identity directory outside the repository');
  const images = {};
  for (const name of ['GCR_RUNTIME_IMAGE', 'GCR_IDENTITY_IMAGE', 'GCR_POSTGRES_IMAGE']) {
    const value = environment[name];
    if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(value))
      throw Error(`A verified repository@sha256 image is required: ${name}`);
    images[name] = value;
  }
  const publicHost = environment.GCR_PUBLIC_HOST ?? 'gcr.test';
  const identityHost = environment.GCR_IDENTITY_HOST ?? 'identity.test';
  const port = Number(environment.GCR_HTTPS_PORT ?? 8443);
  if (
    !hostPattern.test(publicHost) ||
    !hostPattern.test(identityHost) ||
    publicHost === identityHost ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  )
    throw Error('Distinct local DNS hostnames and an unprivileged HTTPS port are required');
  await mkdir(directory, { mode: 0o700 }); // EEXIST is intentional; never rotate on repeat.
  try {
    const write = async (name, value, mode = 0o640) => {
      await writeFile(path.join(directory, name), value, { flag: 'wx', mode });
      await chmod(path.join(directory, name), mode);
    };
    const openssl = (...args) =>
      execFile('openssl', args, { cwd: directory, timeout: 30_000, maxBuffer: 64 * 1024 });
    for (const name of [
      'dba-password',
      'app-db-password',
      'migrator-db-password',
      'keycloak-db-password',
      'session-secret',
      'identity-admin-client-secret',
      'bootstrap-admin-password',
    ])
      await write(name, randomBytes(32).toString('base64url'));
    await write('credential-encryption-key', randomBytes(32).toString('base64'));
    await write('bootstrap-admin-username', 'gcr-bootstrap-' + randomBytes(6).toString('hex'));
    const plan = JSON.parse(
      await readFile(path.join(root, 'deploy/postgres/shared-plan.example.json'), 'utf8'),
    );
    delete plan.legacyOwner;
    await write('database-plan.json', JSON.stringify(plan, null, 2) + '\n', 0o644);
    await openssl(
      'req',
      '-x509',
      '-newkey',
      'rsa:3072',
      '-nodes',
      '-sha256',
      '-days',
      '365',
      '-keyout',
      'ca.key',
      '-out',
      'ca.crt',
      '-subj',
      '/CN=GCR local integration CA',
    );
    for (const [name, hosts] of [
      ['proxy', [publicHost, identityHost]],
      ['keycloak', ['keycloak']],
      ['postgres', ['postgres']],
    ]) {
      await openssl(
        'req',
        '-new',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-sha256',
        '-keyout',
        `${name}-tls-key`,
        '-out',
        `${name}.csr`,
        '-subj',
        `/CN=${hosts[0]}`,
      );
      await write(
        `${name}.ext`,
        'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=' +
          hosts.map((host) => `DNS:${host}`).join(',') +
          '\n',
      );
      await openssl(
        'x509',
        '-req',
        '-in',
        `${name}.csr`,
        '-CA',
        'ca.crt',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-out',
        `${name}-tls-cert`,
        '-days',
        '90',
        '-sha256',
        '-extfile',
        `${name}.ext`,
      );
      await chmod(path.join(directory, `${name}-tls-key`), 0o640);
      await chmod(path.join(directory, `${name}-tls-cert`), 0o644);
      await rm(path.join(directory, `${name}.csr`));
      await rm(path.join(directory, `${name}.ext`));
    }
    await openssl(
      'req',
      '-x509',
      '-newkey',
      'rsa:3072',
      '-nodes',
      '-sha256',
      '-days',
      '90',
      '-keyout',
      'sp-signing-key',
      '-out',
      'sp-signing-cert',
      '-subj',
      '/CN=GCR local SAML SP',
    );
    await chmod(path.join(directory, 'ca.key'), 0o600); // Never mounted in a container.
    await chmod(path.join(directory, 'ca.crt'), 0o644);
    await chmod(path.join(directory, 'sp-signing-key'), 0o640);
    await chmod(path.join(directory, 'sp-signing-cert'), 0o644);
    const gid = (await stat(path.join(directory, 'app-db-password'))).gid;
    const projectName = 'gcr-identity-' + randomBytes(8).toString('hex');
    const values = {
      ...images,
      COMPOSE_PROJECT_NAME: projectName,
      GCR_IDENTITY_DIRECTORY: directory,
      GCR_SECRET_GID: String(gid),
      GCR_PUBLIC_HOST: publicHost,
      GCR_IDENTITY_HOST: identityHost,
      GCR_HTTPS_PORT: String(port),
      GCR_DBA_USER: 'gcr_dba',
    };
    await write(
      'compose.env',
      Object.entries(values)
        .map(([name, value]) => `${name}='${value}'`)
        .join('\n') + '\n',
    );
    return {
      directory,
      projectName,
      publicOrigin: `https://${publicHost}:${port}`,
      identityOrigin: `https://${identityHost}:${port}`,
      secretGid: gid,
      postgresMajor: 17,
      freshOnly: true,
    };
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw Error('New local identity preparation failed; its generated files were removed');
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    if (process.argv[2] !== '--fresh' || !process.argv[3] || process.argv.length !== 4)
      throw Error(
        'Usage: node scripts/prepare-identity-compose.mjs --fresh /absolute/new-directory',
      );
    console.log(JSON.stringify(await prepareFreshIdentity(process.argv[3]), null, 2));
  } catch (error) {
    console.error(
      error.code === 'EEXIST'
        ? 'Identity directory already exists; no files were changed'
        : error.code
          ? 'Local identity preparation failed before initialization'
          : error.message,
    );
    process.exitCode = 1;
  }
}
