import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database, DatabaseClient } from '@gcr/db';
import { z } from 'zod';
import type { AuthUser } from './index.js';
import { knowledgeUserAllowed } from '../services/knowledge-projection.js';

export class ClientCredentialError extends Error {
  constructor(
    readonly statusCode: 400 | 401 | 403 | 429 | 503,
    readonly code: string,
  ) {
    super(code);
    this.name = 'ClientCredentialError';
  }
}
const fail = (status: ClientCredentialError['statusCode'], code: string): never => {
  throw new ClientCredentialError(status, code);
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const clientKeyInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    clientId: z.enum(['commit-defender', 'gcr-cli']),
    tenantId: z.string().uuid(),
    repositoryIds: z
      .array(z.string().uuid())
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
    scopes: z.tuple([z.literal('knowledge:read')]).default(['knowledge:read']),
    lifetimeDays: z.number().int().min(1).max(90).default(30),
  })
  .strict();
type Row = {
  id: string;
  user_id: string;
  server_id: string;
  tenant_id: string;
  client_id: string;
  name: string;
  scopes: ['knowledge:read'];
  repository_ids: string[];
  credential_epoch: string;
  auth_mode: 'local' | 'saml';
  identity_id: string | null;
  identity_epoch: string | null;
  local_password_changed_at: string | null;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
};
export function clientKeyView(row: Row) {
  return {
    id: row.id,
    name: row.name,
    clientId: row.client_id,
    tenantId: row.tenant_id,
    repositoryIds: row.repository_ids,
    scopes: row.scopes,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}
const fields =
  'id,user_id,server_id,tenant_id,client_id,name,scopes,repository_ids,credential_epoch,auth_mode,identity_id,identity_epoch,local_password_changed_at::text as local_password_changed_at,created_at,expires_at,revoked_at';
async function audit(
  c: Pick<DatabaseClient, 'query'>,
  actor: string,
  action: string,
  id: string,
  requestId: string,
) {
  await c.query(
    "insert into audit_events(actor,action,resource_type,resource_id,outcome,request_id) values($1,$2,'client-api-key',$3,'success',$4)",
    [actor, action, id, requestId],
  );
}
export async function issueClientKey(
  database: Database,
  options: {
    user: AuthUser;
    sessionToken: string;
    serverId: string;
    authMode: string;
    requestId: string;
    input: unknown;
  },
) {
  const input = clientKeyInput.parse(options.input);
  if (!['local', 'saml'].includes(options.authMode)) fail(503, 'CLIENT_AUTH_DISABLED');
  const c = await database.connect();
  try {
    await c.query('begin');
    await c.query("set local lock_timeout='5s'");
    await c.query("select pg_advisory_xact_lock(hashtext('gcr:user-administration'))");
    const user = await c.query(
      'select id from users where id=$1 and enabled and deleted_at is null for update',
      [options.user.id],
    );
    if (!user.rowCount) fail(403, 'CLIENT_ACCESS_REVOKED');
    const session = (
      await c.query<{
        identity_id: string | null;
        identity_epoch: string | null;
        password_changed_at: string | null;
      }>(
        `select s.saml_identity_id as identity_id,s.saml_security_epoch as identity_epoch,l.password_changed_at::text
       from user_sessions s left join local_credentials l on l.user_id=s.user_id
       where s.id_hash=$1 and s.user_id=$2 and s.expires_at>clock_timestamp()
       and (($3='local' and s.saml_identity_id is null and l.password_changed_at<=s.created_at)
         or ($3='saml' and exists(select 1 from user_identities i where i.id=s.saml_identity_id and i.user_id=s.user_id
           and i.enabled and i.provisioning_state='provisioned' and i.identity_verified_at<=clock_timestamp()
           and i.security_epoch=s.saml_security_epoch and s.saml_session_not_on_or_after>clock_timestamp()
           and i.security_checked_at<=clock_timestamp() and i.security_fresh_until>clock_timestamp())))`,
        [hash(options.sessionToken), options.user.id, options.authMode],
      )
    ).rows[0];
    if (!session) fail(401, 'CLIENT_WEB_REAUTHENTICATION_REQUIRED');
    for (const repository of input.repositoryIds) {
      const r = await c.query('select id from repositories where id=$1 and tenant_id=$2', [
        repository,
        input.tenantId,
      ]);
      if (!r.rowCount || !(await knowledgeUserAllowed(c, repository, options.user.id, 'reader')))
        fail(403, 'CLIENT_SCOPE_DENIED');
    }
    const count = await c.query<{ count: string }>(
      'select count(*) from client_api_keys where user_id=$1 and revoked_at is null and expires_at>clock_timestamp()',
      [options.user.id],
    );
    if (Number(count.rows[0]!.count) >= 50) fail(429, 'CLIENT_KEY_LIMIT');
    const epoch = (
      await c.query<{ epoch: string }>(
        'insert into user_client_credential_epochs(user_id) values($1) on conflict(user_id) do update set epoch=user_client_credential_epochs.epoch returning epoch',
        [options.user.id],
      )
    ).rows[0]!.epoch;
    const id = randomUUID();
    const token = `gcr_key_${id}_${randomBytes(32).toString('base64url')}`;
    const result = await c.query<Row>(
      `insert into client_api_keys(id,user_id,server_id,tenant_id,client_id,name,secret_hash,scopes,repository_ids,credential_epoch,auth_mode,identity_id,identity_epoch,local_password_changed_at,created_at,expires_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,statement_timestamp(),statement_timestamp()+$15*interval '1 day') returning ${fields}`,
      [
        id,
        options.user.id,
        options.serverId,
        input.tenantId,
        input.clientId,
        input.name,
        hash(token),
        input.scopes,
        input.repositoryIds,
        epoch,
        options.authMode,
        options.authMode === 'saml' ? session!.identity_id : null,
        options.authMode === 'saml' ? session!.identity_epoch : null,
        options.authMode === 'local' ? session!.password_changed_at : null,
        input.lifetimeDays,
      ],
    );
    await audit(c, options.user.id, 'client-key.create', id, options.requestId);
    await c.query('commit');
    return { ...clientKeyView(result.rows[0]!), token };
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}
export async function listClientKeys(database: Database, userId: string, cursor?: string) {
  const rows = await database.query<Row>(
    `select ${fields} from client_api_keys where user_id=$1
     and ($2::uuid is null or (created_at,id)<(select created_at,id from client_api_keys where id=$2 and user_id=$1))
     order by created_at desc,id desc limit 101`,
    [userId, cursor ?? null],
  );
  const page = rows.rows.slice(0, 100);
  return {
    items: page.map(clientKeyView),
    nextCursor: rows.rows.length > 100 ? page.at(-1)!.id : null,
  };
}
export async function revokeClientKey(
  database: Database,
  userId: string,
  id: string,
  requestId: string,
) {
  const c = await database.connect();
  try {
    await c.query('begin');
    const row = await c.query(
      'update client_api_keys set revoked_at=coalesce(revoked_at,clock_timestamp()) where id=$1 and user_id=$2 returning id',
      [id, userId],
    );
    if (!row.rowCount) fail(403, 'CLIENT_SCOPE_DENIED');
    await audit(c, userId, 'client-key.revoke', id, requestId);
    await c.query('commit');
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}
export type ClientPrincipal = {
  user: AuthUser;
  keyId: string;
  clientId: string;
  tenantId: string;
  repositoryIds: string[];
  scopes: ['knowledge:read'];
  expiresAt: string;
};
export async function authenticateClientKey(
  database: Database,
  options: {
    authorization?: string;
    serverId: string;
    requestedServerId?: string;
    authMode: string;
    repositoryId?: string;
  },
): Promise<ClientPrincipal> {
  const match = /^Bearer (gcr_key_([0-9a-f-]{36})_[A-Za-z0-9_-]{43})$/.exec(
    options.authorization ?? '',
  );
  if (!match || !z.string().uuid().safeParse(match[2]).success)
    fail(401, 'CLIENT_AUTHENTICATION_REQUIRED');
  if (options.requestedServerId !== options.serverId) fail(401, 'CLIENT_AUDIENCE_MISMATCH');
  const row = (
    await database.query<Row & { expired: boolean }>(
      `select ${fields},expires_at<=clock_timestamp() as expired from client_api_keys where id=$1 and secret_hash=$2 and server_id=$3`,
      [match![2], hash(match![1]!), options.serverId],
    )
  ).rows[0];
  if (!row || row.expired) fail(401, 'CLIENT_AUTHENTICATION_REQUIRED');
  if (row!.revoked_at || row!.auth_mode !== options.authMode) fail(403, 'CLIENT_ACCESS_REVOKED');
  const current = (
    await database.query<{
      id: string;
      subject: string;
      displayName: string;
      role: AuthUser['role'];
      groups: string[];
      enabled: boolean;
      epoch: string;
      password_valid: boolean;
      identity_valid: boolean;
      identity_fresh: boolean;
    }>(
      `select u.id,u.oidc_subject as subject,u.display_name as "displayName",u.role,u.groups_json as groups,
       (u.enabled and u.deleted_at is null) as enabled,e.epoch,
       exists(select 1 from local_credentials l where l.user_id=u.id and l.password_changed_at=$3) as password_valid,
       exists(select 1 from user_identities i where i.id=$4 and i.user_id=u.id and i.enabled and i.provisioning_state='provisioned' and i.identity_verified_at<=clock_timestamp() and i.security_epoch=$5) as identity_valid,
       exists(select 1 from user_identities i where i.id=$4 and i.security_checked_at<=clock_timestamp() and i.security_fresh_until>clock_timestamp()) as identity_fresh
     from users u join user_client_credential_epochs e on e.user_id=u.id where u.id=$1 and e.epoch=$2`,
      [
        row!.user_id,
        row!.credential_epoch,
        row!.local_password_changed_at,
        row!.identity_id,
        row!.identity_epoch,
      ],
    )
  ).rows[0];
  if (
    !current?.enabled ||
    (row!.auth_mode === 'local' ? !current.password_valid : !current.identity_valid)
  )
    fail(403, 'CLIENT_ACCESS_REVOKED');
  if (row!.auth_mode === 'saml' && !current!.identity_fresh) fail(503, 'IDENTITY_UNAVAILABLE');
  const tenants = (
    await database.query<{ id: string; slug: string; displayName: string }>(
      `select t.id,t.slug,t.display_name as "displayName" from tenants t where t.id=$1 and t.enabled and ($3 or exists(select 1 from tenant_memberships m where m.tenant_id=t.id and m.user_id=$2 and m.enabled))`,
      [row!.tenant_id, row!.user_id, current!.role === 'administrator'],
    )
  ).rows;
  if (!tenants.length) fail(403, 'CLIENT_ACCESS_REVOKED');
  const effective: string[] = [];
  if (options.repositoryId && !row!.repository_ids.includes(options.repositoryId))
    fail(403, 'CLIENT_SCOPE_DENIED');
  for (const id of options.repositoryId ? [options.repositoryId] : row!.repository_ids) {
    const tenant = await database.query(
      'select id from repositories where id=$1 and tenant_id=$2',
      [id, row!.tenant_id],
    );
    if (tenant.rowCount && (await knowledgeUserAllowed(database, id, row!.user_id, 'reader')))
      effective.push(id);
  }
  if (options.repositoryId && !effective.includes(options.repositoryId))
    fail(403, 'CLIENT_SCOPE_DENIED');
  return {
    user: {
      id: current!.id,
      subject: current!.subject,
      displayName: current!.displayName,
      role: current!.role,
      groups: current!.groups,
      enabled: true,
      tenantIds: tenants.map((t) => t.id),
      tenants,
    },
    keyId: row!.id,
    clientId: row!.client_id,
    tenantId: row!.tenant_id,
    repositoryIds: effective,
    scopes: row!.scopes,
    expiresAt: row!.expires_at.toISOString(),
  };
}
