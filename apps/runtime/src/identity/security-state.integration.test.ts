import { createHash, randomUUID } from 'node:crypto';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  beginSamlLogin,
  consumeSamlLogin,
  linkExistingSamlIdentity,
  persistentNameId,
  type SamlIdentity,
  type SamlProviderBinding,
} from '../auth/saml-state.js';
import type { IdentitySecurityEvent, SecurityObservation } from './keycloak-security.js';
import { revokeUserIdentitySecurity } from './revocation.js';
import {
  KeycloakAdminClient,
  KeycloakAdminError,
  keycloakNameIdAttribute,
} from './keycloak-admin.js';
import { reconcileIdentitySecurity } from './security-processor.js';
import {
  applySecurityObservation,
  claimIdentitySecurityLogout,
  claimSecurityObservation,
  completeIdentitySecurityLogout,
  failIdentitySecurityLogout,
  failSecurityObservation,
  listSecurityProfileTargets,
  confirmIdentitySecurityProfile,
  rejectIdentitySecurityProfile,
  pruneIdentitySecurityState,
} from './security-state.js';

const binding: SamlProviderBinding = {
  issuer: 'https://identity.test/realms/gcr',
  entityId: 'https://gcr.test/auth/saml/metadata',
  acsUrl: 'https://gcr.test/auth/saml/acs',
  sloUrl: 'https://gcr.test/auth/saml/slo',
};
const databaseUrl = process.env.GCR_TEST_DATABASE_URL;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
describe.skipIf(!databaseUrl).sequential('Identity security PostgreSQL reconciliation', () => {
  const schema = `identity_security_${randomUUID().replaceAll('-', '')}`;
  let root: Database, database: Database, replica: Database;
  let actorId: string,
    userId: string,
    identityId: string,
    keycloakUserId: string,
    identity: SamlIdentity;
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw Error('Isolated local PostgreSQL only');
    root = createDatabase(url.href);
    await root.query(`create schema ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    database = createDatabase(url.href);
    replica = createDatabase(url.href);
    await runMigrations(database);
  }, 30_000);
  afterAll(async () => {
    await replica?.end();
    await database?.end();
    if (root) {
      await root.query(`drop schema ${schema} cascade`);
      await root.end();
    }
  });
  beforeEach(async () => {
    await database.query('truncate users,identity_security_sources cascade');
    actorId = (
      await database.query(`insert into users(oidc_subject,display_name,role)
      values('security-administrator','Admin','administrator') returning id`)
    ).rows[0].id;
    userId = (
      await database.query(`insert into users(oidc_subject,display_name,role,personal_prompt)
      values('preserved-subject','Preserved User','reviewer','Preserved prompt') returning id`)
    ).rows[0].id;
    await database.query(
      `insert into local_credentials(user_id,username,password_hash)
      values($1,'preserved-user','synthetic-preserved-hash')`,
      [userId],
    );
    keycloakUserId = randomUUID();
    identity = {
      issuer: binding.issuer,
      entityId: binding.entityId,
      nameID: `G-${randomUUID()}`,
      nameIDFormat: persistentNameId,
      nameQualifier: null,
      spNameQualifier: null,
    };
    identityId = await linkExistingSamlIdentity(database, binding, {
      actorId,
      userId,
      expectedSubject: 'preserved-subject',
      keycloakUserId,
      identity,
    });
    await database.query(
      `update user_identities set enabled=true,provisioning_state='provisioned',
      identity_verified_at=clock_timestamp(),security_checked_at=statement_timestamp(),
      security_fresh_until=statement_timestamp()+interval '5 minutes' where id=$1`,
      [identityId],
    );
    await localSession();
  });
  async function localSession() {
    await database.query(
      `insert into user_sessions(id_hash,user_id,expires_at)
      values($1,$2,clock_timestamp()+interval '1 hour')`,
      [hash(randomUUID()), userId],
    );
  }
  async function ready() {
    await database.query('update identity_security_sources set available_at=clock_timestamp()');
    return (await claimSecurityObservation(database, binding))!;
  }
  async function observe(
    events: IdentitySecurityEvent[] = [],
    continuity?: SecurityObservation['continuity'],
  ) {
    const lease = await ready();
    const now = Date.now();
    const observation: SecurityObservation = {
      continuity: continuity ?? (lease.previous ? 'continuous' : 'baseline'),
      checkpoint: {
        realmId: 'fixture-realm',
        configurationHash: hash('fixture-configuration'),
        observedAt: now,
        security: { id: randomUUID(), time: now },
        administration: { id: randomUUID(), time: now },
      },
      events,
    };
    const result = await applySecurityObservation(database, binding, lease, observation);
    return { lease, observation, result };
  }
  const row = async () =>
    (await database.query('select * from user_identities where id=$1', [identityId])).rows[0];
  const epoch = async () =>
    (
      await database.query('select epoch from user_client_credential_epochs where user_id=$1', [
        userId,
      ])
    ).rows[0]?.epoch;
  const event = (
    kind: IdentitySecurityEvent['kind'] = 'revoke-identity',
  ): IdentitySecurityEvent => ({
    id: randomUUID(),
    time: Date.now(),
    stream: 'security',
    kind,
    userId: keycloakUserId,
  });
  async function fixtureFreshness() {
    // Only a test fixture. Production profile verification is tested separately.
    await database.query(
      `update user_identities set security_checked_at=statement_timestamp(),
      security_fresh_until=statement_timestamp()+interval '5 minutes' where id=$1`,
      [identityId],
    );
  }
  async function pending(session = `${randomUUID()}::${randomUUID()}`) {
    const browser = await beginSamlLogin(database, binding);
    return {
      browser,
      verified: {
        ...identity,
        requestId: browser.requestId,
        responseId: `_${randomUUID()}`,
        assertionId: `_${randomUUID()}`,
        sessionIndex: session,
        sessionExpiresAt: Date.now() + 3600_000,
      },
    };
  }
  it('claims one source across replicas and fences a replaced lease', async () => {
    const results = await Promise.all([
      claimSecurityObservation(database, binding),
      claimSecurityObservation(replica, binding),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const old = results.find(Boolean)!;
    await database.query(`update identity_security_sources set lease_started_at=clock_timestamp()-interval '3 minutes',
      lease_until=clock_timestamp()-interval '1 minute'`);
    const next = await claimSecurityObservation(replica, binding);
    expect(next?.id).not.toBe(old.id);
    await expect(
      failSecurityObservation(database, binding, old, 'IDENTITY_ADMIN_UNAVAILABLE', false),
    ).rejects.toMatchObject({ code: 'IDENTITY_SECURITY_LEASE_LOST' });
  });
  it('commits baseline revocation, client epoch and remote work without changing account ownership or credentials', async () => {
    const beforeUser = (await database.query('select * from users where id=$1', [userId])).rows;
    const credentials = (await database.query('select * from local_credentials')).rows;
    await observe();
    expect((await database.query('select * from user_sessions')).rows).toEqual([]);
    expect(await row()).toMatchObject({
      security_epoch: '2',
      security_reconciled_epoch: '0',
      security_fresh_until: null,
    });
    expect(await epoch()).toBe('1');
    expect(
      (await database.query('select * from identity_security_logout_outbox')).rows,
    ).toHaveLength(1);
    expect((await database.query('select * from users where id=$1', [userId])).rows).toEqual(
      beforeUser,
    );
    expect((await database.query('select * from local_credentials')).rows).toEqual(credentials);
  });
  it('deduplicates overlap events and revokes once per user in a batch', async () => {
    await observe();
    const events = [event(), event()];
    await localSession();
    await observe(events);
    expect(await epoch()).toBe('2');
    expect((await row()).security_epoch).toBe('3');
    await localSession();
    await observe(events);
    expect(await epoch()).toBe('2');
    expect((await database.query('select * from user_sessions')).rowCount).toBe(1);
    expect((await database.query('select * from identity_security_event_receipts')).rowCount).toBe(
      2,
    );
  });
  it('leaves local revocation in force after remote failure and rejects a stale remote completion', async () => {
    await observe();
    const claim = (await claimIdentitySecurityLogout(database, binding))!;
    expect(await claimIdentitySecurityLogout(replica, binding)).toBeNull();
    await failIdentitySecurityLogout(database, claim);
    expect((await row()).security_fresh_until).toBeNull();
    expect((await database.query('select * from user_sessions')).rowCount).toBe(0);
    await observe([event()]);
    await expect(completeIdentitySecurityLogout(database, claim)).rejects.toMatchObject({
      code: 'IDENTITY_SECURITY_LEASE_LOST',
    });
    const next = (await claimIdentitySecurityLogout(replica, binding))!;
    await completeIdentitySecurityLogout(replica, next);
    expect(await row()).toMatchObject({
      security_reconciled_epoch: '3',
      security_fresh_until: null,
    });
    expect((await database.query('select * from identity_security_logout_outbox')).rowCount).toBe(
      0,
    );
  });
  it('distinguishes a network outage from confirmed loss and avoids repeated gap epoch increments', async () => {
    await observe();
    await fixtureFreshness();
    const fresh = (await row()).security_fresh_until;
    let lease = await ready();
    await failSecurityObservation(database, binding, lease, 'IDENTITY_ADMIN_UNAVAILABLE', false);
    expect((await row()).security_fresh_until).toEqual(fresh);
    expect(await epoch()).toBe('1');
    lease = await ready();
    await failSecurityObservation(
      database,
      binding,
      lease,
      'IDENTITY_EVENT_BATCH_INCOMPLETE',
      true,
    );
    expect((await row()).security_fresh_until).toBeNull();
    expect(await epoch()).toBe('2');
    lease = await ready();
    await failSecurityObservation(
      database,
      binding,
      lease,
      'IDENTITY_EVENT_BATCH_INCOMPLETE',
      true,
    );
    expect(await epoch()).toBe('2');
    await observe([], 'gap');
    expect(await epoch()).toBe('2');
  });
  it('scopes ordinary logout to one IdP session and blocks its delayed ACS without revoking client credentials', async () => {
    await observe();
    await completeIdentitySecurityLogout(
      database,
      (await claimIdentitySecurityLogout(database, binding))!,
    );
    await fixtureFreshness();
    const ended = 'fixtureSession_24-chars01',
      kept = 'fixtureSession_24-chars02';
    const first = await pending(`${ended}::${randomUUID()}`),
      second = await pending(`${kept}::${randomUUID()}`);
    await consumeSamlLogin(database, binding, first.browser, first.verified);
    await consumeSamlLogin(database, binding, second.browser, second.verified);
    const delayed = await pending(`${ended}::${randomUUID()}`);
    await observe([{ ...event('logout-session'), sessionId: ended }]);
    expect(await epoch()).toBe('1');
    expect((await row()).security_epoch).toBe('2');
    expect((await database.query('select saml_session_index from user_sessions')).rows).toEqual([
      { saml_session_index: second.verified.sessionIndex },
    ]);
    await expect(
      consumeSamlLogin(database, binding, delayed.browser, delayed.verified),
    ).rejects.toMatchObject({ code: 'SAML_TRANSACTION_INVALID' });
  });
  it('rejects requests begun before revocation and before the remote logout acknowledgment', async () => {
    await observe();
    const beforeAck = await pending();
    await completeIdentitySecurityLogout(
      database,
      (await claimIdentitySecurityLogout(database, binding))!,
    );
    await fixtureFreshness();
    await expect(
      consumeSamlLogin(database, binding, beforeAck.browser, beforeAck.verified),
    ).rejects.toMatchObject({ code: 'SAML_TRANSACTION_INVALID' });
    const after = await pending();
    await consumeSamlLogin(database, binding, after.browser, after.verified);
    const beforeRevoke = await pending();
    const client = await database.connect();
    try {
      await client.query('begin');
      await client.query("select pg_advisory_xact_lock(hashtext('gcr:user-administration'))");
      await revokeUserIdentitySecurity(client, userId);
      await client.query('commit');
    } finally {
      client.release();
    }
    await fixtureFreshness();
    await expect(
      consumeSamlLogin(database, binding, beforeRevoke.browser, beforeRevoke.verified),
    ).rejects.toMatchObject({ code: 'SAML_TRANSACTION_INVALID' });
  });
  it('accepts a confirmed IdP admin logout without generating another remote logout', async () => {
    await observe();
    await completeIdentitySecurityLogout(
      database,
      (await claimIdentitySecurityLogout(database, binding))!,
    );
    await observe([{ ...event(), stream: 'administration', remoteLogoutConfirmed: true }]);
    expect((await row()).security_reconciled_epoch).toBe((await row()).security_epoch);
    expect((await database.query('select * from identity_security_logout_outbox')).rowCount).toBe(
      0,
    );
  });
  it('grants freshness only after remote acknowledgment and never extends the event observation with repeated profiles', async () => {
    const observation = await observe();
    expect(await listSecurityProfileTargets(database, binding)).toEqual([]);
    await completeIdentitySecurityLogout(
      database,
      (await claimIdentitySecurityLogout(database, binding))!,
    );
    const target = (await listSecurityProfileTargets(database, binding))[0]!;
    const proof = { ...identity, keycloakUserId, enabled: true };
    expect(await confirmIdentitySecurityProfile(database, binding, target, proof)).toBe(true);
    expect((await row()).security_checked_at).toEqual(observation.result.checkedAt);
    const freshUntil = (await row()).security_fresh_until;
    expect(freshUntil.getTime() - observation.result.checkedAt.getTime()).toBe(300_000);
    expect(await confirmIdentitySecurityProfile(database, binding, target, proof)).toBe(true);
    expect((await row()).security_fresh_until).toEqual(freshUntil);
    await observe();
    expect(await confirmIdentitySecurityProfile(database, binding, target, proof)).toBe(false);
    const latest = (await listSecurityProfileTargets(database, binding))[0]!;
    expect(await confirmIdentitySecurityProfile(database, binding, latest, proof)).toBe(true);
    const lease = await ready();
    await failSecurityObservation(database, binding, lease, 'IDENTITY_ADMIN_UNAVAILABLE', false);
    const duringOutage = (await row()).security_fresh_until;
    expect(await confirmIdentitySecurityProfile(database, binding, latest, proof)).toBe(true);
    expect((await row()).security_fresh_until).toEqual(duringOutage);
  });
  it.each([{ enabled: false }, { nameID: 'different-subject' }])(
    'quarantines a disabled or changed identity %j without repeated revocation',
    async (change) => {
      await observe();
      await completeIdentitySecurityLogout(
        database,
        (await claimIdentitySecurityLogout(database, binding))!,
      );
      const target = (await listSecurityProfileTargets(database, binding))[0]!;
      const proof = { ...identity, keycloakUserId, enabled: true, ...change };
      expect(await confirmIdentitySecurityProfile(database, binding, target, proof)).toBe(false);
      expect(await row()).toMatchObject({
        enabled: false,
        security_fresh_until: null,
        security_epoch: '3',
      });
      expect(await epoch()).toBe('2');
      expect(await confirmIdentitySecurityProfile(database, binding, target, proof)).toBe(false);
      expect(await epoch()).toBe('2');
    },
  );
  it('a profile response started before a later revocation cannot restore freshness', async () => {
    await observe();
    await completeIdentitySecurityLogout(
      database,
      (await claimIdentitySecurityLogout(database, binding))!,
    );
    const target = (await listSecurityProfileTargets(database, binding))[0]!;
    await observe([event()]);
    expect(
      await confirmIdentitySecurityProfile(database, binding, target, {
        ...identity,
        keycloakUserId,
        enabled: true,
      }),
    ).toBe(false);
    expect((await row()).security_fresh_until).toBeNull();
  });
  it('runs the production collector with local revocation before network calls and independent profile confirmation', async () => {
    const reader = new KeycloakAdminClient({
      issuer: binding.issuer,
      entityId: binding.entityId,
      clientId: 'fixture-client',
      clientSecretFile: '/not-read-in-this-fixture',
    });
    let failLogout = true;
    const adapter = {
      endpoints: reader.endpoints,
      capture: async (): Promise<SecurityObservation> => ({
        continuity: 'baseline',
        events: [],
        checkpoint: {
          realmId: 'fixture-realm',
          configurationHash: hash('fixture-config'),
          observedAt: Date.now(),
          security: { id: randomUUID(), time: Date.now() },
          administration: { id: randomUUID(), time: Date.now() },
        },
      }),
      logoutAll: async () => {
        expect((await replica.query('select * from user_sessions')).rowCount).toBe(0);
        // Other isolated schemas share PostgreSQL advisory lock keys. Check this
        // fixture's unique user row instead, so unrelated suites cannot mask the
        // assertion that this processor released its transaction before I/O.
        expect(
          (await replica.query('select id from users where id=$1 for update nowait', [userId]))
            .rows,
        ).toEqual([{ id: userId }]);
        if (failLogout) throw new KeycloakAdminError('IDENTITY_ADMIN_UNAVAILABLE', true);
      },
      getUser: async () => ({
        id: keycloakUserId,
        username: 'fixture-user',
        enabled: true,
        attributes: { [keycloakNameIdAttribute(binding.entityId)]: [identity.nameID] },
        requiredActions: [],
      }),
      setEnabled: async () => {
        throw Error('Ordinary security logout must not change enabled state');
      },
      identity: reader.identity.bind(reader),
    };
    expect(await reconcileIdentitySecurity(database, binding, adapter)).toEqual({
      observed: true,
      loggedOut: false,
      profilesConfirmed: 0,
    });
    expect((await row()).security_fresh_until).toBeNull();
    failLogout = false;
    await database.query(
      'update identity_security_logout_outbox set available_at=clock_timestamp()',
    );
    expect(await reconcileIdentitySecurity(replica, binding, adapter)).toEqual({
      observed: false,
      loggedOut: true,
      profilesConfirmed: 1,
    });
    expect((await row()).security_fresh_until).toBeInstanceOf(Date);
    expect(await listSecurityProfileTargets(database, binding)).toEqual([]);
  });
  it('preserves an explicit GCR block across failed remote work and later IdP reactivation', async () => {
    await observe();
    await completeIdentitySecurityLogout(
      database,
      (await claimIdentitySecurityLogout(database, binding))!,
    );
    const client = await database.connect();
    try {
      await client.query('begin');
      await client.query("select pg_advisory_xact_lock(hashtext('gcr:user-administration'))");
      await revokeUserIdentitySecurity(client, userId, { disableAtIdentityProvider: true });
      await client.query('update users set enabled=false where id=$1', [userId]);
      await client.query('update user_identities set enabled=false where id=$1', [identityId]);
      await client.query('commit');
    } finally {
      client.release();
    }
    const failed = (await claimIdentitySecurityLogout(database, binding))!;
    expect(failed.desiredEnabled).toBe(false);
    await failIdentitySecurityLogout(database, failed);
    await observe([{ ...event(), stream: 'administration', remoteLogoutConfirmed: true }]);
    expect(
      (await database.query('select desired_enabled from identity_security_logout_outbox')).rows,
    ).toEqual([{ desired_enabled: false }]);
    const reader = new KeycloakAdminClient({
      issuer: binding.issuer,
      entityId: binding.entityId,
      clientId: 'fixture',
      clientSecretFile: '/not-read-in-this-fixture',
    });
    let remoteEnabled = true;
    const getUser = async () => ({
      id: keycloakUserId,
      username: 'fixture-user',
      enabled: remoteEnabled,
      attributes: { [keycloakNameIdAttribute(binding.entityId)]: [identity.nameID] },
      requiredActions: [],
    });
    const adapter = {
      endpoints: reader.endpoints,
      identity: reader.identity.bind(reader),
      getUser,
      setEnabled: async (_id: string, enabled: boolean) => {
        remoteEnabled = enabled;
        return getUser();
      },
      logoutAll: async () => {
        expect(remoteEnabled).toBe(false);
      },
      capture: async (): Promise<SecurityObservation> => ({
        continuity: 'continuous',
        events: [],
        checkpoint: {
          realmId: 'fixture-realm',
          configurationHash: hash('fixture-configuration'),
          observedAt: Date.now(),
          security: { id: randomUUID(), time: Date.now() },
          administration: { id: randomUUID(), time: Date.now() },
        },
      }),
    };
    expect((await reconcileIdentitySecurity(database, binding, adapter)).loggedOut).toBe(true);
    expect(remoteEnabled).toBe(false);
    expect((await row()).idp_disabled_by_gcr).toBe(true);
    remoteEnabled = true;
    await observe([{ ...event(), stream: 'administration' }]);
    expect((await reconcileIdentitySecurity(database, binding, adapter)).loggedOut).toBe(true);
    expect(remoteEnabled).toBe(false);
    expect((await row()).enabled).toBe(false);
    expect((await row()).security_fresh_until).toBeNull();
    await observe([{ ...event(), stream: 'administration', remoteLogoutConfirmed: true }]);
    expect((await database.query('select * from identity_security_logout_outbox')).rowCount).toBe(
      0,
    );
  });
  it('quarantines a confirmed missing profile once and retains live receipt and session barriers', async () => {
    await observe();
    await completeIdentitySecurityLogout(
      database,
      (await claimIdentitySecurityLogout(database, binding))!,
    );
    const target = (await listSecurityProfileTargets(database, binding))[0]!;
    expect(await rejectIdentitySecurityProfile(database, binding, target)).toBe(true);
    expect(await rejectIdentitySecurityProfile(database, binding, target)).toBe(false);
    expect(await epoch()).toBe('2');
    await observe([{ ...event('logout-session'), sessionId: 'fixtureSession_24-chars01' }]);
    expect(await pruneIdentitySecurityState(database)).toEqual({ receipts: 0, sessions: 0 });
    await database.query(
      "update identity_security_event_receipts set applied_at=clock_timestamp()-interval '25 hours'",
    );
    await database.query(`update identity_idp_session_revocations set revoked_at=statement_timestamp()-interval '11 minutes',
      expires_at=statement_timestamp()-interval '1 minute'`);
    expect(await pruneIdentitySecurityState(database)).toEqual({ receipts: 1, sessions: 1 });
  });
  it('rolls back local revocation and source progress if durable remote work cannot be inserted', async () => {
    await database.query(`create function fail_security_outbox() returns trigger language plpgsql as $$
      begin raise exception 'synthetic private database detail'; end $$`);
    await database.query(`create trigger fail_security_outbox before insert on identity_security_logout_outbox
      for each row execute function fail_security_outbox()`);
    try {
      await expect(observe()).rejects.toMatchObject({
        code: 'IDENTITY_SECURITY_STORAGE_UNAVAILABLE',
      });
      expect((await row()).security_epoch).toBe('1');
      expect(await epoch()).toBeUndefined();
      expect((await database.query('select * from user_sessions')).rowCount).toBe(1);
      expect(
        (await database.query('select observed_at from identity_security_sources')).rows[0]
          .observed_at,
      ).toBeNull();
    } finally {
      await database.query('drop trigger fail_security_outbox on identity_security_logout_outbox');
      await database.query('drop function fail_security_outbox()');
    }
  });
});
