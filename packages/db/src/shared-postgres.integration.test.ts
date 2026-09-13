import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from './index.js';
import {
  inspectSharedPostgres,
  provisionSharedPostgres,
  type SharedPostgresPlan,
} from './shared-postgres.js';

// Cluster-level role and template ACL tests need their own container, not the shared
// schema fixture used concurrently by the other integration suites.
describe
  .skipIf(!process.env.GCR_TEST_DATABASE_URL)
  .sequential('Shared PostgreSQL isolation', { timeout: 30_000 }, () => {
    const exec = promisify(execFile);
    const name = `gcr-isolation-${randomUUID()}`;
    const passwords = {
      gcr_app: randomBytes(24).toString('hex'),
      gcr_migrator: randomBytes(24).toString('hex'),
      gcr_keycloak: randomBytes(24).toString('hex'),
    };
    const plan: SharedPostgresPlan = {
      applicationDatabase: 'git_code_reviewer',
      identityDatabase: 'git_code_reviewer_keycloak',
      pools: [
        { name: 'server_including_surge', role: 'gcr_app', replicas: 2, max: 10 },
        { name: 'worker_including_drain', role: 'gcr_app', replicas: 2, max: 10 },
        { name: 'retention', role: 'gcr_app', replicas: 1, max: 2 },
        { name: 'migration', role: 'gcr_migrator', replicas: 1, max: 2 },
        { name: 'keycloak_including_surge', role: 'gcr_keycloak', replicas: 3, max: 10 },
      ],
      otherConnections: 5,
      operatorReserve: 10,
    };
    let admin: pg.Client,
      config: pg.ClientConfig,
      directory: string,
      owned = false;
    const docker = async (args: string[]) =>
      (await exec('docker', args, { timeout: 30_000 })).stdout.trim();
    const options = () => ({ admin: config, plan, passwords });
    const client = async (
      user: keyof typeof passwords,
      database = user === 'gcr_keycloak' ? plan.identityDatabase : plan.applicationDatabase,
    ) => {
      const connection = new pg.Client({ ...config, user, password: passwords[user], database });
      await connection.connect();
      return connection;
    };
    const denyConnect = async (user: keyof typeof passwords, database: string) => {
      const c = new pg.Client({ ...config, user, password: passwords[user], database });
      try {
        await expect(c.connect()).rejects.toMatchObject({ code: '42501' });
      } finally {
        await c.end();
      }
    };
    beforeAll(async () => {
      directory = await mkdtemp(path.join(tmpdir(), 'gcr-db-isolation-'));
      const password = randomBytes(24).toString('hex');
      const env = path.join(directory, 'postgres.env');
      await writeFile(
        env,
        `POSTGRES_USER=postgres\nPOSTGRES_DB=postgres\nPOSTGRES_PASSWORD=${password}\nPGDATA=/var/lib/postgresql/data\n`,
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
        env,
        process.env.GCR_ISOLATION_POSTGRES_18 === 'true'
          ? 'postgres@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2'
          : 'postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73',
      ]);
      owned = true;
      const port = Number((await docker(['port', name, '5432/tcp'])).split(':').at(-1));
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          if (
            (
              await docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'])
            ).includes('accepting connections')
          )
            break;
        } catch {
          /* Postgres initialization */
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      config = {
        host: '127.0.0.1',
        port,
        user: 'postgres',
        password,
        database: 'postgres',
        ssl: false,
      };
      admin = new pg.Client(config);
      await admin.connect();
    }, 45_000);
    beforeEach(async () => {
      for (const db of [plan.applicationDatabase, plan.identityDatabase, 'unrelated'])
        await admin.query(`drop database if exists "${db}" with (force)`);
      for (const role of ['gcr_app', 'gcr_migrator', 'gcr_keycloak', 'legacy_gcr', 'unexpected']) {
        if ((await admin.query('select 1 from pg_roles where rolname=$1', [role])).rowCount) {
          await admin.query(`drop owned by "${role}"`);
          await admin.query(`drop role "${role}"`);
        }
      }
    });
    afterAll(async () => {
      await admin?.end();
      if (owned) await docker(['rm', '-f', '-v', name]);
      if (directory) await rm(directory, { recursive: true, force: true });
    }, 30_000);

    it('creates non-superuser roles, blocks every cross-database login, and runs all migrations with the migrator', async () => {
      const result = await provisionSharedPostgres(options());
      expect(result.limits).toEqual({ gcr_app: 42, gcr_migrator: 2, gcr_keycloak: 30 });
      expect(result.allocated).toBe(89);
      expect(result.server.maximum).toBe(100);
      expect(result.server.version).toMatch(
        process.env.GCR_ISOLATION_POSTGRES_18 === 'true' ? /^18\.6\b/ : /^17\.11\b/,
      );
      expect(result.roleRows).toHaveLength(3);
      for (const role of result.roleRows)
        expect(role).toMatchObject({
          rolsuper: false,
          rolinherit: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolbypassrls: false,
          rolcanlogin: true,
        });
      for (const user of ['gcr_app', 'gcr_migrator', 'gcr_keycloak'] as const) {
        await denyConnect(
          user,
          user === 'gcr_keycloak' ? plan.applicationDatabase : plan.identityDatabase,
        );
        await denyConnect(user, 'postgres');
        await denyConnect(user, 'template1');
      }
      const migration = new pg.Pool({
        ...config,
        user: 'gcr_migrator',
        password: passwords.gcr_migrator,
        database: plan.applicationDatabase,
        max: 1,
      });
      try {
        await runMigrations(migration);
        await runMigrations(migration);
      } finally {
        await migration.end();
      }
      const app = await client('gcr_app');
      try {
        expect(
          (await app.query('select count(*)::int as count from schema_migrations')).rows[0]!.count,
        ).toBe(36);
        await app.query(
          `insert into service_metadata(key,value) values ('fixture','{"preserved":true}')`,
        );
        await app.query(`update service_metadata set value='{"updated":true}' where key='fixture'`);
        await app.query('select reserve_model_request($1,$2,$3,$4,$5,$6)', [
          'fixture',
          'fixture-run',
          1,
          10,
          false,
          1,
        ]);
        await expect(app.query('create table forbidden(id int)')).rejects.toMatchObject({
          code: '42501',
        });
        await expect(app.query('create temporary table forbidden(id int)')).rejects.toMatchObject({
          code: '42501',
        });
        await expect(app.query('truncate service_metadata')).rejects.toMatchObject({
          code: '42501',
        });
        await expect(app.query('delete from schema_migrations')).rejects.toMatchObject({
          code: '42501',
        });
        await expect(app.query('set role gcr_migrator')).rejects.toMatchObject({ code: '42501' });
        await expect(app.query('create database forbidden')).rejects.toMatchObject({
          code: '42501',
        });
      } finally {
        await app.end();
      }
      const kc = await client('gcr_keycloak');
      try {
        await kc.query('create table keycloak_fixture(id int primary key)');
        await kc.query('insert into keycloak_fixture values (1)');
      } finally {
        await kc.end();
      }
    }, 30_000);

    it('preserves an existing migrated database, retires the legacy login, and keeps passwords unchanged on rerun', async () => {
      await admin.query('create role legacy_gcr login createdb');
      await admin.query('create database git_code_reviewer owner legacy_gcr');
      const legacy = new pg.Pool({ ...config, database: plan.applicationDatabase, max: 1 });
      try {
        await legacy.query('set role legacy_gcr');
        await runMigrations(legacy);
        await legacy.query(
          `insert into service_metadata(key,value) values ('fixture','{"existing":true}')`,
        );
        await legacy.query(`insert into users(oidc_subject,display_name,role)
          values ('existing-user','Existing fixture user','administrator')`);
        await legacy.query('grant select (value) on service_metadata to public');
        await legacy.query('alter default privileges grant all on tables to public');
      } finally {
        await legacy.end();
      }
      const withLegacy = { ...options(), plan: { ...plan, legacyOwner: 'legacy_gcr' } };
      await provisionSharedPostgres(withLegacy);
      const snapshot = async () => {
        const c = await client('gcr_app');
        try {
          return {
            data: (await c.query('select * from service_metadata order by key')).rows,
            users: (await c.query('select * from users order by id')).rows,
            migrations: (await c.query('select * from schema_migrations order by version')).rows,
          };
        } finally {
          await c.end();
        }
      };
      const before = await snapshot();
      expect(before.migrations).toHaveLength(36);
      expect(before.data.find((r) => r.key === 'fixture')?.value).toEqual({ existing: true });
      expect(before.users).toHaveLength(1);
      expect(before.users[0]).toMatchObject({ oidc_subject: 'existing-user', enabled: true });
      const passwordsBefore = (
        await admin.query(
          "select rolname,rolpassword from pg_authid where rolname like 'gcr_%' order by rolname",
        )
      ).rows;
      await provisionSharedPostgres(withLegacy);
      expect(await snapshot()).toEqual(before);
      expect(
        (
          await admin.query(
            "select rolname,rolpassword from pg_authid where rolname like 'gcr_%' order by rolname",
          )
        ).rows,
      ).toEqual(passwordsBefore);
      expect(
        (await admin.query("select rolcanlogin from pg_roles where rolname='legacy_gcr'")).rows[0]!
          .rolcanlogin,
      ).toBe(false);
      const app = await client('gcr_app');
      try {
        expect(
          (
            await app.query(
              "select distinct pg_get_userbyid(relowner) as owner from pg_class where relnamespace='public'::regnamespace",
            )
          ).rows,
        ).toEqual([{ owner: 'gcr_migrator' }]);
      } finally {
        await app.end();
      }
    }, 30_000);

    it('preserves existing identity-database rows and keeps migration DDL separate from app DML', async () => {
      await provisionSharedPostgres(options());
      const kc = await client('gcr_keycloak');
      try {
        await kc.query(
          'create table realm_fixture(id int generated always as identity, name text)',
        );
        await kc.query("insert into realm_fixture(name) values ('preserved')");
      } finally {
        await kc.end();
      }
      await provisionSharedPostgres(options());
      const again = await client('gcr_keycloak');
      try {
        expect((await again.query('select * from realm_fixture')).rows).toEqual([
          { id: 1, name: 'preserved' },
        ]);
      } finally {
        await again.end();
      }
      const migrator = await client('gcr_migrator');
      try {
        await migrator.query('create table next_migration(id serial primary key, value text)');
        await migrator.query(
          "create function next_function() returns text language sql as $$ select 'ok'::text $$",
        );
        await expect(migrator.query('create schema forbidden')).rejects.toMatchObject({
          code: '42501',
        });
      } finally {
        await migrator.end();
      }
      const app = await client('gcr_app');
      try {
        expect(
          (await app.query("insert into next_migration(value) values ('ok') returning id")).rows[0]!
            .id,
        ).toBe(1);
        expect((await app.query('select next_function() as value')).rows[0]!.value).toBe('ok');
        await expect(
          app.query('alter table next_migration add column forbidden int'),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await app.end();
      }
    });

    it('refuses live sessions without terminating work or disabling an existing login', async () => {
      await provisionSharedPostgres(options());
      const app = await client('gcr_app');
      try {
        expect((await inspectSharedPostgres(options())).sessions).toEqual([
          { database: plan.applicationDatabase, role: 'gcr_app', count: 1 },
        ]);
        await expect(provisionSharedPostgres(options())).rejects.toThrow(
          'Existing database sessions',
        );
        expect((await app.query('select 42 as value')).rows[0]!.value).toBe(42);
        expect(
          (await admin.query("select rolcanlogin from pg_roles where rolname='gcr_app'")).rows[0]!
            .rolcanlogin,
        ).toBe(true);
      } finally {
        await app.end();
      }
    });

    it('refuses a changed password without rotating any existing password or disabling logins', async () => {
      await provisionSharedPostgres(options());
      await expect(
        provisionSharedPostgres({
          ...options(),
          passwords: { ...passwords, gcr_app: randomBytes(24).toString('hex') },
        }),
      ).rejects.toThrow('automatic rotation is disabled');
      const app = await client('gcr_app');
      await app.end();
    });

    it('rejects unmarked/elevated managed roles and memberships before changing databases', async () => {
      await admin.query('create role gcr_app superuser');
      await expect(provisionSharedPostgres(options())).rejects.toThrow(
        'marker or elevated attributes',
      );
      await admin.query('drop role gcr_app');
      await provisionSharedPostgres(options());
      await admin.query('grant gcr_migrator to gcr_app');
      await expect(provisionSharedPostgres(options())).rejects.toThrow('unexpected memberships');
    });

    it('rejects unexpected database owners, schema owners, ACL grantees and foreign extensions', async () => {
      await admin.query('create role unexpected');
      await admin.query('create database git_code_reviewer owner unexpected');
      await expect(provisionSharedPostgres(options())).rejects.toThrow('Unexpected database owner');
      await admin.query('alter database git_code_reviewer owner to postgres');
      const c = new pg.Client({ ...config, database: plan.applicationDatabase });
      await c.connect();
      try {
        await c.query('alter schema public owner to unexpected');
        await expect(provisionSharedPostgres(options())).rejects.toThrow('Unexpected schema');
        await c.query('alter schema public owner to postgres');
        await c.query('grant usage on schema public to unexpected');
        await expect(provisionSharedPostgres(options())).rejects.toThrow('Unexpected ACL grantee');
        await c.query('revoke all on schema public from unexpected');
        await c.query('create extension dblink');
        await expect(provisionSharedPostgres(options())).rejects.toThrow('Unsupported extension');
      } finally {
        await c.end();
      }
    });

    it('rejects an unrelated database, an excessive pool budget and a runtime DBA credential', async () => {
      await admin.query('create database unrelated');
      await expect(provisionSharedPostgres(options())).rejects.toThrow('Unrelated database');
      await admin.query('drop database unrelated');
      await expect(
        provisionSharedPostgres({ ...options(), plan: { ...plan, operatorReserve: 100 } }),
      ).rejects.toThrow('Pool budget exceeds');
      await provisionSharedPostgres(options());
      await expect(
        inspectSharedPostgres({
          ...options(),
          admin: {
            ...config,
            database: plan.applicationDatabase,
            user: 'gcr_app',
            password: passwords.gcr_app,
          },
        }),
      ).rejects.toThrow('separate DBA');
    });

    it('excludes concurrent provisioners using a dedicated PostgreSQL advisory lock', async () => {
      await admin.query('select pg_advisory_lock(746278435)');
      try {
        await expect(provisionSharedPostgres(options())).rejects.toThrow(
          'Another shared PostgreSQL provisioner',
        );
      } finally {
        await admin.query('select pg_advisory_unlock(746278435)');
      }
    });

    it('resumes a closed database left during maintenance without losing its data', async () => {
      await provisionSharedPostgres(options());
      const kc = await client('gcr_keycloak');
      try {
        await kc.query('create table preserved(id int)');
        await kc.query('insert into preserved values (7)');
      } finally {
        await kc.end();
      }
      for (const role of Object.keys(passwords)) await admin.query(`alter role "${role}" nologin`);
      await admin.query('alter database git_code_reviewer_keycloak allow_connections false');
      await provisionSharedPostgres(options());
      const restored = await client('gcr_keycloak');
      try {
        expect((await restored.query('select * from preserved')).rows).toEqual([{ id: 7 }]);
      } finally {
        await restored.end();
      }
    });

    it('enforces the declared connection limit and denies default function access to other roles', async () => {
      await provisionSharedPostgres(options());
      const first = await client('gcr_migrator'),
        second = await client('gcr_migrator');
      const third = new pg.Client({
        ...config,
        user: 'gcr_migrator',
        password: passwords.gcr_migrator,
        database: plan.applicationDatabase,
      });
      try {
        await expect(third.connect()).rejects.toMatchObject({ code: '53300' });
        await first.query(
          "create function isolated_function() returns text language sql as $$ select 'ok'::text $$",
        );
        expect(
          (
            await first.query(
              "select has_function_privilege('gcr_keycloak','isolated_function()','execute') as allowed",
            )
          ).rows[0]!.allowed,
        ).toBe(false);
      } finally {
        await third.end();
        await first.end();
        await second.end();
      }
    });

    it('refuses inherited parameter privileges and unexpected role settings', async () => {
      await provisionSharedPostgres(options());
      await admin.query('grant set on parameter session_replication_role to gcr_app');
      await expect(provisionSharedPostgres(options())).rejects.toThrow(
        'parameter or tablespace privileges',
      );
      await admin.query('revoke all on parameter session_replication_role from gcr_app');
      await admin.query('alter role gcr_app set search_path=pg_catalog');
      await expect(provisionSharedPostgres(options())).rejects.toThrow(
        'Unexpected managed role settings',
      );
    });

    it('runs the separate CLI with file secrets, keeps inspection read-only, and rejects remote plaintext', async () => {
      const planFile = path.join(directory, 'plan.json');
      await writeFile(planFile, JSON.stringify(plan));
      const adminFile = path.join(directory, 'admin-password');
      await writeFile(adminFile, String(config.password), { mode: 0o600 });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GCR_DBA_HOST: String(config.host),
        GCR_DBA_PORT: String(config.port),
        GCR_DBA_DATABASE: 'postgres',
        GCR_DBA_USER: 'postgres',
        GCR_DBA_PASSWORD_FILE: adminFile,
        GCR_DBA_ALLOW_LOOPBACK_PLAINTEXT: 'true',
      };
      delete env.GCR_DBA_CA_FILE;
      for (const [role, variable] of [
        ['gcr_app', 'GCR_APP_PASSWORD_FILE'],
        ['gcr_migrator', 'GCR_MIGRATOR_PASSWORD_FILE'],
        ['gcr_keycloak', 'GCR_KEYCLOAK_PASSWORD_FILE'],
      ] as const) {
        const file = path.join(directory, role);
        await writeFile(file, passwords[role], { mode: 0o600 });
        Object.assign(env, { [variable]: file });
      }
      const command = [
        'apps/runtime/node_modules/tsx/dist/cli.mjs',
        'packages/db/src/provision-cli.ts',
      ];
      const invoke = async (mode: string) => {
        const result = await exec(process.execPath, [...command, mode, planFile], {
          env,
          timeout: 20_000,
        });
        for (const secret of [String(config.password), ...Object.values(passwords)])
          expect(result.stdout + result.stderr).not.toContain(secret);
        return JSON.parse(result.stdout);
      };
      expect((await invoke('--inspect')).roleRows).toHaveLength(0);
      expect(
        (await admin.query("select datname from pg_database where datname='git_code_reviewer'"))
          .rowCount,
      ).toBe(0);
      expect((await invoke('--apply')).roleRows).toHaveLength(3);
      expect((await invoke('--apply')).roleRows).toHaveLength(3);
      await expect(
        exec(process.execPath, [...command, '--inspect', planFile], {
          env: { ...env, GCR_DBA_HOST: 'postgres.internal' },
          timeout: 10_000,
        }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: 'GCR_DBA_CA_FILE is required outside an explicit loopback fixture\n',
      });
    });

    it('rejects reused role/DBA passwords before creating any roles', async () => {
      await expect(
        provisionSharedPostgres({
          ...options(),
          passwords: { ...passwords, gcr_keycloak: passwords.gcr_app },
        }),
      ).rejects.toThrow('passwords must be distinct');
      await expect(
        provisionSharedPostgres({
          ...options(),
          passwords: { ...passwords, gcr_app: String(config.password) },
        }),
      ).rejects.toThrow('passwords must be distinct');
      expect((await admin.query("select 1 from pg_roles where rolname='gcr_app'")).rowCount).toBe(
        0,
      );
    });
  });
