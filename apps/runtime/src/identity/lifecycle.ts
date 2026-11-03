import { createHash } from 'node:crypto';
import type { Database, DatabaseClient } from '@gcr/db';
import { identityLifecycleRequest, type IdentityLifecycleRequest } from '@gcr/contracts';
import { samlConfigurationKey, type SamlProviderBinding } from '../auth/saml-state.js';
import { hasOtherAdministrator, lockUserAdministration } from '../services/user-lifecycle.js';
import {
  IdentityOperationError,
  supersedeIdentityOperations,
  type IdentityOperation,
} from './operations.js';
import { revokeUserIdentitySecurity } from './revocation.js';
import { IdentitySecurityStateError } from './security-state.js';
import { z } from 'zod';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code: IdentityOperationError['code']): never => {
  throw new IdentityOperationError(code);
};
export async function identityLifecycleTransaction<T>(
  database: Database,
  action: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const client = await database
    .connect()
    .catch(() => fail('IDENTITY_OPERATION_STORAGE_UNAVAILABLE'));
  try {
    await client.query('begin');
    await client.query("set local lock_timeout='5s'");
    await client.query("set local statement_timeout='10s'");
    const result = await action(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    if (error instanceof IdentityOperationError || error instanceof IdentitySecurityStateError)
      throw error;
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505')
      return fail('IDENTITY_OPERATION_CONFLICT');
    return fail('IDENTITY_OPERATION_STORAGE_UNAVAILABLE');
  } finally {
    client.release();
  }
}
export async function auditIdentityLifecycle(
  client: DatabaseClient,
  actorId: string | null,
  operationId: string,
  action: string,
  outcome: 'success' | 'failure' = 'success',
) {
  // Attribution describes the original authorized request; it does not grant
  // permission to a disabled actor or impersonate an administrator.
  await client.query(
    `insert into audit_events(actor,action,resource_type,resource_id,outcome,request_id,metadata)
    values(coalesce((select oidc_subject from users where id=$1),'identity-reconciliation'),$2,
      'identity-operation',$3,$4,$3,'{}'::jsonb)`,
    [actorId, action, operationId, outcome],
  );
}
export async function requestIdentityLifecycle(
  database: Database,
  binding: SamlProviderBinding,
  actorId: string,
  input: IdentityLifecycleRequest,
): Promise<IdentityOperation> {
  const key = samlConfigurationKey(binding),
    parsed = identityLifecycleRequest.safeParse(input);
  if (!parsed.success) return fail('IDENTITY_OPERATION_INVALID');
  const request = parsed.data;
  return identityLifecycleTransaction(database, async (client) => {
    if (!(await lockUserAdministration(client, actorId)))
      return fail('IDENTITY_OPERATION_FORBIDDEN');
    const dedupe = hash([binding.issuer, binding.entityId, actorId, request.requestId]),
      fingerprint = hash(request);
    const old = (
      await client.query<IdentityOperation & { request_fingerprint: string }>(
        'select * from identity_admin_operations where dedupe_key=$1 for update',
        [dedupe],
      )
    ).rows[0];
    if (old) {
      if (old.request_fingerprint !== fingerprint) return fail('IDENTITY_OPERATION_CONFLICT');
      return old;
    }
    const target = (
      await client.query<{ oidc_subject: string; enabled: boolean; role: string }>(
        'select oidc_subject,enabled,role from users where id=$1 and deleted_at is null for update',
        [request.target.userId],
      )
    ).rows[0];
    if (!target) return fail('IDENTITY_OPERATION_NOT_FOUND');
    if (target.oidc_subject !== request.target.expectedSubject)
      return fail('IDENTITY_OPERATION_CONFLICT');
    const identity = (
      await client.query<{
        id: string;
        keycloak_user_id: string;
        name_id: string;
        enabled: boolean;
      }>(
        `select id,keycloak_user_id,name_id,enabled from user_identities where user_id=$1 and idp_issuer=$2
       and sp_entity_id=$3 and provisioning_state='provisioned' for update`,
        [request.target.userId, binding.issuer, binding.entityId],
      )
    ).rows[0];
    if (!identity) return fail('IDENTITY_OPERATION_CONFLICT');
    if (
      request.kind === 'disable' &&
      target.enabled &&
      target.role === 'administrator' &&
      !(await hasOtherAdministrator(client, request.target.userId))
    )
      return fail('IDENTITY_LAST_ADMINISTRATOR_REQUIRED');
    if (request.kind === 'enable') {
      if (actorId === request.target.userId || (target.enabled && identity.enabled))
        return fail('IDENTITY_OPERATION_CONFLICT');
      const source = await client.query(
        `select 1 from identity_security_sources where configuration_key=$1
        and state='healthy' and checked_at<=clock_timestamp() and checked_at>clock_timestamp()-interval '5 minutes'`,
        [key],
      );
      if (!source.rowCount) return fail('IDENTITY_SECURITY_UNAVAILABLE');
    }
    if (request.kind !== 'enable') await supersedeIdentityOperations(client, request.target.userId);
    // Pending reactivation retains a durable block. A crash after the remote PUT
    // leaves compensation for the security worker; only verified completion clears it.
    await revokeUserIdentitySecurity(client, request.target.userId, {
      disableAtIdentityProvider: request.kind !== 'logout-all',
    });
    if (request.kind !== 'logout-all') {
      await client.query(
        'update users set enabled=false,updated_at=clock_timestamp() where id=$1',
        [request.target.userId],
      );
      await client.query(
        'update user_identities set enabled=false,updated_at=clock_timestamp() where user_id=$1',
        [request.target.userId],
      );
    }
    const epoch = (
      await client.query<{ security_epoch: string }>(
        'select security_epoch from user_identities where id=$1',
        [identity.id],
      )
    ).rows[0]!.security_epoch;
    const operation = (
      await client.query<IdentityOperation>(
        `insert into identity_admin_operations(
      user_id,identity_id,requested_by,kind,dedupe_key,request_fingerprint,idp_issuer,sp_entity_id,
      expected_subject,expected_name_id,external_user_id,expected_security_epoch)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
        [
          request.target.userId,
          identity.id,
          actorId,
          request.kind,
          dedupe,
          fingerprint,
          binding.issuer,
          binding.entityId,
          target.oidc_subject,
          identity.name_id,
          identity.keycloak_user_id,
          epoch,
        ],
      )
    ).rows[0]!;
    await client.query('insert into identity_admin_outbox(operation_id) values($1)', [
      operation.id,
    ]);
    await auditIdentityLifecycle(client, actorId, operation.id, 'identity.lifecycle.request');
    return operation;
  });
}

// Revocation continues after the requesting actor loses access. It never enables
// a user, and only acknowledges an exact mapping with the requested (or newer)
// security epoch already confirmed at the IdP. Superseded requests stay failed.
export async function completeIdentityRevocations(
  database: Database,
  binding: SamlProviderBinding,
) {
  samlConfigurationKey(binding);
  return identityLifecycleTransaction(database, async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext('gcr:user-administration'))");
    const completed = await client.query<{ id: string; requested_by: string | null }>(
      `update identity_admin_operations o
      set state='succeeded',error_code=null,retryable=false,updated_at=clock_timestamp()
      from user_identities i where o.identity_id=i.id and o.user_id=i.user_id
      and o.idp_issuer=$1 and o.sp_entity_id=$2 and o.kind in ('disable','logout-all')
      and o.state in ('pending','running') and i.keycloak_user_id=o.external_user_id and i.name_id=o.expected_name_id
      and i.idp_issuer=o.idp_issuer and i.sp_entity_id=o.sp_entity_id
      and exists(select 1 from users u where u.id=o.user_id and u.oidc_subject=o.expected_subject
        and (o.kind<>'disable' or not u.enabled))
      and i.security_reconciled_epoch>=o.expected_security_epoch
      and (o.kind<>'disable' or (i.idp_disabled_by_gcr and not i.enabled)) returning o.id,o.requested_by`,
      [binding.issuer, binding.entityId],
    );
    for (const operation of completed.rows) {
      await client.query(
        `update identity_admin_outbox set delivered_at=clock_timestamp(),claimed_by=null,
        claimed_until=null,last_error_code=null where operation_id=$1`,
        [operation.id],
      );
      await auditIdentityLifecycle(
        client,
        operation.requested_by,
        operation.id,
        'identity.lifecycle.complete',
      );
    }
    await client.query(
      `update identity_admin_operations o set error_code=q.last_error_code,
      state=case when q.claim_id is null then 'pending' else 'running' end,updated_at=clock_timestamp()
      from identity_security_logout_outbox q where o.identity_id=q.identity_id and o.idp_issuer=$1
      and o.sp_entity_id=$2 and o.kind in ('disable','logout-all') and o.state in ('pending','running')`,
      [binding.issuer, binding.entityId],
    );
    return completed.rowCount ?? 0;
  });
}

export async function retryIdentityReactivation(
  database: Database,
  binding: SamlProviderBinding,
  actorId: string,
  operationId: string,
) {
  const key = samlConfigurationKey(binding);
  if (!z.string().uuid().safeParse(operationId).success) return fail('IDENTITY_OPERATION_INVALID');
  return identityLifecycleTransaction(database, async (client) => {
    if (!(await lockUserAdministration(client, actorId)))
      return fail('IDENTITY_OPERATION_FORBIDDEN');
    const operation = (
      await client.query<IdentityOperation>(
        `select * from identity_admin_operations
      where id=$1 and idp_issuer=$2 and sp_entity_id=$3 for update`,
        [operationId, binding.issuer, binding.entityId],
      )
    ).rows[0];
    if (!operation) return fail('IDENTITY_OPERATION_NOT_FOUND');
    if (
      operation.kind !== 'enable' ||
      operation.state !== 'failed' ||
      operation.error_code === 'IDENTITY_ACCESS_CHANGED' ||
      !operation.user_id ||
      actorId === operation.user_id
    )
      return fail('IDENTITY_OPERATION_CONFLICT');
    const target = await client.query(
      `select id from users where id=$1 and oidc_subject=$2
      and deleted_at is null and not enabled for update`,
      [operation.user_id, operation.expected_subject],
    );
    if (!target.rowCount) return fail('IDENTITY_OPERATION_CONFLICT');
    const source = await client.query(
      `select 1 from identity_security_sources where configuration_key=$1
      and state='healthy' and checked_at<=clock_timestamp() and checked_at>clock_timestamp()-interval '5 minutes'`,
      [key],
    );
    if (!source.rowCount) return fail('IDENTITY_SECURITY_UNAVAILABLE');
    const identity = await client.query(
      `select id from user_identities where id=$1 and user_id=$2 and idp_issuer=$3 and sp_entity_id=$4
      and keycloak_user_id=$5 and name_id=$6 and provisioning_state='provisioned' and not enabled for update`,
      [
        operation.identity_id,
        operation.user_id,
        binding.issuer,
        binding.entityId,
        operation.external_user_id,
        operation.expected_name_id,
      ],
    );
    if (!identity.rowCount) return fail('IDENTITY_OPERATION_CONFLICT');
    await revokeUserIdentitySecurity(client, operation.user_id, {
      disableAtIdentityProvider: true,
    });
    await client.query(
      `update identity_admin_operations set state='pending',requested_by=$2,error_code=null,retryable=false,
      expected_security_epoch=(select security_epoch from user_identities where id=$3),updated_at=clock_timestamp() where id=$1`,
      [operation.id, actorId, operation.identity_id],
    );
    await client.query(
      `update identity_admin_outbox set delivered_at=null,claimed_by=null,claimed_until=null,
      attempt_count=0,last_error_code=null,available_at=clock_timestamp() where operation_id=$1`,
      [operation.id],
    );
    await auditIdentityLifecycle(client, actorId, operation.id, 'identity.lifecycle.retry');
  });
}
