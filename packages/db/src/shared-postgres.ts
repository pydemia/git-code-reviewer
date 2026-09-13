import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import pg from 'pg';
import { checkServerIdentity } from 'node:tls';
import { secureDatabaseUrl } from './connection.js';

const roles = ['gcr_app', 'gcr_migrator', 'gcr_keycloak'] as const;
type Role = (typeof roles)[number];
const lock = 746_278_435;
const identifier = /^[a-z][a-z0-9_]{0,62}$/;
const q = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

export class SharedPostgresError extends Error {}

export interface SharedPostgresPlan {
  applicationDatabase: string;
  identityDatabase: string;
  /** The retired application login, never the connected DBA. Omit on a new cluster. */
  legacyOwner?: string;
  /** Include rolling replacements and draining workers in replicas. */
  pools: Array<{ name: string; role: Role; replicas: number; max: number }>;
  otherConnections: number;
  operatorReserve: number;
}

export interface SharedPostgresOptions {
  /** Must connect to a maintenance database using a separate superuser credential. */
  admin: pg.PoolConfig;
  plan: SharedPostgresPlan;
}

type RoleRow = {
  rolname: string;
  rolsuper: boolean;
  rolinherit: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolcanlogin: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  non_expiring: boolean;
  marker: string | null;
};
type DatabaseRow = { name: string; owner: string; connect: boolean };
type Inventory = {
  relations: Array<{ name: string; kind: string; owner: string }>;
  functions: Array<{ signature: string; owner: string }>;
};

function requireState(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SharedPostgresError(message);
}

function validatePlan(plan: SharedPostgresPlan): Record<Role, number> {
  for (const name of [plan.applicationDatabase, plan.identityDatabase, plan.legacyOwner])
    if (name !== undefined) requireState(identifier.test(name), 'Invalid database or role name');
  requireState(
    plan.applicationDatabase !== plan.identityDatabase &&
      ![plan.applicationDatabase, plan.identityDatabase].some((name) =>
        ['postgres', 'template0', 'template1'].includes(name),
      ),
    'Application and identity databases must be distinct, non-system databases',
  );
  requireState(!roles.includes(plan.legacyOwner as Role), 'Legacy owner is a managed role');
  requireState(
    !plan.legacyOwner?.startsWith('pg_'),
    'A built-in PostgreSQL role cannot be the legacy owner',
  );
  const limits = { gcr_app: 0, gcr_migrator: 0, gcr_keycloak: 0 };
  requireState(Array.isArray(plan.pools) && plan.pools.length > 0, 'Connection pools are required');
  const names = new Set<string>();
  for (const pool of plan.pools) {
    requireState(
      identifier.test(pool.name) &&
        !names.has(pool.name) &&
        roles.includes(pool.role) &&
        Number.isSafeInteger(pool.replicas) &&
        pool.replicas > 0 &&
        Number.isSafeInteger(pool.max) &&
        pool.max > 0,
      'Invalid connection pool budget',
    );
    names.add(pool.name);
    limits[pool.role] += pool.replicas * pool.max;
  }
  for (const limit of Object.values(limits))
    requireState(
      Number.isSafeInteger(limit) && limit > 0 && limit < 100_000,
      'Invalid role connection limit',
    );
  requireState(
    Number.isSafeInteger(plan.otherConnections) &&
      plan.otherConnections >= 0 &&
      Number.isSafeInteger(plan.operatorReserve) &&
      plan.operatorReserve >= 2,
    'Reserve at least two operator/provisioner connections',
  );
  return limits;
}

function marker(plan: SharedPostgresPlan): string {
  return `gcr-shared-postgres:v1:${plan.applicationDatabase}:${plan.identityDatabase}`;
}

async function connect(config: pg.PoolConfig): Promise<pg.Client> {
  const options = { ...config };
  if (config.ssl) {
    const hostname = (
      config.connectionString ? secureDatabaseUrl(config.connectionString).hostname : config.host
    )?.replace(/^\[|\]$/g, '');
    const ssl = typeof config.ssl === 'object' ? config.ssl : {};
    requireState(
      hostname && ssl.rejectUnauthorized !== false,
      'DBA TLS requires a verified server hostname',
    );
    options.ssl = {
      ...ssl,
      rejectUnauthorized: true,
      checkServerIdentity: (_name, certificate) =>
        checkServerIdentity(hostname, certificate) ??
        ssl.checkServerIdentity?.(hostname, certificate),
    };
  }
  const client = new pg.Client({
    ...options,
    connectionTimeoutMillis: 5_000,
    application_name: 'gcr-db-provision',
    statement_timeout: 30_000,
    lock_timeout: 5_000,
  });
  // Query promises still fail; the listener prevents an idle disconnect crashing the process.
  client.on('error', () => undefined);
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

function databaseConfig(admin: pg.PoolConfig, database: string): pg.PoolConfig {
  if (!admin.connectionString) return { ...admin, database };
  const url = new URL(admin.connectionString);
  url.pathname = `/${database}`;
  return { ...admin, connectionString: url.toString(), database };
}

async function inventory(client: pg.Client, allowedOwners: string[]): Promise<Inventory> {
  const schemas = (
    await client.query<{ name: string; owner: string }>(`
    select nspname as name,pg_get_userbyid(nspowner) as owner from pg_namespace
    where nspname !~ '^pg_' and nspname <> 'information_schema'`)
  ).rows;
  requireState(
    schemas.length === 1 &&
      schemas[0]?.name === 'public' &&
      [...allowedOwners, 'pg_database_owner'].includes(schemas[0].owner),
    'Unexpected schema or schema owner',
  );
  const unsupported = (
    await client.query<{ count: number }>(`
    select (
      (select count(*) from pg_extension where extname <> 'plpgsql') +
      (select count(*) from pg_foreign_server) +
      (select count(*) from pg_event_trigger) +
      (select count(*) from pg_largeobject_metadata) +
      (select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace
        where n.nspname='public' and t.typrelid=0 and t.typelem=0) +
      (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and (p.prosecdef or p.prokind<>'f'))
    )::int as count`)
  ).rows[0]!.count;
  requireState(
    unsupported === 0,
    'Unsupported extension, type, foreign server, large object or privileged routine',
  );
  const relations = (
    await client.query<Inventory['relations'][number]>(`
    select c.relname as name,c.relkind as kind,pg_get_userbyid(c.relowner) as owner
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind not in ('i','I') order by c.relkind,c.relname`)
  ).rows;
  requireState(
    relations.every(
      (row) => ['r', 'p', 'S', 'v', 'm'].includes(row.kind) && allowedOwners.includes(row.owner),
    ),
    'Unexpected relation or relation owner',
  );
  const functions = (
    await client.query<Inventory['functions'][number]>(`
    select format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) as signature,
      pg_get_userbyid(p.proowner) as owner from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' order by p.oid`)
  ).rows;
  requireState(
    functions.every((row) => allowedOwners.includes(row.owner)),
    'Unexpected function owner',
  );
  const grantees = (
    await client.query<{ role: string }>(`
    with a as (
      select nspacl as acl from pg_namespace where nspname='public'
      union all select relacl from pg_class where relnamespace='public'::regnamespace
      union all select attacl from pg_attribute where attrelid in
        (select oid from pg_class where relnamespace='public'::regnamespace)
      union all select proacl from pg_proc where pronamespace='public'::regnamespace
      union all select defaclacl from pg_default_acl
    ) select distinct pg_get_userbyid(x.grantee) as role from a,lateral aclexplode(a.acl) x
    where x.grantee<>0`)
  ).rows;
  requireState(
    grantees.every((row) => [...allowedOwners, ...roles, 'pg_database_owner'].includes(row.role)),
    'Unexpected ACL grantee',
  );
  const defaults = (
    await client.query<{ owner: string; schema: string | null }>(`
    select pg_get_userbyid(defaclrole) as owner,nspname as schema from pg_default_acl
    left join pg_namespace n on n.oid=defaclnamespace`)
  ).rows;
  requireState(
    defaults.every(
      (row) =>
        allowedOwners.includes(row.owner) && (row.schema === null || row.schema === 'public'),
    ),
    'Unexpected default privilege owner or schema',
  );
  return { relations, functions };
}

async function inspect(admin: pg.Client, options: SharedPostgresOptions) {
  const { plan } = options;
  const limits = validatePlan(plan);
  const server = (
    await admin.query<{
      user: string;
      database: string;
      superuser: boolean;
      version: string;
      maximum: number;
      reserved: number;
      tls: boolean;
    }>(`
    select current_user as user,current_database() as database,
      (select rolsuper from pg_roles where rolname=current_user) as superuser,
      current_setting('server_version') as version,current_setting('max_connections')::int as maximum,
      current_setting('superuser_reserved_connections')::int +
        coalesce(nullif(current_setting('reserved_connections',true),''),'0')::int as reserved,
      coalesce((select ssl from pg_stat_ssl where pid=pg_backend_pid()),false) as tls`)
  ).rows[0]!;
  requireState(
    server.superuser && ![...roles, plan.legacyOwner].includes(server.user),
    'A separate DBA superuser is required',
  );
  requireState(
    ![plan.applicationDatabase, plan.identityDatabase, 'template0', 'template1'].includes(
      server.database,
    ),
    'Connect the DBA to a maintenance database',
  );
  const allocated =
    Object.values(limits).reduce((sum, count) => sum + count, 0) +
    plan.otherConnections +
    plan.operatorReserve;
  requireState(
    allocated <= server.maximum - server.reserved,
    'Pool budget exceeds available PostgreSQL connections',
  );
  const databases = (
    await admin.query<DatabaseRow>(`
    select datname as name,pg_get_userbyid(datdba) as owner,datallowconn as connect
    from pg_database order by datname`)
  ).rows;
  const allowedDatabases = [
    server.database,
    'postgres',
    'template0',
    'template1',
    plan.applicationDatabase,
    plan.identityDatabase,
  ];
  requireState(
    databases.every((db) => allowedDatabases.includes(db.name)),
    'Unrelated database: use a dedicated shared GCR/Keycloak cluster',
  );
  for (const db of databases) {
    const owners = [
      server.user,
      'postgres',
      ...(db.name === plan.applicationDatabase && plan.legacyOwner ? [plan.legacyOwner] : []),
    ];
    requireState(owners.includes(db.owner), 'Unexpected database owner');
  }
  const roleRows = (
    await admin.query<RoleRow>(
      `
    select rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,
      rolvaliduntil is null as non_expiring,
      shobj_description(oid,'pg_authid') as marker from pg_roles where rolname=any($1::text[])`,
      [roles],
    )
  ).rows;
  for (const row of roleRows)
    requireState(
      row.marker === marker(plan) &&
        !row.rolsuper &&
        !row.rolinherit &&
        !row.rolcreaterole &&
        !row.rolcreatedb &&
        !row.rolreplication &&
        !row.rolbypassrls &&
        row.non_expiring,
      'Existing managed role has an unexpected marker or elevated attributes',
    );
  const memberships = (
    await admin.query(
      `select 1 from pg_auth_members m join pg_roles r
    on r.oid=m.member or r.oid=m.roleid where r.rolname=any($1::text[])`,
      [[...roles, ...(plan.legacyOwner ? [plan.legacyOwner] : [])]],
    )
  ).rowCount;
  requireState(!memberships, 'Managed or legacy role has unexpected memberships');
  const elevatedGrants = await admin.query(
    `
    with a as (
      select paracl as acl from pg_parameter_acl
      union all select spcacl from pg_tablespace
    ) select 1 from a,lateral aclexplode(a.acl) x
    where x.grantee=0 or x.grantee in (select oid from pg_roles where rolname=any($1::text[]))`,
    [roles],
  );
  requireState(!elevatedGrants.rowCount, 'Unexpected parameter or tablespace privileges');
  const settings = (
    await admin.query<{ database: number; settings: string[] }>(
      `
    select setdatabase::int as database,setconfig as settings from pg_db_role_setting
    where setrole in (select oid from pg_roles where rolname=any($1::text[]))`,
      [roles],
    )
  ).rows;
  requireState(
    settings.every(
      (row) =>
        row.database === 0 &&
        row.settings.every((setting) => setting === 'search_path=public, pg_catalog'),
    ),
    'Unexpected managed role settings',
  );
  const databaseGrants = (
    await admin.query<{ grantee: string }>(`
    select distinct pg_get_userbyid(a.grantee) as grantee from pg_database d,
      lateral aclexplode(d.datacl) a where a.grantee<>0`)
  ).rows;
  requireState(
    databaseGrants.every((r) =>
      [server.user, 'postgres', plan.legacyOwner, ...roles].includes(r.grantee),
    ),
    'Unexpected database ACL grantee',
  );
  const inventories: Record<string, Inventory> = {};
  for (const [name, owner] of [
    [plan.applicationDatabase, 'gcr_migrator'],
    [plan.identityDatabase, 'gcr_keycloak'],
  ] as const) {
    const db = databases.find((db) => db.name === name);
    if (!db) continue;
    if (!db.connect) {
      // A crash after CREATE DATABASE can leave the new database closed. Only a
      // fully marked, disabled role set may resume that maintenance state.
      requireState(
        roleRows.length === roles.length &&
          roleRows.every((r) => !r.rolcanlogin) &&
          db.owner === server.user,
        'Existing target database does not allow connections',
      );
      continue;
    }
    const client = await connect(databaseConfig(options.admin, name));
    try {
      inventories[name] = await inventory(client, [
        server.user,
        owner,
        ...(name === plan.applicationDatabase && plan.legacyOwner ? [plan.legacyOwner] : []),
      ]);
    } finally {
      await client.end();
    }
  }
  const sessions = (
    await admin.query<{ database: string; role: string; count: number }>(
      `
    select datname as database,usename as role,count(*)::int as count from pg_stat_activity
    where pid<>pg_backend_pid() and backend_type='client backend' and
      (datname=any($1::text[]) or usename=any($2::text[])) group by datname,usename order by 1,2`,
      [
        [plan.applicationDatabase, plan.identityDatabase],
        [...roles, ...(plan.legacyOwner ? [plan.legacyOwner] : [])],
      ],
    )
  ).rows;
  return { server, limits, allocated, databases, roleRows, inventories, sessions };
}

/** Read-only. The result contains role names/counts, never passwords or connection strings. */
export async function inspectSharedPostgres(options: SharedPostgresOptions) {
  validatePlan(options.plan);
  const admin = await connect(options.admin);
  try {
    return await inspect(admin, options);
  } finally {
    await admin.end();
  }
}

function scram(password: string, existing?: string): string {
  requireState(
    /^[\x21-\x7e]{24,256}$/.test(password),
    'Role passwords must be 24–256 printable ASCII characters without spaces',
  );
  const match = existing?.match(
    /^SCRAM-SHA-256\$(\d+):([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/,
  );
  requireState(!existing || match, 'Existing managed role must use SCRAM-SHA-256');
  const iterations = match ? Number(match[1]) : 16_384;
  requireState(iterations >= 4_096 && iterations <= 1_000_000, 'Unsupported SCRAM iteration count');
  const salt = match ? Buffer.from(match[2]!, 'base64') : randomBytes(16);
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const stored = createHash('sha256')
    .update(createHmac('sha256', salted).update('Client Key').digest())
    .digest('base64');
  const server = createHmac('sha256', salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${stored}:${server}`;
}

async function transaction(client: pg.Client, action: () => Promise<void>) {
  await client.query('begin');
  try {
    await action();
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

async function isolateSchema(
  client: pg.Client,
  owner: Role,
  legacy: string | undefined,
  dba: string,
) {
  const inv = await inventory(client, [owner, dba, ...(legacy ? [legacy] : [])]);
  await transaction(client, async () => {
    await client.query(`alter schema public owner to ${q(owner)}`);
    const kinds: Record<string, string> = {
      r: 'table',
      p: 'table',
      v: 'view',
      m: 'materialized view',
      S: 'sequence',
    };
    // Table ownership also transfers owned sequences. Transfer stand-alone sequences afterwards.
    for (const relation of [
      ...inv.relations.filter((r) => r.kind !== 'S'),
      ...inv.relations.filter((r) => r.kind === 'S'),
    ])
      await client.query(
        `alter ${kinds[relation.kind]} public.${q(relation.name)} owner to ${q(owner)}`,
      );
    for (const fn of inv.functions)
      await client.query(`alter function ${fn.signature} owner to ${q(owner)}`);
    const revoke = ['PUBLIC', ...roles.map(q), ...(legacy ? [q(legacy)] : [])].join(',');
    await client.query(`revoke all on schema public from ${revoke}`);
    await client.query(`grant usage,create on schema public to ${q(owner)}`);
    await client.query(`revoke all on all tables in schema public from ${revoke}`);
    await client.query(`revoke all on all sequences in schema public from ${revoke}`);
    await client.query(`revoke all on all functions in schema public from ${revoke}`);
    // Column grants survive REVOKE on a table; clear them explicitly as well.
    const columns = (
      await client.query<{ relation: string; column: string }>(`
      select c.relname as relation,a.attname as column from pg_attribute a join pg_class c on c.oid=a.attrelid
      where c.relnamespace='public'::regnamespace and a.attnum>0 and not a.attisdropped and a.attacl is not null`)
    ).rows;
    for (const c of columns)
      await client.query(`revoke all (${q(c.column)}) on public.${q(c.relation)} from ${revoke}`);
    // Restore owner's ordinary privileges after the explicit all-role revocation.
    await client.query(`grant all on all tables in schema public to ${q(owner)}`);
    await client.query(`grant all on all sequences in schema public to ${q(owner)}`);
    await client.query(`grant all on all functions in schema public to ${q(owner)}`);
    // Global defaults must be revoked globally; per-schema REVOKE cannot undo them.
    for (const creator of [owner, ...(legacy ? [legacy] : [])]) {
      for (const scope of ['', ' in schema public']) {
        for (const object of ['tables', 'sequences', 'functions', 'types'])
          await client.query(
            `alter default privileges for role ${q(creator)}${scope} revoke all on ${object} from ${revoke}`,
          );
      }
      for (const object of ['tables', 'sequences', 'functions', 'types'])
        await client.query(
          `alter default privileges for role ${q(creator)} grant all on ${object} to ${q(creator)}`,
        );
    }
    if (owner === 'gcr_migrator') {
      // Create the migration ledger before granting future app-table DML by default.
      await client.query('set local role gcr_migrator');
      await client.query(`create table if not exists public.schema_migrations (
        version text primary key,checksum text not null,applied_at timestamptz not null default clock_timestamp())`);
      await client.query('reset role');
      await client.query('grant usage on schema public to gcr_app');
      await client.query(
        'grant select,insert,update,delete on all tables in schema public to gcr_app',
      );
      await client.query('revoke all on public.schema_migrations from gcr_app');
      await client.query('grant select on public.schema_migrations to gcr_app');
      await client.query('grant usage,select on all sequences in schema public to gcr_app');
      await client.query('grant execute on all functions in schema public to gcr_app');
      await client.query(
        'alter default privileges for role gcr_migrator in schema public grant select,insert,update,delete on tables to gcr_app',
      );
      await client.query(
        'alter default privileges for role gcr_migrator in schema public grant usage,select on sequences to gcr_app',
      );
      await client.query(
        'alter default privileges for role gcr_migrator in schema public grant execute on functions to gcr_app',
      );
    }
  });
}

/**
 * Explicit, maintenance-window provisioning. Does not terminate sessions, rotate existing
 * passwords, delete/recreate databases or reassign cluster-wide shared objects.
 * Failure after mutation leaves managed logins disabled; correct the cause and rerun.
 */
export async function provisionSharedPostgres(
  options: SharedPostgresOptions & { passwords: Record<Role, string> },
) {
  validatePlan(options.plan);
  const { plan, passwords } = options;
  const suppliedPasswords = roles.map((role) => passwords[role]);
  const adminPassword = options.admin.connectionString
    ? decodeURIComponent(new URL(options.admin.connectionString).password)
    : options.admin.password;
  requireState(
    new Set(suppliedPasswords).size === roles.length &&
      (typeof adminPassword !== 'string' || !suppliedPasswords.includes(adminPassword)),
    'Database role passwords must be distinct from each other and the DBA password',
  );
  const generated = Object.fromEntries(
    roles.map((role) => [role, scram(passwords[role])]),
  ) as Record<Role, string>;
  const admin = await connect(options.admin);
  try {
    const held = (
      await admin.query<{ held: boolean }>('select pg_try_advisory_lock($1) as held', [lock])
    ).rows[0]!.held;
    requireState(held, 'Another shared PostgreSQL provisioner is running');
    const before = await inspect(admin, options);
    requireState(
      before.sessions.length === 0,
      'Existing database sessions: stop and drain applications before provisioning',
    );
    for (const role of before.roleRows) {
      const password = (
        await admin.query<{ password: string | null }>(
          'select rolpassword as password from pg_authid where rolname=$1',
          [role.rolname],
        )
      ).rows[0]?.password;
      requireState(password, 'Existing managed role has no password');
      const expected = scram(passwords[role.rolname as Role], password);
      requireState(
        Buffer.byteLength(expected) === Buffer.byteLength(password) &&
          timingSafeEqual(Buffer.from(expected), Buffer.from(password)),
        'Existing managed password does not match; automatic rotation is disabled',
      );
    }
    await transaction(admin, async () => {
      for (const role of roles) {
        if (!before.roleRows.some((r) => r.rolname === role)) {
          // Only a SCRAM verifier reaches SQL, never the cleartext password.
          await admin.query(
            `create role ${q(role)} nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password ${literal(generated[role])}`,
          );
          await admin.query(`comment on role ${q(role)} is ${literal(marker(plan))}`);
        }
        await admin.query(`alter role ${q(role)} nologin connection limit ${before.limits[role]}`);
        await admin.query(`alter role ${q(role)} set search_path=public,pg_catalog`);
      }
      if (plan.legacyOwner) {
        requireState(
          (await admin.query('select 1 from pg_roles where rolname=$1', [plan.legacyOwner]))
            .rowCount,
          'Legacy owner does not exist',
        );
        await admin.query(`alter role ${q(plan.legacyOwner)} nologin`);
      }
    });
    // Catch connections that raced the initial inspection, without killing user work.
    requireState(
      (await inspect(admin, options)).sessions.length === 0,
      'Connections raced provisioning; logins remain disabled until drained',
    );
    for (const name of [plan.applicationDatabase, plan.identityDatabase]) {
      if (!before.databases.some((db) => db.name === name)) {
        await admin.query(
          `create database ${q(name)} owner ${q(before.server.user)} template template0 allow_connections false`,
        );
      }
      await admin.query(`alter database ${q(name)} owner to ${q(before.server.user)}`);
    }
    const dbs = [
      ...new Set([
        ...before.databases.map((db) => db.name),
        plan.applicationDatabase,
        plan.identityDatabase,
      ]),
    ];
    for (const name of dbs) {
      await admin.query(
        `revoke all on database ${q(name)} from PUBLIC,${roles.map(q).join(',')}${plan.legacyOwner ? `,${q(plan.legacyOwner)}` : ''}`,
      );
      if (name === plan.applicationDatabase)
        await admin.query(`grant connect on database ${q(name)} to gcr_app,gcr_migrator`);
      if (name === plan.identityDatabase)
        await admin.query(`grant connect on database ${q(name)} to gcr_keycloak`);
    }
    for (const [name, owner] of [
      [plan.applicationDatabase, 'gcr_migrator'],
      [plan.identityDatabase, 'gcr_keycloak'],
    ] as const) {
      await admin.query(`alter database ${q(name)} allow_connections true`);
      const client = await connect(databaseConfig(options.admin, name));
      try {
        await isolateSchema(
          client,
          owner,
          owner === 'gcr_migrator' ? plan.legacyOwner : undefined,
          before.server.user,
        );
      } finally {
        await client.end();
      }
    }
    await transaction(admin, async () => {
      // CONNECT is evaluated at login; also prove no cross-DB grant remains before enabling logins.
      for (const role of roles) {
        const allowed = role === 'gcr_keycloak' ? plan.identityDatabase : plan.applicationDatabase;
        const unexpected = await admin.query(
          `select 1 from pg_database where datname<>$2
          and has_database_privilege($1,oid,'CONNECT')`,
          [role, allowed],
        );
        requireState(!unexpected.rowCount, 'Cross-database CONNECT remains');
        await admin.query(`alter role ${q(role)} login`);
      }
    });
    return await inspect(admin, options);
  } finally {
    await admin.query('select pg_advisory_unlock($1)', [lock]).catch(() => undefined);
    await admin.end();
  }
}
