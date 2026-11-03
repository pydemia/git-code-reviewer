import { checkServerIdentity } from 'node:tls';
import type pg from 'pg';

export interface DatabaseConnectionOptions {
  tlsCa?: string;
  expectedRole?: 'gcr_app' | 'gcr_migrator';
}

export class DatabaseRoleError extends Error {
  constructor() {
    super('Database role isolation verification failed');
  }
}

/** Strict mode rejects URL options that could replace TLS, credentials or the host. */
export function secureDatabaseUrl(
  connectionString: string,
  role?: DatabaseConnectionOptions['expectedRole'],
): URL {
  try {
    const url = new URL(connectionString);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      url.hostname.includes('%') ||
      url.pathname.length < 2 ||
      !url.username ||
      !url.password ||
      (role && decodeURIComponent(url.username) !== role)
    )
      throw Error();
    const allowed = role ? ['application_name'] : ['application_name', 'options'];
    if ([...url.searchParams.keys()].some((key) => !allowed.includes(key))) throw Error();
    return url;
  } catch {
    throw new Error('Invalid secure database connection URL');
  }
}

export function databaseConnectionOptions(
  connectionString: string,
  options: DatabaseConnectionOptions,
  poolMax: number,
): pg.PoolConfig {
  const result: pg.PoolConfig = {};
  if (options.tlsCa !== undefined) {
    if (!options.tlsCa.trim()) throw Error('Database TLS CA is empty');
    const url = secureDatabaseUrl(connectionString, options.expectedRole);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    // Do not hand pg a second connection-string parse that can override SSL or
    // connection fields. Explicit host also handles bracketed IPv6 URLs.
    result.connectionString = undefined;
    result.host = hostname;
    result.port = url.port ? Number(url.port) : 5432;
    result.database = decodeURIComponent(url.pathname.slice(1));
    result.user = decodeURIComponent(url.username);
    result.password = decodeURIComponent(url.password);
    if (url.searchParams.has('application_name'))
      result.application_name = url.searchParams.get('application_name')!;
    if (url.searchParams.has('options')) result.options = url.searchParams.get('options')!;
    result.ssl = {
      ca: options.tlsCa,
      rejectUnauthorized: true,
      // pg omits SNI for IP addresses. Always validate the configured host,
      // including an IP SAN, instead of depending on TLSSocket's host fallback.
      checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
    };
  }
  if (options.expectedRole) {
    if (options.tlsCa === undefined) throw Error('Isolated database roles require verified TLS');
    const expectedRole = options.expectedRole;
    result.onConnect = async (client) => {
      const query: pg.QueryConfig & { query_timeout: number } = {
        text: `select (
          current_user=$1 and session_user=$1 and r.rolcanlogin and not r.rolinherit
          and not r.rolsuper and not r.rolcreatedb and not r.rolcreaterole
          and not r.rolreplication and not r.rolbypassrls
          and r.rolconnlimit >= $2
          and coalesce((select ssl from pg_stat_ssl where pid=pg_backend_pid()),false)
          and not exists (select 1 from pg_auth_members where member=r.oid or roleid=r.oid)
          and not exists (select 1 from pg_database where datname<>current_database()
            and has_database_privilege(r.oid,oid,'CONNECT'))
          and not has_database_privilege(r.oid,current_database(),'CREATE,TEMP')
          and (select pg_get_userbyid(nspowner)='gcr_migrator' from pg_namespace where nspname='public')
          and (select o.rolsuper from pg_database d join pg_roles o on o.oid=d.datdba where datname=current_database())
          and not exists (select 1 from pg_parameter_acl p,lateral aclexplode(p.paracl) a
            where a.grantee=0 or a.grantee=r.oid)
          and ($1<>'gcr_app' or (
            not has_schema_privilege(r.oid,'public','CREATE')
            and not exists (select 1 from pg_class c where c.relnamespace='public'::regnamespace
              and c.relkind in ('r','p','v','m') and
              (c.relowner=r.oid or has_table_privilege(r.oid,c.oid,'TRUNCATE,REFERENCES,TRIGGER')))
            and to_regclass('public.schema_migrations') is not null
            and not has_table_privilege(r.oid,to_regclass('public.schema_migrations'),'INSERT,UPDATE,DELETE')
          ))
        ) as valid from pg_roles r where rolname=session_user`,
        values: [expectedRole, poolMax],
        query_timeout: 5_000,
      };
      const check = await client.query<{ valid: boolean }>(query);
      if (check.rows[0]?.valid !== true) throw new DatabaseRoleError();
    };
  }
  return result;
}
