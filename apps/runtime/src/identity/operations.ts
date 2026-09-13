import { createHash, randomUUID } from 'node:crypto';
import type { Database, DatabaseClient } from '@gcr/db';
import { z } from 'zod';
import { identityProvisioningRequest, type IdentityProvisioningRequest } from '@gcr/contracts';
export { identityProvisioningRequest, type IdentityProvisioningRequest } from '@gcr/contracts';
import { samlConfigurationKey, type SamlProviderBinding } from '../auth/saml-state.js';
import { lockUserAdministration } from '../services/user-lifecycle.js';
import { revokeUserIdentitySecurity } from './revocation.js';

export class IdentityOperationError extends Error {
  constructor(
    readonly code:
      | 'IDENTITY_OPERATION_INVALID'
      | 'IDENTITY_OPERATION_FORBIDDEN'
      | 'IDENTITY_OPERATION_CONFLICT'
      | 'IDENTITY_OPERATION_NOT_FOUND'
      | 'IDENTITY_OPERATION_LEASE_LOST'
      | 'IDENTITY_OPERATION_STORAGE_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'IdentityOperationError';
  }
}

const uuid = z.string().uuid();

export interface IdentityOperation {
  id: string;
  user_id: string | null;
  identity_id: string | null;
  requested_by: string | null;
  kind: 'create' | 'link' | 'invite' | 'password-reset';
  state: 'pending' | 'running' | 'succeeded' | 'failed';
  requested_username: string | null;
  requested_email: string | null;
  requested_display_name: string | null;
  external_user_id: string | null;
  expected_subject: string;
  expected_name_id: string | null;
  creates_app_user: boolean;
  mail_dispatched_at: Date | null;
  retryable: boolean;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
}
export interface IdentityOperationClaim {
  operation: IdentityOperation;
  claimId: string;
  attempt: number;
}
function fail(code: IdentityOperationError['code']): never {
  throw new IdentityOperationError(code);
}
const digest = (values: unknown) =>
  createHash('sha256').update(JSON.stringify(values)).digest('hex');

async function atomic<T>(
  database: Database,
  action: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  let client: DatabaseClient | undefined;
  try {
    client = await database.connect();
    await client.query('begin');
    await client.query("set local lock_timeout = '5s'");
    await client.query("set local statement_timeout = '10s'");
    const result = await action(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client?.query('rollback').catch(() => undefined);
    if (error instanceof IdentityOperationError) throw error;
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505')
      fail('IDENTITY_OPERATION_CONFLICT');
    return fail('IDENTITY_OPERATION_STORAGE_UNAVAILABLE');
  } finally {
    client?.release();
  }
}

async function actor(client: DatabaseClient, actorId: string) {
  if (!uuid.safeParse(actorId).success) fail('IDENTITY_OPERATION_INVALID');
  if (!(await lockUserAdministration(client, actorId))) fail('IDENTITY_OPERATION_FORBIDDEN');
}
async function audit(client: DatabaseClient, actorId: string, operationId: string, action: string) {
  // Only operation identifiers enter the audit; no email, NameID, token or profile.
  await client.query(
    `insert into audit_events(actor,action,resource_type,resource_id,outcome,request_id,metadata)
    select oidc_subject,$2,'identity-operation',$3,'success',$3,'{}'::jsonb from users where id=$1`,
    [actorId, action, operationId],
  );
}

export async function requestIdentityProvisioning(
  database: Database,
  binding: SamlProviderBinding,
  actorId: string,
  input: IdentityProvisioningRequest,
): Promise<IdentityOperation> {
  samlConfigurationKey(binding);
  const parsed = identityProvisioningRequest.safeParse(input);
  if (!parsed.success) fail('IDENTITY_OPERATION_INVALID');
  const request = parsed.data;
  if (request.kind === 'create' && request.target.kind === 'new')
    request.target.tenantIds = [...new Set(request.target.tenantIds)].sort();
  const dedupe = digest([binding.issuer, binding.entityId, actorId, request.requestId]);
  const fingerprint = digest(request);
  return atomic(database, async (client) => {
    await actor(client, actorId);
    const previous = (
      await client.query<IdentityOperation & { request_fingerprint: string }>(
        'select * from identity_admin_operations where dedupe_key=$1 for update',
        [dedupe],
      )
    ).rows[0];
    if (previous) {
      if (previous.request_fingerprint !== fingerprint) fail('IDENTITY_OPERATION_CONFLICT');
      return previous;
    }
    let userId: string, subject: string;
    const creates = request.kind === 'create' && request.target.kind === 'new';
    if (request.kind === 'create' && request.target.kind === 'new') {
      userId = randomUUID();
      subject = `saml:${userId}`;
      await client.query(
        `insert into users(id,oidc_subject,display_name,role,enabled)
        values($1,$2,$3,$4,false)`,
        [userId, subject, request.displayName, request.target.role],
      );
      const memberships = await client.query(
        `insert into tenant_memberships(tenant_id,user_id,created_by)
        select id,$1,$2 from tenants where id=any($3::uuid[]) and enabled returning tenant_id`,
        [userId, actorId, request.target.tenantIds],
      );
      if (memberships.rowCount !== request.target.tenantIds.length)
        fail('IDENTITY_OPERATION_INVALID');
    } else {
      if (request.target.kind !== 'existing') return fail('IDENTITY_OPERATION_INVALID');
      const target = (
        await client.query<{ oidc_subject: string }>(
          'select oidc_subject from users where id=$1 and deleted_at is null for update',
          [request.target.userId],
        )
      ).rows[0];
      if (!target) fail('IDENTITY_OPERATION_NOT_FOUND');
      if (target.oidc_subject !== request.target.expectedSubject)
        fail('IDENTITY_OPERATION_CONFLICT');
      userId = request.target.userId;
      subject = target.oidc_subject;
    }
    const identity = (
      await client.query<{
        id: string;
        keycloak_user_id: string;
        name_id: string;
        provisioning_state: string;
        enabled: boolean;
      }>(
        `select id,keycloak_user_id,name_id,provisioning_state,enabled from user_identities
       where user_id=$1 and idp_issuer=$2 and sp_entity_id=$3 for update`,
        [userId, binding.issuer, binding.entityId],
      )
    ).rows[0];
    if (request.kind === 'invite' || request.kind === 'password-reset') {
      if (!identity?.enabled || identity.provisioning_state !== 'provisioned')
        fail('IDENTITY_OPERATION_CONFLICT');
    } else if (identity) fail('IDENTITY_OPERATION_CONFLICT');
    if (request.kind === 'password-reset') {
      await revokeUserIdentitySecurity(client, userId);
    }
    const operation = (
      await client.query<IdentityOperation>(
        `insert into identity_admin_operations(
      user_id,identity_id,requested_by,kind,dedupe_key,request_fingerprint,idp_issuer,sp_entity_id,
      expected_subject,requested_username,requested_email,requested_display_name,external_user_id,
      expected_name_id,creates_app_user)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
        [
          userId,
          identity?.id ?? null,
          actorId,
          request.kind,
          dedupe,
          fingerprint,
          binding.issuer,
          binding.entityId,
          subject,
          request.kind === 'create'
            ? request.username
            : request.kind === 'link'
              ? request.expectedUsername
              : null,
          request.kind === 'create' ? request.email : request.expectedEmail,
          request.kind === 'create' ? request.displayName : null,
          request.kind === 'link' ? request.keycloakUserId : (identity?.keycloak_user_id ?? null),
          request.kind === 'link' ? request.expectedNameId : (identity?.name_id ?? null),
          creates,
        ],
      )
    ).rows[0]!;
    await client.query('insert into identity_admin_outbox(operation_id) values($1)', [
      operation.id,
    ]);
    await audit(client, actorId, operation.id, 'identity.provisioning.request');
    return operation;
  });
}

export async function claimIdentityOperation(
  database: Database,
  binding: SamlProviderBinding,
): Promise<IdentityOperationClaim | null> {
  samlConfigurationKey(binding);
  return atomic(database, async (client) => {
    const operation = (
      await client.query<IdentityOperation>(
        `select operation.* from identity_admin_operations operation
      join identity_admin_outbox outbox on outbox.operation_id=operation.id
      where operation.idp_issuer=$1 and operation.sp_entity_id=$2 and operation.kind in ('create','link','invite','password-reset')
        and operation.state in ('pending','running') and outbox.delivered_at is null
        and outbox.available_at<=clock_timestamp() and (outbox.claimed_until is null or outbox.claimed_until<=clock_timestamp())
      order by outbox.available_at,operation.created_at,operation.id for update of outbox skip locked limit 1`,
        [binding.issuer, binding.entityId],
      )
    ).rows[0];
    if (!operation) return null;
    const claimId = randomUUID();
    const outbox = (
      await client.query<{ attempt_count: number }>(
        `update identity_admin_outbox
      set claimed_by=$2,claimed_until=clock_timestamp()+interval '2 minutes',attempt_count=attempt_count+1
      where operation_id=$1 returning attempt_count`,
        [operation.id, claimId],
      )
    ).rows[0]!;
    await client.query(
      `update identity_admin_operations set state='running',updated_at=clock_timestamp()
      where id=$1`,
      [operation.id],
    );
    return {
      operation: { ...operation, state: 'running' },
      claimId,
      attempt: outbox.attempt_count,
    };
  });
}

export async function lockIdentityOperationClaim(
  client: DatabaseClient,
  claim: IdentityOperationClaim,
): Promise<IdentityOperation> {
  const lease = await client.query(
    `select operation_id from identity_admin_outbox
    where operation_id=$1 and claimed_by=$2 and claimed_until>clock_timestamp()
      and delivered_at is null for update`,
    [claim.operation.id, claim.claimId],
  );
  if (!lease.rowCount) fail('IDENTITY_OPERATION_LEASE_LOST');
  const row = (
    await client.query<IdentityOperation>(
      `select * from identity_admin_operations where id=$1 and state='running' for update`,
      [claim.operation.id],
    )
  ).rows[0];
  if (!row) fail('IDENTITY_OPERATION_LEASE_LOST');
  return row;
}

async function liveClaim(client: DatabaseClient, claim: IdentityOperationClaim) {
  // Shared lock order: administration, actor/target user, outbox, operation,
  // identity. No network call executes while any transaction lock is held.
  const expected = claim.operation;
  if (!expected.requested_by || !expected.user_id) fail('IDENTITY_OPERATION_FORBIDDEN');
  await actor(client, expected.requested_by);
  const target = (
    await client.query<{ enabled: boolean }>(
      `select enabled from users
    where id=$1 and oidc_subject=$2 and deleted_at is null for update`,
      [expected.user_id, expected.expected_subject],
    )
  ).rows[0];
  if (!target) fail('IDENTITY_OPERATION_CONFLICT');
  const operation = await lockIdentityOperationClaim(client, claim);
  if (operation.requested_by !== expected.requested_by || operation.user_id !== expected.user_id)
    fail('IDENTITY_OPERATION_LEASE_LOST');
  return { operation, userEnabled: target.enabled };
}

export async function inspectIdentityOperationClaim(
  database: Database,
  claim: IdentityOperationClaim,
) {
  return atomic(database, (client) => liveClaim(client, claim));
}

export async function beginIdentityMailDispatch(
  database: Database,
  claim: IdentityOperationClaim,
): Promise<void> {
  return atomic(database, async (client) => {
    const { operation: row, userEnabled } = await liveClaim(client, claim);
    if (!userEnabled) fail('IDENTITY_OPERATION_CONFLICT');
    if (!['invite', 'password-reset'].includes(row.kind) || row.mail_dispatched_at)
      fail('IDENTITY_OPERATION_CONFLICT');
    // Commit this marker before the network call. A crash or a reclaimed lease
    // after this point must be surfaced as unconfirmed, never auto-delivered again.
    await client.query(
      `update identity_admin_operations set mail_dispatched_at=clock_timestamp(),
      updated_at=clock_timestamp() where id=$1`,
      [row.id],
    );
  });
}

async function delivered(client: DatabaseClient, claim: IdentityOperationClaim) {
  const updated = await client.query(
    `update identity_admin_outbox set delivered_at=clock_timestamp(),
    claimed_by=null,claimed_until=null,last_error_code=null where operation_id=$1 and claimed_by=$2
    and claimed_until>clock_timestamp() returning operation_id`,
    [claim.operation.id, claim.claimId],
  );
  if (!updated.rowCount) fail('IDENTITY_OPERATION_LEASE_LOST');
  await client.query(
    `update identity_admin_operations set state='succeeded',error_code=null,
    retryable=false,updated_at=clock_timestamp() where id=$1`,
    [claim.operation.id],
  );
  await audit(
    client,
    claim.operation.requested_by!,
    claim.operation.id,
    'identity.provisioning.complete',
  );
}

export async function completeIdentityProvisioning(
  database: Database,
  claim: IdentityOperationClaim,
  input: { identityId: string; keycloakUserId: string; enabled: boolean },
): Promise<void> {
  if (!uuid.safeParse(input.identityId).success || !uuid.safeParse(input.keycloakUserId).success)
    fail('IDENTITY_OPERATION_INVALID');
  return atomic(database, async (client) => {
    const { operation: row, userEnabled } = await liveClaim(client, claim);
    if (!['create', 'link'].includes(row.kind) || (row.creates_app_user && !input.enabled))
      fail('IDENTITY_OPERATION_CONFLICT');
    const identity = (
      await client.query<{ name_id: string }>(
        `select name_id from user_identities
      where id=$1 and user_id=$2 and keycloak_user_id=$3 and
        idp_issuer=(select idp_issuer from identity_admin_operations where id=$4) and
        sp_entity_id=(select sp_entity_id from identity_admin_operations where id=$4) for update`,
        [input.identityId, row.user_id, input.keycloakUserId, row.id],
      )
    ).rows[0];
    if (
      !identity ||
      (row.expected_name_id && row.expected_name_id !== identity.name_id) ||
      (row.external_user_id && row.external_user_id !== input.keycloakUserId)
    )
      fail('IDENTITY_OPERATION_CONFLICT');
    if (row.creates_app_user)
      await client.query('update users set enabled=true,updated_at=clock_timestamp() where id=$1', [
        row.user_id,
      ]);
    await client.query(
      `update user_identities set provisioning_state='provisioned',
      identity_verified_at=clock_timestamp(),enabled=$2,updated_at=clock_timestamp()
      where id=$1`,
      [input.identityId, input.enabled && (row.creates_app_user || userEnabled)],
    );
    await client.query(
      `update identity_admin_operations set identity_id=$2,external_user_id=$3,
      expected_name_id=$4 where id=$1`,
      [row.id, input.identityId, input.keycloakUserId, identity.name_id],
    );
    // A user profile read does not establish security-event continuity. Freshness
    // remains unchanged; the C05 event/reconciliation authority supplies it.
    await delivered(client, claim);
  });
}

export async function completeIdentityMailDispatch(
  database: Database,
  claim: IdentityOperationClaim,
): Promise<void> {
  return atomic(database, async (client) => {
    const row = await lockIdentityOperationClaim(client, claim);
    if (!['invite', 'password-reset'].includes(row.kind) || !row.mail_dispatched_at)
      fail('IDENTITY_OPERATION_CONFLICT');
    await delivered(client, claim);
  });
}

export async function failIdentityOperation(
  database: Database,
  claim: IdentityOperationClaim,
  errorCode: string,
  retryable: boolean,
): Promise<void> {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode)) fail('IDENTITY_OPERATION_INVALID');
  return atomic(database, async (client) => {
    const row = await lockIdentityOperationClaim(client, claim);
    const uncertainMail = row.mail_dispatched_at !== null;
    const retry = retryable && !uncertainMail && claim.attempt < 5;
    const code = uncertainMail ? 'IDENTITY_EMAIL_UNCONFIRMED' : errorCode;
    await client.query(
      `update identity_admin_operations set state=$2,error_code=$3,retryable=$4,
      updated_at=clock_timestamp() where id=$1`,
      [row.id, retry ? 'pending' : 'failed', code, !uncertainMail && retryable],
    );
    await client.query(
      `update identity_admin_outbox set claimed_by=null,claimed_until=null,last_error_code=$2,
      available_at=clock_timestamp()+make_interval(secs=>$3) where operation_id=$1`,
      [row.id, code, Math.min(60, 2 ** claim.attempt)],
    );
    if (!retry && ['create', 'link'].includes(row.kind))
      await client.query(
        `update user_identities set provisioning_state='failed',enabled=false,
        updated_at=clock_timestamp() where user_id=$1 and provisioning_state='pending'
        and idp_issuer=(select idp_issuer from identity_admin_operations where id=$2)
        and sp_entity_id=(select sp_entity_id from identity_admin_operations where id=$2)`,
        [row.user_id, row.id],
      );
  });
}

export async function retryIdentityOperation(
  database: Database,
  binding: SamlProviderBinding,
  actorId: string,
  operationId: string,
): Promise<void> {
  samlConfigurationKey(binding);
  if (!uuid.safeParse(operationId).success) fail('IDENTITY_OPERATION_INVALID');
  return atomic(database, async (client) => {
    await actor(client, actorId);
    const row = (
      await client.query<IdentityOperation>(
        `select * from identity_admin_operations
      where id=$1 and idp_issuer=$2 and sp_entity_id=$3 for update`,
        [operationId, binding.issuer, binding.entityId],
      )
    ).rows[0];
    if (!row) fail('IDENTITY_OPERATION_NOT_FOUND');
    if (row.state !== 'failed' || row.mail_dispatched_at || !row.user_id)
      fail('IDENTITY_OPERATION_CONFLICT');
    if (row.error_code === 'IDENTITY_ACCESS_CHANGED') fail('IDENTITY_OPERATION_CONFLICT');
    const target = (
      await client.query(
        `select id from users where id=$1 and oidc_subject=$2
      and deleted_at is null for update`,
        [row.user_id, row.expected_subject],
      )
    ).rowCount;
    if (!target) fail('IDENTITY_OPERATION_CONFLICT');
    await client.query(
      `update identity_admin_operations set state='pending',requested_by=$2,
      error_code=null,retryable=false,updated_at=clock_timestamp() where id=$1`,
      [row.id, actorId],
    );
    await client.query(
      `update identity_admin_outbox set claimed_by=null,claimed_until=null,
      attempt_count=0,last_error_code=null,available_at=clock_timestamp() where operation_id=$1`,
      [row.id],
    );
    await audit(client, actorId, row.id, 'identity.provisioning.retry');
  });
}

// Caller holds the user-administration transaction lock and revokes local access
// in the same transaction. A late remote result can no longer enable the app user.
export async function supersedeIdentityOperations(
  client: DatabaseClient,
  userId: string,
): Promise<void> {
  const rows = (
    await client.query<{ operation_id: string }>(
      `select outbox.operation_id
    from identity_admin_outbox outbox join identity_admin_operations operation on operation.id=outbox.operation_id
    where operation.user_id=$1 and operation.state in ('pending','running')
    order by operation.id for update of outbox`,
      [userId],
    )
  ).rows;
  for (const row of rows) {
    await client.query(
      `update identity_admin_operations set state='failed',retryable=false,
      error_code='IDENTITY_ACCESS_CHANGED',updated_at=clock_timestamp() where id=$1`,
      [row.operation_id],
    );
    await client.query(
      `update identity_admin_outbox set claimed_by=null,claimed_until=null,
      last_error_code='IDENTITY_ACCESS_CHANGED' where operation_id=$1`,
      [row.operation_id],
    );
  }
}
