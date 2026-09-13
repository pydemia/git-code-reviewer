import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, provisionSharedPostgres, type Database } from '@gcr/db';
import { loadConfig, type AppConfig } from './config.js';
import { runtimeDatabase } from './database.js';
import { migrate, waitMigrations } from './commands.js';
import { buildServer } from './server.js';
import { runWorker } from './jobs/worker.js';

describe
  .skipIf(!process.env.GCR_TEST_DATABASE_URL)
  .sequential('Runtime isolated database transport', { timeout: 30_000 }, () => {
    const exec = promisify(execFile),
      name = `gcr-runtime-tls-${randomUUID()}`;
    const passwords = {
      gcr_app: randomBytes(24).toString('hex'),
      gcr_migrator: randomBytes(24).toString('hex'),
      gcr_keycloak: randomBytes(24).toString('hex'),
    };
    let directory: string,
      ca: string,
      admin: Database,
      adminUrl: string,
      port: number,
      owned = false;
    let appConfig: AppConfig, migrationConfig: AppConfig;
    const docker = async (args: string[]) =>
      (await exec('docker', args, { timeout: 30_000 })).stdout.trim();
    const url = (user: keyof typeof passwords, host = '127.0.0.1') => {
      const target = new URL(adminUrl);
      target.username = user;
      target.password = passwords[user];
      target.hostname = host;
      target.pathname = '/git_code_reviewer';
      return target.toString();
    };
    const appPool = () => runtimeDatabase(appConfig, 'gcr_app', 2);
    beforeAll(async () => {
      directory = await mkdtemp(path.join(tmpdir(), 'gcr-runtime-tls-'));
      const caConfig = path.join(directory, 'ca.cnf');
      await writeFile(
        caConfig,
        '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=GCR isolated database test CA\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n',
      );
      await exec('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-config',
        caConfig,
        '-keyout',
        path.join(directory, 'ca.key'),
        '-out',
        path.join(directory, 'ca.crt'),
      ]);
      await exec('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-config',
        caConfig,
        '-keyout',
        path.join(directory, 'other-ca.key'),
        '-out',
        path.join(directory, 'other-ca.crt'),
      ]);
      await exec('openssl', [
        'req',
        '-new',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-subj',
        '/CN=database.invalid',
        '-keyout',
        path.join(directory, 'server.key'),
        '-out',
        path.join(directory, 'server.csr'),
      ]);
      const leafConfig = path.join(directory, 'leaf.cnf');
      // IP only: connecting as localhost must fail hostname validation even with the trusted CA.
      await writeFile(
        leafConfig,
        'basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n',
      );
      await exec('openssl', [
        'x509',
        '-req',
        '-in',
        path.join(directory, 'server.csr'),
        '-CA',
        path.join(directory, 'ca.crt'),
        '-CAkey',
        path.join(directory, 'ca.key'),
        '-CAcreateserial',
        '-days',
        '1',
        '-extfile',
        leafConfig,
        '-out',
        path.join(directory, 'server.crt'),
      ]);
      ca = await readFile(path.join(directory, 'ca.crt'), 'utf8');
      const adminPassword = randomBytes(24).toString('hex');
      const envFile = path.join(directory, 'postgres.env');
      await writeFile(
        envFile,
        `POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=${adminPassword}\nPOSTGRES_DB=postgres\nPGDATA=/var/lib/postgresql/data\n`,
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
        '--mount',
        `type=bind,source=${directory},target=/run/gcr-tls,readonly`,
        '--entrypoint',
        '/bin/sh',
        process.env.GCR_ISOLATION_POSTGRES_18 === 'true'
          ? 'postgres@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2'
          : 'postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73',
        '-ec',
        'cp /run/gcr-tls/server.crt /tmp/server.crt; cp /run/gcr-tls/server.key /tmp/server.key; chown postgres:postgres /tmp/server.*; chmod 600 /tmp/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key',
      ]);
      owned = true;
      port = Number((await docker(['port', name, '5432/tcp'])).split(':').at(-1));
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          if (
            (
              await docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'])
            ).includes('accepting connections')
          )
            break;
        } catch {
          /* Initial PostgreSQL startup */
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      adminUrl = `postgresql://postgres:${adminPassword}@127.0.0.1:${port}/postgres`;
      admin = createDatabase(adminUrl, 1, { tlsCa: ca });
      await admin.query('select 1');
      await docker([
        'exec',
        name,
        'sh',
        '-ec',
        'file="$PGDATA/pg_hba.conf"; { printf "hostnossl all all 0.0.0.0/0 reject\\nhostnossl all all ::0/0 reject\\n"; cat "$file"; } > "$file.gcr"; cat "$file.gcr" > "$file"; rm "$file.gcr"',
      ]);
      await admin.query('select pg_reload_conf()');
      const example = JSON.parse(
        await readFile('deploy/postgres/shared-plan.example.json', 'utf8'),
      );
      delete example.legacyOwner;
      await provisionSharedPostgres({
        admin: {
          host: '127.0.0.1',
          port,
          user: 'postgres',
          password: adminPassword,
          database: 'postgres',
          ssl: { ca, rejectUnauthorized: true },
        },
        plan: example,
        passwords,
      });
      const common = {
        NODE_ENV: 'test',
        DATABASE_ISOLATED_ROLES: 'true',
        DATABASE_TLS_MODE: 'verify-full',
        DATABASE_TLS_CA_FILE: path.join(directory, 'ca.crt'),
        MIGRATIONS_DIR: path.resolve('packages/db/migrations'),
        AUTH_MODE: 'development',
        GITHUB_MODE: 'disabled',
        DATABASE_POOL_MAX: '2',
        ARTIFACT_ROOT: path.join(directory, 'artifacts'),
        WORKSPACE_ROOT: path.join(directory, 'workspaces'),
        WEB_DIST: path.resolve('apps/web/dist'),
      };
      const passwordFile = path.join(directory, 'migration-password');
      await writeFile(passwordFile, passwords.gcr_migrator, { mode: 0o600 });
      migrationConfig = loadConfig(
        {
          ...common,
          DATABASE_URL: url('gcr_app'),
          MIGRATION_DATABASE_HOST: '127.0.0.1',
          MIGRATION_DATABASE_PORT: String(port),
          MIGRATION_DATABASE_NAME: 'git_code_reviewer',
          MIGRATION_DATABASE_USER: 'gcr_migrator',
          MIGRATION_DATABASE_PASSWORD_FILE: passwordFile,
        },
        'migrate',
      );
      appConfig = loadConfig({ ...common, DATABASE_URL: url('gcr_app') });
    }, 60_000);
    afterAll(async () => {
      await admin?.end();
      if (owned) await docker(['rm', '-f', '-v', name]);
      if (directory) await rm(directory, { recursive: true, force: true });
    }, 30_000);

    it('uses the migration file credential over the app URL, then checks readiness with read-only app credentials', async () => {
      expect(new URL(migrationConfig.DATABASE_URL).username).toBe('gcr_migrator');
      await expect(
        waitMigrations({ ...appConfig, MIGRATIONS_WAIT_TIMEOUT_MS: 100 }),
      ).rejects.toThrow('readiness deadline');
      await migrate(migrationConfig);
      await waitMigrations(appConfig);
      // The artifact verification run builds the runtime first and opts into
      // checking the actual compiled command dispatcher in separate processes.
      if (process.env.GCR_TEST_COMPILED_RUNTIME === 'true') {
        for (const command of ['migrate', 'wait-migrations']) {
          const environment = Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) => !key.startsWith('DATABASE_') && !key.startsWith('MIGRATION_DATABASE_'),
            ),
          );
          for (const [key, value] of Object.entries(appConfig))
            if (value !== undefined) environment[key] = String(value);
          if (command === 'migrate')
            environment.MIGRATION_DATABASE_URL = migrationConfig.DATABASE_URL;
          const output = await exec(process.execPath, ['apps/runtime/dist/index.js', command], {
            env: environment,
            timeout: 15_000,
          });
          expect(output.stdout).toContain(
            command === 'migrate' ? 'Migrations applied' : 'Database migrations ready',
          );
        }
      }
      const pool = appPool();
      try {
        expect(
          (
            await pool.query(
              'select current_user,session_user,(select ssl from pg_stat_ssl where pid=pg_backend_pid()) as tls',
            )
          ).rows[0],
        ).toEqual({ current_user: 'gcr_app', session_user: 'gcr_app', tls: true });
        expect(
          (await pool.query('select count(*)::int as count from schema_migrations')).rows[0]!.count,
        ).toBe(36);
        await expect(pool.query('delete from schema_migrations')).rejects.toMatchObject({
          code: '42501',
        });
      } finally {
        await pool.end();
      }
    });

    it('rejects untrusted certificates, a wrong hostname and plaintext access', async () => {
      const untrusted = createDatabase(url('gcr_app'), 1, {
        tlsCa: await readFile(path.join(directory, 'other-ca.crt'), 'utf8'),
      });
      try {
        await expect(untrusted.query('select 1')).rejects.toMatchObject({
          code: expect.stringMatching(/CERT|SIGNATURE/),
        });
      } finally {
        await untrusted.end();
      }
      const wrongHost = createDatabase(url('gcr_app', 'localhost'), 1, { tlsCa: ca });
      try {
        await expect(wrongHost.query('select 1')).rejects.toMatchObject({
          code: 'ERR_TLS_CERT_ALTNAME_INVALID',
        });
      } finally {
        await wrongHost.end();
      }
      const plaintext = createDatabase(url('gcr_app'), 1);
      try {
        await expect(plaintext.query('select 1')).rejects.toMatchObject({ code: '28000' });
      } finally {
        await plaintext.end();
      }
    });

    it('rejects URL overrides without leaking credentials or opening a connection', () => {
      for (const key of [
        'ssl',
        'sslmode',
        'sslrootcert',
        'sslnegotiation',
        'uselibpqcompat',
        'host',
        'user',
        'password',
        'options',
      ]) {
        const target = new URL(url('gcr_app'));
        target.searchParams.set(key, 'disable');
        expect(() =>
          createDatabase(target.toString(), 1, { tlsCa: ca, expectedRole: 'gcr_app' }),
        ).toThrow('Invalid secure database connection URL');
      }
      expect(() =>
        createDatabase(url('gcr_migrator'), 1, { tlsCa: ca, expectedRole: 'gcr_app' }),
      ).toThrow('Invalid secure database connection URL');
      expect(() => createDatabase(url('gcr_app'), 1, { expectedRole: 'gcr_app' })).toThrow(
        'require verified TLS',
      );
    });

    it('checks each new connection and discards a role with elevated privileges before the first application query', async () => {
      const pool = appPool();
      try {
        const first = await pool.connect();
        first.release(true);
        await admin.query('alter role gcr_app createdb');
        try {
          await expect(
            pool.query("insert into service_metadata(key,value) values ('must-not-write','{}')"),
          ).rejects.toThrow('role isolation verification failed');
        } finally {
          await admin.query('alter role gcr_app nocreatedb');
        }
        expect(pool.totalCount).toBe(0);
        expect(
          (await pool.query("select 1 from service_metadata where key='must-not-write'")).rowCount,
        ).toBe(0);
      } finally {
        await pool.end();
      }
    });

    it('refuses cross-database PUBLIC grants and privilege escalation through role membership', async () => {
      await admin.query('grant connect on database git_code_reviewer_keycloak to public');
      let pool = appPool();
      try {
        await expect(pool.query('select 1')).rejects.toThrow('role isolation verification failed');
      } finally {
        await pool.end();
        await admin.query('revoke connect on database git_code_reviewer_keycloak from public');
      }
      await admin.query('grant gcr_migrator to gcr_app');
      pool = appPool();
      try {
        await expect(pool.query('select 1')).rejects.toThrow('role isolation verification failed');
      } finally {
        await pool.end();
        await admin.query('revoke gcr_migrator from gcr_app');
      }
    });

    it('serves the real application and runs the worker with the non-owner TLS login', async () => {
      const app = await buildServer(appConfig);
      try {
        expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
        expect((await app.inject({ method: 'GET', url: '/api/v1/me' })).statusCode).toBe(200);
      } finally {
        await app.close();
      }
      const reservation = createServer();
      await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
      const address = reservation.address();
      if (!address || typeof address === 'string') throw Error('Fixture port unavailable');
      await new Promise<void>((resolve, reject) =>
        reservation.close((error) => (error ? reject(error) : resolve())),
      );
      const stop = new AbortController();
      const running = runWorker(
        { ...appConfig, HOST: '127.0.0.1', WORKER_HEALTH_PORT: address.port },
        { signal: stop.signal },
      );
      try {
        await vi.waitFor(
          async () =>
            expect((await fetch(`http://127.0.0.1:${address.port}/health/ready`)).status).toBe(200),
          { timeout: 5000 },
        );
      } finally {
        stop.abort();
        await running;
      }
    });
    it('rejects a connection pool that exceeds the actual role connection limit', async () => {
      await admin.query('alter role gcr_app connection limit 1');
      const pool = appPool();
      try {
        await expect(pool.query('select 1')).rejects.toThrow('role isolation verification failed');
      } finally {
        await pool.end();
        await admin.query('alter role gcr_app connection limit 42');
      }
    });

    it('fails readiness on a changed migration checksum while allowing additional rolling-upgrade versions', async () => {
      const target = new URL(adminUrl);
      target.pathname = '/git_code_reviewer';
      const writer = createDatabase(target.toString(), 1, { tlsCa: ca });
      const version = '0001_foundation.sql';
      const original = (
        await writer.query('select checksum from schema_migrations where version=$1', [version])
      ).rows[0]!.checksum;
      try {
        await writer.query('update schema_migrations set checksum=$2 where version=$1', [
          version,
          '0'.repeat(64),
        ]);
        await expect(waitMigrations(appConfig)).rejects.toThrow(
          'Migration checksum changed after apply',
        );
        await writer.query('update schema_migrations set checksum=$2 where version=$1', [
          version,
          original,
        ]);
        await writer.query('insert into schema_migrations(version,checksum) values ($1,$2)', [
          '9999_fixture.sql',
          '0'.repeat(64),
        ]);
        await waitMigrations(appConfig);
      } finally {
        await writer.query('update schema_migrations set checksum=$2 where version=$1', [
          version,
          original,
        ]);
        await writer.query('delete from schema_migrations where version=$1', ['9999_fixture.sql']);
        await writer.end();
      }
    });
  });
