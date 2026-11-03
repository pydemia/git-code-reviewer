import { createHash, randomUUID } from 'node:crypto';
import type { Database, DatabaseClient } from '@gcr/db';
import {
  samlConfigurationKey,
  type SamlIdentity,
  type SamlProviderBinding,
} from '../auth/saml-state.js';
import type {
  SecurityCheckpoint,
  SecurityObservation,
  SecurityObservationFailure,
} from './keycloak-security.js';
import { revokeUserIdentitySecurity } from './revocation.js';

export class IdentitySecurityStateError extends Error {
  constructor(
    readonly code:
      | 'IDENTITY_SECURITY_LEASE_LOST'
      | 'IDENTITY_SECURITY_STORAGE_UNAVAILABLE'
      | 'IDENTITY_SECURITY_OBSERVATION_INVALID',
  ) {
    super(code);
    this.name = 'IdentitySecurityStateError';
  }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (code: IdentitySecurityStateError['code']): never => {
  throw new IdentitySecurityStateError(code);
};
async function atomic<T>(
  database: Database,
  action: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const client = await database
    .connect()
    .catch(() => fail('IDENTITY_SECURITY_STORAGE_UNAVAILABLE'));
  try {
    await client.query('begin');
    await client.query("set local lock_timeout='5s'");
    await client.query("set local statement_timeout='10s'");
    const result = await action(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    if (error instanceof IdentitySecurityStateError) throw error;
    return fail('IDENTITY_SECURITY_STORAGE_UNAVAILABLE');
  } finally {
    client.release();
  }
}
interface Source {
  configuration_key: string;
  state: 'unverified' | 'healthy' | 'gap';
  generation: string;
  realm_id: string | null;
  event_configuration_hash: string | null;
  security_anchor_id: string | null;
  security_anchor_time: string | null;
  admin_anchor_id: string | null;
  admin_anchor_time: string | null;
  observed_at: Date | null;
  lease_id: string;
  lease_started_at: Date;
}
export interface SecurityObservationLease {
  readonly id: string;
  readonly key: string;
  readonly startedAt: Date;
  readonly previous?: SecurityCheckpoint;
}
export async function claimSecurityObservation(
  database: Database,
  binding: SamlProviderBinding,
  immediate = false,
): Promise<SecurityObservationLease | null> {
  const key = samlConfigurationKey(binding),
    id = randomUUID();
  return atomic(database, async (client) => {
    await client.query(
      `insert into identity_security_sources(configuration_key,idp_issuer,sp_entity_id)
      values($1,$2,$3) on conflict(configuration_key) do nothing`,
      [key, binding.issuer, binding.entityId],
    );
    const row = (
      await client.query<Source>(
        `update identity_security_sources
      set lease_id=$2,lease_started_at=clock_timestamp(),lease_until=clock_timestamp()+interval '2 minutes'
      where configuration_key=$1 and ($3 or available_at<=clock_timestamp())
      and (lease_until is null or lease_until<=clock_timestamp()) returning *`,
        [key, id, immediate],
      )
    ).rows[0];
    if (!row) return null;
    return {
      id,
      key,
      startedAt: row.lease_started_at,
      ...(row.observed_at
        ? {
            previous: {
              realmId: row.realm_id!,
              configurationHash: row.event_configuration_hash!,
              security: { id: row.security_anchor_id!, time: Number(row.security_anchor_time) },
              administration: { id: row.admin_anchor_id!, time: Number(row.admin_anchor_time) },
              observedAt: row.observed_at.getTime(),
            },
          }
        : {}),
    };
  });
}
async function lockSource(
  client: DatabaseClient,
  binding: SamlProviderBinding,
  lease: SecurityObservationLease,
) {
  if (samlConfigurationKey(binding) !== lease.key) return fail('IDENTITY_SECURITY_LEASE_LOST');
  await client.query("select pg_advisory_xact_lock(hashtext('gcr:user-administration'))");
  const source = (
    await client.query<Source>(
      `select * from identity_security_sources where configuration_key=$1
    and lease_id=$2 and lease_until>clock_timestamp() for update`,
      [lease.key, lease.id],
    )
  ).rows[0];
  if (!source) return fail('IDENTITY_SECURITY_LEASE_LOST');
  return source;
}
async function identities(client: DatabaseClient, binding: SamlProviderBinding) {
  return (
    await client.query<{
      id: string;
      user_id: string;
      keycloak_user_id: string;
      idp_disabled_by_gcr: boolean;
      security_epoch: string;
      security_reconciled_epoch: string;
    }>(
      `select i.id,i.user_id,i.keycloak_user_id,i.idp_disabled_by_gcr,i.security_epoch,i.security_reconciled_epoch from user_identities i
     where i.idp_issuer=$1 and i.sp_entity_id=$2 and i.provisioning_state='provisioned'
     order by i.user_id,i.id`,
      [binding.issuer, binding.entityId],
    )
  ).rows;
}

// This commits only observations and local revocations. Profile verification and
// remote logout acknowledgment are separate; this function grants no freshness.
export async function applySecurityObservation(
  database: Database,
  binding: SamlProviderBinding,
  lease: SecurityObservationLease,
  observation: SecurityObservation,
) {
  return atomic(database, (client) =>
    applySecurityObservationInTransaction(client, binding, lease, observation),
  );
}
export async function applySecurityObservationInTransaction(
  client: DatabaseClient,
  binding: SamlProviderBinding,
  lease: SecurityObservationLease,
  observation: SecurityObservation,
  acknowledge?: {
    readonly operationId: string;
    readonly claimId: string;
    readonly eventIds: readonly string[];
  },
) {
  const source = await lockSource(client, binding, lease);
  const acknowledged = new Set(acknowledge?.eventIds ?? []);
  if (acknowledge) {
    const operation = (
      await client.query<{ external_user_id: string }>(
        `select o.external_user_id from identity_admin_operations o
        join identity_admin_outbox q on q.operation_id=o.id
        join users actor on actor.id=o.requested_by and actor.enabled and actor.deleted_at is null and actor.role='administrator'
        join users target on target.id=o.user_id and not target.enabled and target.deleted_at is null and target.oidc_subject=o.expected_subject
        join user_identities i on i.id=o.identity_id and i.user_id=o.user_id and i.keycloak_user_id=o.external_user_id
          and i.name_id=o.expected_name_id and i.idp_issuer=o.idp_issuer and i.sp_entity_id=o.sp_entity_id
          and i.security_epoch=o.expected_security_epoch and not i.enabled and i.idp_disabled_by_gcr and i.provisioning_state='provisioned'
        where o.id=$1 and o.kind='enable' and o.state='running' and o.idp_issuer=$2 and o.sp_entity_id=$3
          and q.claimed_by=$4 and q.claimed_until>clock_timestamp() and q.delivered_at is null for update of o`,
        [acknowledge.operationId, binding.issuer, binding.entityId, acknowledge.claimId],
      )
    ).rows[0];
    const events = observation.events.filter((event) => acknowledged.has(event.id));
    if (
      !operation ||
      acknowledged.size !== acknowledge.eventIds.length ||
      events.length !== acknowledged.size ||
      events.length < 1 ||
      events.length > 2 ||
      events.some(
        (event) =>
          event.stream !== 'administration' ||
          !event.ownAdministration ||
          event.userId !== operation.external_user_id ||
          !['update-user', 'logout-user'].includes(event.administrationAction ?? ''),
      ) ||
      events.filter((event) => event.administrationAction === 'logout-user').length !== 1 ||
      events.filter((event) => event.administrationAction === 'update-user').length > 1
    )
      return fail('IDENTITY_SECURITY_OBSERVATION_INVALID');
    const previouslyReceived = await client.query(
      `select 1 from identity_security_event_receipts
        where configuration_key=$1 and stream='administration' and event_id_hash=any($2::text[]) limit 1`,
      [lease.key, [...acknowledged].map(hash)],
    );
    if (previouslyReceived.rowCount) return fail('IDENTITY_SECURITY_OBSERVATION_INVALID');
  }
  const now = (await client.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]!.now;
  const checkpoint = observation.checkpoint;
  if (
    !Number.isSafeInteger(checkpoint.observedAt) ||
    Math.abs(checkpoint.observedAt - source.lease_started_at.getTime()) > 30_000 ||
    checkpoint.observedAt > now.getTime() + 30_000 ||
    now.getTime() - checkpoint.observedAt > 120_000 ||
    (observation.continuity === 'continuous' && !source.observed_at)
  )
    return fail('IDENTITY_SECURITY_OBSERVATION_INVALID');
  const targets = await identities(client, binding);
  const revoke = new Map<string, boolean>();
  const newGeneration = observation.continuity !== 'continuous' && source.state !== 'gap';
  if (newGeneration) for (const identity of targets) revoke.set(identity.user_id, true);
  for (const event of observation.events) {
    const inserted = await client.query(
      `insert into identity_security_event_receipts(
        configuration_key,stream,event_id_hash,event_time) values($1,$2,$3,$4)
        on conflict do nothing returning event_id_hash`,
      [lease.key, event.stream, hash(event.id), event.time],
    );
    if (!inserted.rowCount) continue;
    if (acknowledged.has(event.id)) continue;
    const affected =
      event.kind === 'revoke-provider'
        ? targets
        : targets.filter((identity) => identity.keycloak_user_id === event.userId);
    for (const identity of affected) {
      if (event.kind === 'logout-session') {
        if (!event.sessionId) return fail('IDENTITY_SECURITY_OBSERVATION_INVALID');
        await client.query('select id from users where id=$1 for update', [identity.user_id]);
        await client.query(
          `insert into identity_idp_session_revocations(identity_id,keycloak_session_hash)
            values($1,$2) on conflict(identity_id,keycloak_session_hash) do update set
            revoked_at=statement_timestamp(),expires_at=statement_timestamp()+interval '10 minutes'`,
          [identity.id, hash(event.sessionId)],
        );
        await client.query(
          `delete from user_sessions where saml_identity_id=$1
            and split_part(saml_session_index,'::',1)=$2`,
          [identity.id, event.sessionId],
        );
      } else {
        revoke.set(
          identity.user_id,
          (revoke.get(identity.user_id) ?? false) || !event.remoteLogoutConfirmed,
        );
      }
    }
  }
  for (const [userId, requiresRemoteLogout] of [...revoke].sort(([a], [b]) => a.localeCompare(b))) {
    await revokeUserIdentitySecurity(client, userId);
    if (!requiresRemoteLogout) {
      const confirmed = targets
        .filter(
          (identity) =>
            identity.user_id === userId &&
            (!identity.idp_disabled_by_gcr ||
              identity.security_reconciled_epoch === identity.security_epoch),
        )
        .map((identity) => identity.id);
      // A successful Keycloak /logout event already acknowledges that realm's
      // logout. Do not enqueue another logout and create an event feedback loop.
      const acknowledged = await client.query<{ id: string }>(
        `update user_identities set security_reconciled_epoch=security_epoch,
          security_login_after=clock_timestamp() where id=any($1::uuid[]) returning id`,
        [confirmed],
      );
      await client.query(
        'delete from identity_security_logout_outbox where identity_id=any($1::uuid[])',
        [acknowledged.rows.map((identity) => identity.id)],
      );
    }
  }
  // Newly provisioned mappings also need a confirmed logout before first use.
  await client.query(
    `insert into identity_security_logout_outbox(identity_id,security_epoch,desired_enabled)
      select id,security_epoch,case when idp_disabled_by_gcr then false else null end
      from user_identities where idp_issuer=$1 and sp_entity_id=$2
      and provisioning_state='provisioned' and security_reconciled_epoch<security_epoch
      on conflict(identity_id) do nothing`,
    [binding.issuer, binding.entityId],
  );
  await client.query(
    `update identity_security_sources set state='healthy',generation=generation+$3,
      realm_id=$4,event_configuration_hash=$5,security_anchor_id=$6,security_anchor_time=$7,
      admin_anchor_id=$8,admin_anchor_time=$9,observed_at=$10,checked_at=lease_started_at,
      lease_id=null,lease_started_at=null,lease_until=null,available_at=clock_timestamp()+interval '15 seconds',
      last_error_code=null,updated_at=clock_timestamp() where configuration_key=$1 and lease_id=$2`,
    [
      lease.key,
      lease.id,
      newGeneration ? 1 : 0,
      checkpoint.realmId,
      checkpoint.configurationHash,
      checkpoint.security.id,
      checkpoint.security.time,
      checkpoint.administration.id,
      checkpoint.administration.time,
      new Date(checkpoint.observedAt),
    ],
  );
  return { revokedUsers: revoke.size, checkedAt: source.lease_started_at };
}

export async function failSecurityObservation(
  database: Database,
  binding: SamlProviderBinding,
  lease: SecurityObservationLease,
  errorCode: SecurityObservationFailure | 'IDENTITY_ADMIN_UNAVAILABLE',
  confirmedGap: boolean,
) {
  return atomic(database, async (client) => {
    const source = await lockSource(client, binding, lease);
    const invalidate = confirmedGap && source.state !== 'gap';
    if (invalidate) {
      const userIds = [
        ...new Set((await identities(client, binding)).map((identity) => identity.user_id)),
      ].sort();
      for (const userId of userIds) await revokeUserIdentitySecurity(client, userId);
    }
    await client.query(
      `update identity_security_sources set state=case when $3 then 'gap' else state end,
      generation=generation+$4,last_error_code=$5,lease_id=null,lease_started_at=null,lease_until=null,
      available_at=clock_timestamp()+interval '15 seconds',updated_at=clock_timestamp()
      where configuration_key=$1 and lease_id=$2`,
      [lease.key, lease.id, confirmedGap, invalidate ? 1 : 0, errorCode],
    );
  });
}

export interface IdentityLogoutClaim {
  readonly id: string;
  readonly identityId: string;
  readonly userId: string;
  readonly keycloakUserId: string;
  readonly epoch: string;
  readonly desiredEnabled: false | null;
}
export async function claimIdentitySecurityLogout(
  database: Database,
  binding: SamlProviderBinding,
): Promise<IdentityLogoutClaim | null> {
  samlConfigurationKey(binding);
  return atomic(database, async (client) => {
    const row = (
      await client.query<{
        identity_id: string;
        security_epoch: string;
        user_id: string;
        keycloak_user_id: string;
        desired_enabled: false | null;
      }>(
        `select o.identity_id,o.security_epoch,o.desired_enabled,i.user_id,i.keycloak_user_id
       from identity_security_logout_outbox o join user_identities i on i.id=o.identity_id
       where i.idp_issuer=$1 and i.sp_entity_id=$2 and o.available_at<=clock_timestamp()
       and (o.claimed_until is null or o.claimed_until<=clock_timestamp())
       order by o.available_at,o.identity_id for update of o skip locked limit 1`,
        [binding.issuer, binding.entityId],
      )
    ).rows[0];
    if (!row) return null;
    const id = randomUUID();
    await client.query(
      `update identity_security_logout_outbox set claim_id=$2,
      claimed_until=clock_timestamp()+interval '2 minutes',attempt_count=attempt_count+1 where identity_id=$1`,
      [row.identity_id, id],
    );
    return {
      id,
      identityId: row.identity_id,
      userId: row.user_id,
      keycloakUserId: row.keycloak_user_id,
      epoch: row.security_epoch,
      desiredEnabled: row.desired_enabled,
    };
  });
}
async function lockIdentitySecurityLogout(client: DatabaseClient, claim: IdentityLogoutClaim) {
  await client.query("select pg_advisory_xact_lock(hashtext('gcr:user-administration'))");
  await client.query('select id from users where id=$1 for update', [claim.userId]);
  const current = await client.query(
    `select o.identity_id from identity_security_logout_outbox o
    join user_identities i on i.id=o.identity_id where o.identity_id=$1 and o.claim_id=$2
    and o.security_epoch=$3 and o.claimed_until>clock_timestamp()
    and o.desired_enabled is not distinct from $4::boolean and i.user_id=$5
    and i.keycloak_user_id=$6 and i.security_epoch=o.security_epoch
    and i.idp_disabled_by_gcr=($4::boolean is false) for update of o,i`,
    [
      claim.identityId,
      claim.id,
      claim.epoch,
      claim.desiredEnabled,
      claim.userId,
      claim.keycloakUserId,
    ],
  );
  if (!current.rowCount) return fail('IDENTITY_SECURITY_LEASE_LOST');
}
export async function inspectIdentitySecurityLogout(
  database: Database,
  claim: IdentityLogoutClaim,
) {
  return atomic(database, (client) => lockIdentitySecurityLogout(client, claim));
}
export async function completeIdentitySecurityLogout(
  database: Database,
  claim: IdentityLogoutClaim,
) {
  return atomic(database, async (client) => {
    await lockIdentitySecurityLogout(client, claim);
    const result = await client.query(
      `update user_identities set security_reconciled_epoch=security_epoch,
      security_login_after=clock_timestamp(),updated_at=clock_timestamp() where id=$1 and user_id=$2
      and keycloak_user_id=$3 and security_epoch=$4 returning id`,
      [claim.identityId, claim.userId, claim.keycloakUserId, claim.epoch],
    );
    if (!result.rowCount) return fail('IDENTITY_SECURITY_LEASE_LOST');
    await client.query('delete from identity_security_logout_outbox where identity_id=$1', [
      claim.identityId,
    ]);
  });
}
export async function failIdentitySecurityLogout(database: Database, claim: IdentityLogoutClaim) {
  const result = await database
    .query(
      `update identity_security_logout_outbox set claim_id=null,claimed_until=null,
    available_at=clock_timestamp()+interval '30 seconds',last_error_code='IDENTITY_ADMIN_UNAVAILABLE'
    where identity_id=$1 and claim_id=$2 and security_epoch=$3 and claimed_until>clock_timestamp() returning identity_id`,
      [claim.identityId, claim.id, claim.epoch],
    )
    .catch(() => fail('IDENTITY_SECURITY_STORAGE_UNAVAILABLE'));
  if (!result.rowCount) return fail('IDENTITY_SECURITY_LEASE_LOST');
}

export interface SecurityProfileTarget {
  readonly identityId: string;
  readonly userId: string;
  readonly keycloakUserId: string;
  readonly epoch: string;
  readonly sourceKey: string;
  readonly sourceAnchor: string;
}
export async function rejectIdentitySecurityProfile(
  database: Database,
  binding: SamlProviderBinding,
  target: SecurityProfileTarget,
) {
  return atomic(database, async (client) => {
    if (target.sourceKey !== samlConfigurationKey(binding))
      return fail('IDENTITY_SECURITY_OBSERVATION_INVALID');
    await client.query("select pg_advisory_xact_lock(hashtext('gcr:user-administration'))");
    await client.query('select id from users where id=$1 for update', [target.userId]);
    const current = await client.query(
      `select id from user_identities where id=$1 and user_id=$2
      and idp_issuer=$3 and sp_entity_id=$4 and keycloak_user_id=$5 and security_epoch=$6 and enabled for update`,
      [
        target.identityId,
        target.userId,
        binding.issuer,
        binding.entityId,
        target.keycloakUserId,
        target.epoch,
      ],
    );
    if (!current.rowCount) return false;
    await revokeUserIdentitySecurity(client, target.userId);
    await client.query('update user_identities set enabled=false where id=$1', [target.identityId]);
    return true;
  });
}

export async function pruneIdentitySecurityState(database: Database) {
  return atomic(database, async (client) => {
    const receipts = await client.query(`delete from identity_security_event_receipts where
      (configuration_key,stream,event_id_hash) in (select configuration_key,stream,event_id_hash
      from identity_security_event_receipts where applied_at<clock_timestamp()-interval '24 hours'
      order by applied_at limit 500 for update skip locked)`);
    const sessions = await client.query(`delete from identity_idp_session_revocations where
      (identity_id,keycloak_session_hash) in (select identity_id,keycloak_session_hash
      from identity_idp_session_revocations where expires_at<=clock_timestamp()
      order by expires_at limit 500 for update skip locked)`);
    return { receipts: receipts.rowCount ?? 0, sessions: sessions.rowCount ?? 0 };
  });
}
export async function listSecurityProfileTargets(
  database: Database,
  binding: SamlProviderBinding,
): Promise<SecurityProfileTarget[]> {
  const key = samlConfigurationKey(binding);
  const rows = await database
    .query<SecurityProfileTarget>(
      `select i.id as "identityId",i.user_id as "userId",
    i.keycloak_user_id as "keycloakUserId",i.security_epoch as epoch,s.configuration_key as "sourceKey",
    s.security_anchor_id as "sourceAnchor" from identity_security_sources s
    join user_identities i on i.idp_issuer=s.idp_issuer and i.sp_entity_id=s.sp_entity_id
    join users u on u.id=i.user_id where s.configuration_key=$1 and s.state='healthy'
    and s.checked_at<=clock_timestamp() and s.checked_at>clock_timestamp()-interval '5 minutes'
    and u.enabled and u.deleted_at is null and i.enabled and i.provisioning_state='provisioned'
    and i.security_reconciled_epoch=i.security_epoch
    and (i.security_checked_at is null or i.security_checked_at<s.checked_at)
    order by i.security_checked_at nulls first,i.id limit 25`,
      [key],
    )
    .catch(() => fail('IDENTITY_SECURITY_STORAGE_UNAVAILABLE'));
  return rows.rows;
}

// Call only with a fresh, validated Admin API profile. The source checkpoint is
// the upper bound on freshness; repeated successful GETs cannot advance it.
export async function confirmIdentitySecurityProfile(
  database: Database,
  binding: SamlProviderBinding,
  target: SecurityProfileTarget,
  proof: SamlIdentity & { readonly keycloakUserId: string; readonly enabled: boolean },
) {
  return atomic(database, async (client) => {
    if (target.sourceKey !== samlConfigurationKey(binding))
      return fail('IDENTITY_SECURITY_OBSERVATION_INVALID');
    await client.query("select pg_advisory_xact_lock(hashtext('gcr:user-administration'))");
    await client.query('select id from users where id=$1 for update', [target.userId]);
    const current = (
      await client.query<{
        id: string;
        name_id: string;
        name_id_format: string;
        name_qualifier: string | null;
        sp_name_qualifier: string | null;
        keycloak_user_id: string;
      }>(
        `select i.* from user_identities i join users u on u.id=i.user_id
      where i.id=$1 and i.user_id=$2 and i.idp_issuer=$3 and i.sp_entity_id=$4
      and i.enabled and i.provisioning_state='provisioned' and u.enabled and u.deleted_at is null
      and i.security_epoch=$5 and i.security_reconciled_epoch=i.security_epoch for update of i`,
        [target.identityId, target.userId, binding.issuer, binding.entityId, target.epoch],
      )
    ).rows[0];
    if (!current) return false;
    if (
      !proof.enabled ||
      proof.keycloakUserId !== target.keycloakUserId ||
      proof.keycloakUserId !== current.keycloak_user_id ||
      proof.issuer !== binding.issuer ||
      proof.entityId !== binding.entityId ||
      proof.nameID !== current.name_id ||
      proof.nameIDFormat !== current.name_id_format ||
      (proof.nameQualifier ?? null) !== current.name_qualifier ||
      (proof.spNameQualifier ?? null) !== current.sp_name_qualifier
    ) {
      await revokeUserIdentitySecurity(client, target.userId);
      // Reactivation requires a separate confirmed administrator operation.
      await client.query('update user_identities set enabled=false where id=$1', [
        target.identityId,
      ]);
      return false;
    }
    const result = await client.query(
      `update user_identities i set security_checked_at=s.checked_at,
      security_fresh_until=s.checked_at+interval '5 minutes',updated_at=clock_timestamp()
      from identity_security_sources s where i.id=$1 and s.configuration_key=$2
      and s.security_anchor_id=$3 and s.state='healthy' and s.checked_at<=clock_timestamp()
      and s.checked_at>clock_timestamp()-interval '5 minutes' returning i.id`,
      [target.identityId, target.sourceKey, target.sourceAnchor],
    );
    return result.rowCount === 1;
  });
}
