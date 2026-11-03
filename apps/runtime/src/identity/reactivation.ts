import type { Database, DatabaseClient } from '@gcr/db';
import type { SamlIdentity, SamlProviderBinding } from '../auth/saml-state.js';
import { lockUserAdministration } from '../services/user-lifecycle.js';
import { KeycloakAdminError } from './keycloak-admin.js';
import { KeycloakSecurityError, type SecurityObservation } from './keycloak-security.js';
import { auditIdentityLifecycle, identityLifecycleTransaction } from './lifecycle.js';
import {
  claimIdentityOperation,
  IdentityOperationError,
  lockIdentityOperationClaim,
  type IdentityOperationClaim,
} from './operations.js';
import { withIdentityRemoteLease } from './remote-lease.js';
import type { IdentitySecurityAdministration } from './security-processor.js';
import {
  applySecurityObservation,
  applySecurityObservationInTransaction,
  claimSecurityObservation,
  failSecurityObservation,
  IdentitySecurityStateError,
  type SecurityObservationLease,
} from './security-state.js';

interface Mapping {
  keycloak_user_id: string;
  name_id: string;
  name_id_format: string;
  name_qualifier: string | null;
  sp_name_qualifier: string | null;
}
const fail = (code: IdentityOperationError['code']): never => {
  throw new IdentityOperationError(code);
};

// Caller uses a short transaction. Security observations use the same global
// lock, so final validation can commit their revocations even when enabling fails.
async function liveMapping(
  client: DatabaseClient,
  binding: SamlProviderBinding,
  claim: IdentityOperationClaim,
): Promise<Mapping | null> {
  const expected = claim.operation;
  await client.query("select pg_advisory_xact_lock(hashtext('gcr:user-administration'))");
  const actorValid =
    expected.requested_by && (await lockUserAdministration(client, expected.requested_by));
  const target = (
    await client.query<{ enabled: boolean }>(
      `select enabled from users
    where id=$1 and oidc_subject=$2 and deleted_at is null for update`,
      [expected.user_id, expected.expected_subject],
    )
  ).rows[0];
  let current;
  try {
    current = await lockIdentityOperationClaim(client, claim);
  } catch (error) {
    if (error instanceof IdentityOperationError && error.code === 'IDENTITY_OPERATION_LEASE_LOST')
      return null;
    throw error;
  }
  if (
    !actorValid ||
    !target ||
    target.enabled ||
    current.kind !== 'enable' ||
    current.requested_by !== expected.requested_by ||
    current.expected_security_epoch !== expected.expected_security_epoch
  )
    return null;
  return (
    (
      await client.query<Mapping>(
        `select i.keycloak_user_id,i.name_id,i.name_id_format,i.name_qualifier,i.sp_name_qualifier
    from user_identities i where i.id=$1 and i.user_id=$2 and i.idp_issuer=$3 and i.sp_entity_id=$4
    and i.keycloak_user_id=$5 and i.name_id=$6 and i.security_epoch=$7
    and i.provisioning_state='provisioned' and not i.enabled and i.idp_disabled_by_gcr for update`,
        [
          current.identity_id,
          current.user_id,
          binding.issuer,
          binding.entityId,
          current.external_user_id,
          current.expected_name_id,
          current.expected_security_epoch,
        ],
      )
    ).rows[0] ?? null
  );
}
function exactProfile(
  mapping: Mapping,
  binding: SamlProviderBinding,
  profile: SamlIdentity,
  keycloakUserId: string,
) {
  if (
    mapping.keycloak_user_id !== keycloakUserId ||
    profile.issuer !== binding.issuer ||
    profile.entityId !== binding.entityId ||
    profile.nameID !== mapping.name_id ||
    profile.nameIDFormat !== mapping.name_id_format ||
    (profile.nameQualifier ?? null) !== mapping.name_qualifier ||
    (profile.spNameQualifier ?? null) !== mapping.sp_name_qualifier
  )
    throw new KeycloakAdminError('IDENTITY_ACCOUNT_CONFLICT');
}
async function reject(client: DatabaseClient, claim: IdentityOperationClaim, code: string) {
  try {
    await lockIdentityOperationClaim(client, claim);
  } catch (error) {
    if (error instanceof IdentityOperationError && error.code === 'IDENTITY_OPERATION_LEASE_LOST')
      return;
    throw error;
  }
  await client.query(
    `update identity_admin_operations set state='failed',retryable=true,error_code=$2,
    updated_at=clock_timestamp() where id=$1`,
    [claim.operation.id, code],
  );
  await client.query(
    `update identity_admin_outbox set claimed_by=null,claimed_until=null,last_error_code=$2
    where operation_id=$1`,
    [claim.operation.id, code],
  );
  await auditIdentityLifecycle(
    client,
    claim.operation.requested_by,
    claim.operation.id,
    'identity.lifecycle.failed',
    'failure',
  );
}
async function inspect(
  database: Database,
  binding: SamlProviderBinding,
  claim: IdentityOperationClaim,
) {
  return identityLifecycleTransaction(database, async (client) => {
    const mapping = await liveMapping(client, binding, claim);
    if (!mapping) return fail('IDENTITY_OPERATION_CONFLICT');
    return mapping;
  });
}
async function capture(
  database: Database,
  binding: SamlProviderBinding,
  adapter: IdentitySecurityAdministration,
) {
  const lease = await claimSecurityObservation(database, binding, true);
  if (!lease) return fail('IDENTITY_SECURITY_UNAVAILABLE');
  try {
    return { lease, observation: await adapter.capture(lease.previous) };
  } catch (error) {
    await failSecurityObservation(
      database,
      binding,
      lease,
      error instanceof KeycloakSecurityError ? error.code : 'IDENTITY_ADMIN_UNAVAILABLE',
      error instanceof KeycloakSecurityError,
    );
    throw error;
  }
}
function ownWriteIds(
  before: SecurityObservation,
  after: SecurityObservation,
  userId: string,
  updated: boolean,
) {
  const oldIds = new Set(before.events.map((event) => event.id));
  const events = after.events.filter(
    (event) =>
      !oldIds.has(event.id) &&
      event.stream === 'administration' &&
      event.ownAdministration &&
      event.userId === userId,
  );
  if (
    events.length !== (updated ? 2 : 1) ||
    events.filter((event) => event.administrationAction === 'update-user').length !==
      (updated ? 1 : 0) ||
    events.filter((event) => event.administrationAction === 'logout-user').length !== 1
  )
    throw new KeycloakAdminError('IDENTITY_RESULT_UNCONFIRMED');
  return events.map((event) => event.id);
}
async function finish(
  database: Database,
  binding: SamlProviderBinding,
  claim: IdentityOperationClaim,
  after: { lease: SecurityObservationLease; observation: SecurityObservation },
  eventIds: string[] | undefined,
  profile: SamlIdentity,
  keycloakUserId: string,
  assertHeld: () => void,
) {
  return identityLifecycleTransaction(database, async (client) => {
    const before = await liveMapping(client, binding, claim);
    const observation = await applySecurityObservationInTransaction(
      client,
      binding,
      after.lease,
      after.observation,
      before && eventIds
        ? { operationId: claim.operation.id, claimId: claim.claimId, eventIds }
        : undefined,
    );
    const mapping = await liveMapping(client, binding, claim);
    if (!eventIds || !mapping || after.observation.continuity !== 'continuous') {
      await reject(client, claim, 'IDENTITY_OPERATION_CONFLICT');
      return false;
    }
    exactProfile(mapping, binding, profile, keycloakUserId);
    assertHeld();
    await client.query('update users set enabled=true,updated_at=clock_timestamp() where id=$1', [
      claim.operation.user_id,
    ]);
    await client.query(
      `update user_identities set enabled=true,idp_disabled_by_gcr=false,
      security_reconciled_epoch=security_epoch,identity_verified_at=clock_timestamp(),
      security_checked_at=$2,security_fresh_until=$2::timestamptz+interval '5 minutes',
      security_login_after=clock_timestamp(),updated_at=clock_timestamp() where id=$1`,
      [claim.operation.identity_id, observation.checkedAt],
    );
    await client.query(
      'delete from identity_security_logout_outbox where identity_id=$1 and security_epoch=$2',
      [claim.operation.identity_id, claim.operation.expected_security_epoch],
    );
    await client.query(
      `update identity_admin_operations set state='succeeded',error_code=null,retryable=false,
      updated_at=clock_timestamp() where id=$1`,
      [claim.operation.id],
    );
    await client.query(
      `update identity_admin_outbox set delivered_at=clock_timestamp(),claimed_by=null,
      claimed_until=null,last_error_code=null where operation_id=$1`,
      [claim.operation.id],
    );
    await auditIdentityLifecycle(
      client,
      claim.operation.requested_by,
      claim.operation.id,
      'identity.lifecycle.complete',
    );
    assertHeld();
    return true;
  });
}

export async function processIdentityReactivation(
  database: Database,
  binding: SamlProviderBinding,
  adapter: IdentitySecurityAdministration,
): Promise<boolean> {
  if (
    adapter.endpoints.issuer !== binding.issuer ||
    adapter.endpoints.entityId !== binding.entityId
  )
    return fail('IDENTITY_OPERATION_INVALID');
  const work = await withIdentityRemoteLease(database, binding.issuer, ({ assertHeld }) =>
    adapter.withRequestGuard(assertHeld, async () => {
      const claim = await claimIdentityOperation(database, binding, 'reactivation');
      if (!claim) return false;
      try {
        // A previous process may have reached the IdP before it crashed. Surface
        // that uncertainty and retain the durable block until an explicit retry.
        if (claim.attempt > 1) throw new KeycloakAdminError('IDENTITY_RESULT_UNCONFIRMED');
        await inspect(database, binding, claim);
        const before = await capture(database, binding, adapter);
        await applySecurityObservation(database, binding, before.lease, before.observation);
        if (before.observation.continuity !== 'continuous')
          return fail('IDENTITY_SECURITY_UNAVAILABLE');
        const mapping = await inspect(database, binding, claim);
        const user = await adapter.getUser(mapping.keycloak_user_id);
        exactProfile(mapping, binding, adapter.identity(user), user.id);
        await inspect(database, binding, claim);
        if (!user.enabled) await adapter.setEnabled(user.id, true);
        await inspect(database, binding, claim);
        await adapter.logoutAll(user.id);
        const verified = await adapter.getUser(user.id);
        exactProfile(mapping, binding, adapter.identity(verified), verified.id);
        if (!verified.enabled) throw new KeycloakAdminError('IDENTITY_RESULT_UNCONFIRMED');
        const after = await capture(database, binding, adapter);
        let eventIds: string[] | undefined;
        try {
          eventIds = ownWriteIds(before.observation, after.observation, user.id, !user.enabled);
        } catch (error) {
          if (!(error instanceof KeycloakAdminError)) throw error;
        }
        assertHeld();
        await finish(
          database,
          binding,
          claim,
          after,
          eventIds,
          adapter.identity(verified),
          verified.id,
          assertHeld,
        );
      } catch (error) {
        const code =
          error instanceof KeycloakAdminError ||
          error instanceof KeycloakSecurityError ||
          error instanceof IdentityOperationError ||
          error instanceof IdentitySecurityStateError
            ? error.code
            : 'IDENTITY_ADMIN_UNAVAILABLE';
        await identityLifecycleTransaction(database, async (client) => {
          await client.query("select pg_advisory_xact_lock(hashtext('gcr:user-administration'))");
          await reject(client, claim, code);
        });
      }
      return true;
    }),
  );
  return work.acquired ? work.result : false;
}
