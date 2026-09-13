import { randomUUID } from 'node:crypto';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { loadConfig } from '../config.js';
import { AuthorizationService } from '../services/authorization.js';
import { registerIdentityAdministrationRoutes } from './routes.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  linkExistingSamlIdentity,
  persistentNameId,
  type SamlProviderBinding,
} from '../auth/saml-state.js';
import {
  beginIdentityMailDispatch,
  claimIdentityOperation,
  failIdentityOperation,
  requestIdentityProvisioning,
  retryIdentityOperation,
  supersedeIdentityOperations,
  type IdentityProvisioningRequest,
} from './operations.js';
import { processIdentityOperation, type IdentityAdministration } from './processor.js';
import {
  KeycloakAdminClient,
  KeycloakAdminError,
  keycloakNameIdAttribute,
  type KeycloakCreatePlan,
  type KeycloakUser,
} from './keycloak-admin.js';

const binding: SamlProviderBinding = {
  issuer: 'https://idp.test/realms/gcr',
  entityId: 'https://gcr.test/auth/saml/metadata',
  acsUrl: 'https://gcr.test/auth/saml/acs',
  sloUrl: 'https://gcr.test/auth/saml/slo',
};
const databaseUrl = process.env.GCR_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl).sequential('Identity provisioning PostgreSQL operations', () => {
  const schema = `identity_operations_${randomUUID().replaceAll('-', '')}`;
  let root: Database, database: Database, replica: Database;
  let adminId: string, tenantId: string;
  const create = (): IdentityProvisioningRequest => ({
    kind: 'create',
    requestId: randomUUID(),
    username: 'fixture-user',
    email: 'fixture@example.test',
    displayName: 'Fixture',
    target: { kind: 'new', role: 'reviewer', tenantIds: [tenantId] },
  });
  const request = (input = create()) =>
    requestIdentityProvisioning(database, binding, adminId, input);
  const adapterFixture = () => {
    const users = new Map<string, KeycloakUser>();
    const identityReader = new KeycloakAdminClient({
      issuer: binding.issuer,
      entityId: binding.entityId,
      clientId: 'fixture',
      clientSecretFile: '/not-read-by-pure-identity-method',
    });
    const read = (id: string) => {
      const user = users.get(id);
      if (!user) throw new KeycloakAdminError('IDENTITY_ACCOUNT_NOT_FOUND');
      return structuredClone(user);
    };
    const adapter = {
      endpoints: identityReader.endpoints,
      identity: (user: KeycloakUser) => identityReader.identity(user),
      ensureCreated: vi.fn(async (plan: KeycloakCreatePlan) => {
        const existing = [...users.values()].find((user) => user.username === plan.username);
        if (existing) return structuredClone(existing);
        const user: KeycloakUser = {
          id: randomUUID(),
          username: plan.username,
          email: plan.email,
          firstName: plan.displayName,
          enabled: false,
          requiredActions: ['VERIFY_EMAIL', 'UPDATE_PASSWORD'],
          attributes: { [keycloakNameIdAttribute(binding.entityId)]: [`G-${plan.operationId}`] },
        };
        users.set(user.id, user);
        return structuredClone(user);
      }),
      getUser: vi.fn(async (id: string) => read(id)),
      logoutAll: vi.fn<(id: string) => Promise<void>>(async () => {}),
      setEnabled: vi.fn(async (id: string, enabled: boolean) => {
        const user = read(id);
        user.enabled = enabled;
        users.set(id, user);
        return structuredClone(user);
      }),
      sendActionsEmail: vi.fn<
        (id: string, email: string, kind: 'invite' | 'password-reset') => Promise<void>
      >(async () => {}),
    } satisfies IdentityAdministration;
    return { adapter, users };
  };
  const retryAvailable = async (id: string) => {
    await database.query(
      'update identity_admin_outbox set available_at=clock_timestamp() where operation_id=$1',
      [id],
    );
  };
  const snapshot = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          'users',
          'local_credentials',
          'tenant_memberships',
          'user_identities',
          'identity_admin_operations',
          'identity_admin_outbox',
          'audit_events',
        ].map(async (table) => [
          table,
          (await database.query(`select * from ${table} order by 1`)).rows,
        ]),
      ),
    );
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      throw Error('Isolated local PostgreSQL only');
    root = createDatabase(url.href);
    await root.query(`create schema ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    database = createDatabase(url.href);
    replica = createDatabase(url.href);
    await runMigrations(database);
    tenantId = (await database.query("select id from tenants where slug='default'")).rows[0].id;
  });
  beforeEach(async () => {
    await database.query('delete from identity_admin_operations');
    await database.query('delete from user_identities');
    await database.query('delete from tenant_memberships');
    await database.query('delete from users');
    await database.query('delete from audit_events');
    adminId = (
      await database.query(`insert into users(oidc_subject,display_name,role)
      values('administrator','Administrator','administrator') returning id`)
    ).rows[0].id;
  });
  afterAll(async () => {
    await replica?.end();
    await database?.end();
    if (root) {
      await root.query(`drop schema ${schema} cascade`);
      await root.end();
    }
  });

  it('atomically stores one disabled app user, selected memberships and one outbox operation across replicas', async () => {
    const input = create();
    const results = await Promise.all([
      request(input),
      requestIdentityProvisioning(replica, binding, adminId, input),
    ]);
    expect(results[0]!.id).toBe(results[1]!.id);
    const user = (await database.query('select * from users where id=$1', [results[0]!.user_id]))
      .rows[0];
    expect(user).toMatchObject({ enabled: false, role: 'reviewer', display_name: 'Fixture' });
    expect(user.oidc_subject).toBe(`saml:${user.id}`);
    expect((await database.query('select * from local_credentials')).rows).toEqual([]);
    expect((await database.query('select * from user_identities')).rows).toEqual([]);
    expect(
      (await database.query('select * from tenant_memberships where user_id=$1', [user.id])).rows,
    ).toHaveLength(1);
    expect((await database.query('select * from identity_admin_operations')).rows).toHaveLength(1);
    expect((await database.query('select * from identity_admin_outbox')).rows).toHaveLength(1);
    expect((await database.query('select metadata from audit_events')).rows).toEqual([
      { metadata: {} },
    ]);
  });
  it('canonicalizes duplicate tenant IDs but rejects the same request ID with changed role or email', async () => {
    const input = create();
    if (input.kind !== 'create' || input.target.kind !== 'new') throw Error();
    input.target.tenantIds.push(tenantId);
    const first = await request(input);
    input.target.tenantIds = [tenantId];
    expect((await request(input)).id).toBe(first.id);
    for (const changed of [
      { ...input, email: 'changed@example.test' },
      { ...input, target: { ...input.target, role: 'administrator' as const } },
    ])
      await expect(request(changed)).rejects.toMatchObject({ code: 'IDENTITY_OPERATION_CONFLICT' });
  });
  it('rolls back users, memberships, operations and audit when a selected tenant is unavailable', async () => {
    const before = await snapshot(),
      input = create();
    if (input.kind !== 'create' || input.target.kind !== 'new') throw Error();
    input.target.tenantIds.push(randomUUID());
    await expect(request(input)).rejects.toMatchObject({ code: 'IDENTITY_OPERATION_INVALID' });
    expect(await snapshot()).toEqual(before);
  });
  it('rechecks administrator authority and rejects secret-bearing or malformed input', async () => {
    await expect(
      request({ ...create(), password: 'must-not-be-stored' } as IdentityProvisioningRequest),
    ).rejects.toMatchObject({ code: 'IDENTITY_OPERATION_INVALID' });
    await database.query("update users set role='reviewer' where id=$1", [adminId]);
    const before = await snapshot();
    await expect(request()).rejects.toMatchObject({ code: 'IDENTITY_OPERATION_FORBIDDEN' });
    expect(await snapshot()).toEqual(before);
  });
  it('preserves an existing local user and credential, requiring the exact original subject', async () => {
    const user = (
      await database.query(`insert into users(oidc_subject,display_name,role,personal_prompt)
      values('local:legacy','Legacy','administrator','Original prompt') returning *`)
    ).rows[0];
    await database.query(
      `insert into local_credentials(user_id,username,password_hash)
      values($1,'legacy','fixture-hash')`,
      [user.id],
    );
    const input = {
      ...create(),
      target: { kind: 'existing' as const, userId: user.id, expectedSubject: user.oidc_subject },
    } as IdentityProvisioningRequest;
    const before = await snapshot();
    await expect(
      request({
        ...input,
        target: { ...input.target, kind: 'existing', userId: user.id, expectedSubject: 'changed' },
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_OPERATION_CONFLICT' });
    expect(await snapshot()).toEqual(before);
    await request(input);
    expect((await database.query('select * from users where id=$1', [user.id])).rows[0]).toEqual(
      user,
    );
    expect(
      (
        await database.query('select password_hash from local_credentials where user_id=$1', [
          user.id,
        ])
      ).rows,
    ).toEqual([{ password_hash: 'fixture-hash' }]);
    await expect(request({ ...input, requestId: randomUUID() })).rejects.toMatchObject({
      code: 'IDENTITY_OPERATION_CONFLICT',
    });
  });
  it('claims one operation across replicas and fences a previous lease after crash recovery', async () => {
    const operation = await request();
    const claims = await Promise.all([
      claimIdentityOperation(database, binding),
      claimIdentityOperation(replica, binding),
    ]);
    const first = claims.find((claim) => claim !== null)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(first.operation.id).toBe(operation.id);
    expect(
      await claimIdentityOperation(database, {
        ...binding,
        issuer: 'https://idp.test/realms/another',
      }),
    ).toBeNull();
    await database.query(
      "update identity_admin_outbox set claimed_until=clock_timestamp()-interval '1 second' where operation_id=$1",
      [operation.id],
    );
    const recovered = (await claimIdentityOperation(replica, binding))!;
    expect(recovered.claimId).not.toBe(first.claimId);
    expect(recovered.attempt).toBe(2);
    await expect(
      failIdentityOperation(database, first, 'IDENTITY_ADMIN_UNAVAILABLE', true),
    ).rejects.toMatchObject({ code: 'IDENTITY_OPERATION_LEASE_LOST' });
    await failIdentityOperation(replica, recovered, 'IDENTITY_ADMIN_UNAVAILABLE', true);
    const row = (
      await database.query('select state,error_code from identity_admin_operations where id=$1', [
        operation.id,
      ])
    ).rows[0];
    expect(row).toEqual({ state: 'pending', error_code: 'IDENTITY_ADMIN_UNAVAILABLE' });
    expect(await claimIdentityOperation(database, binding)).toBeNull();
  });
  it('bounds automatic retries, then permits an explicit administrator retry of the same operation', async () => {
    const operation = await request();
    for (let attempt = 1; attempt <= 5; attempt++) {
      await database.query(
        'update identity_admin_outbox set available_at=clock_timestamp() where operation_id=$1',
        [operation.id],
      );
      const claim = (await claimIdentityOperation(database, binding))!;
      expect(claim.attempt).toBe(attempt);
      await failIdentityOperation(database, claim, 'IDENTITY_ADMIN_UNAVAILABLE', true);
    }
    expect(
      (
        await database.query('select state from identity_admin_operations where id=$1', [
          operation.id,
        ])
      ).rows[0].state,
    ).toBe('failed');
    expect(await claimIdentityOperation(database, binding)).toBeNull();
    await retryIdentityOperation(database, binding, adminId, operation.id);
    const retry = (await claimIdentityOperation(database, binding))!;
    expect(retry.operation.id).toBe(operation.id);
    expect(retry.attempt).toBe(1);
  });
  it('requires a provisioned mapping for invitation and never automatically repeats a committed mail dispatch', async () => {
    const user = (
      await database.query(`insert into users(oidc_subject,display_name,role)
      values('existing-user','Existing','reviewer') returning *`)
    ).rows[0];
    const input: IdentityProvisioningRequest = {
      kind: 'invite',
      requestId: randomUUID(),
      target: { kind: 'existing', userId: user.id, expectedSubject: user.oidc_subject },
      expectedEmail: 'existing@example.test',
    };
    await expect(request(input)).rejects.toMatchObject({ code: 'IDENTITY_OPERATION_CONFLICT' });
    const identityId = await linkExistingSamlIdentity(database, binding, {
      actorId: adminId,
      userId: user.id,
      expectedSubject: user.oidc_subject,
      keycloakUserId: randomUUID(),
      identity: { ...binding, nameIDFormat: persistentNameId, nameID: 'G-fixture' },
    });
    await database.query(
      `update user_identities set provisioning_state='provisioned',enabled=true,
      identity_verified_at=clock_timestamp() where id=$1`,
      [identityId],
    );
    const operation = await request(input);
    const first = (await claimIdentityOperation(database, binding))!;
    await beginIdentityMailDispatch(database, first);
    await database.query(
      "update identity_admin_outbox set claimed_until=clock_timestamp()-interval '1 second' where operation_id=$1",
      [operation.id],
    );
    const reclaimed = (await claimIdentityOperation(replica, binding))!;
    expect(reclaimed.operation.mail_dispatched_at).toBeInstanceOf(Date);
    await expect(beginIdentityMailDispatch(replica, reclaimed)).rejects.toMatchObject({
      code: 'IDENTITY_OPERATION_CONFLICT',
    });
    await failIdentityOperation(replica, reclaimed, 'IDENTITY_ADMIN_UNAVAILABLE', true);
    const failed = (
      await database.query(
        'select state,error_code,retryable from identity_admin_operations where id=$1',
        [operation.id],
      )
    ).rows[0];
    expect(failed).toEqual({
      state: 'failed',
      error_code: 'IDENTITY_EMAIL_UNCONFIRMED',
      retryable: false,
    });
    await expect(
      retryIdentityOperation(database, binding, adminId, operation.id),
    ).rejects.toMatchObject({ code: 'IDENTITY_OPERATION_CONFLICT' });
    const explicitResend = await request({ ...input, requestId: randomUUID() });
    expect(explicitResend.id).not.toBe(operation.id);
  });
  it('does not claim legacy operations lacking an approved provider binding', async () => {
    await database.query(
      `insert into identity_admin_operations(kind,dedupe_key) values('create',$1)`,
      ['f'.repeat(64)],
    );
    await database.query(
      'insert into identity_admin_outbox(operation_id) select id from identity_admin_operations',
    );
    expect(await claimIdentityOperation(database, binding)).toBeNull();
  });
  it('provisions the mapped user atomically without inventing security freshness or sending an unsolicited invite', async () => {
    const operation = await request(),
      { adapter, users } = adapterFixture();
    expect(await processIdentityOperation(database, binding, adapter)).toBe(true);
    expect(await processIdentityOperation(replica, binding, adapter)).toBe(false);
    const completed = (
      await database.query('select * from identity_admin_operations where id=$1', [operation.id])
    ).rows[0];
    expect(completed.state).toBe('succeeded');
    expect(completed.expected_name_id).toBe(`G-${operation.id}`);
    expect(
      (await database.query('select enabled from users where id=$1', [operation.user_id])).rows[0]
        .enabled,
    ).toBe(true);
    const identity = (
      await database.query('select * from user_identities where id=$1', [completed.identity_id])
    ).rows[0];
    expect(identity).toMatchObject({
      enabled: true,
      provisioning_state: 'provisioned',
      security_checked_at: null,
      security_fresh_until: null,
      security_epoch: '1',
    });
    expect(identity.identity_verified_at).toBeInstanceOf(Date);
    expect(users.size).toBe(1);
    expect(adapter.sendActionsEmail).not.toHaveBeenCalled();
  });
  it('keeps the app disabled during a remote call and excludes another worker', async () => {
    const operation = await request(),
      { adapter } = adapterFixture();
    const original = adapter.ensureCreated.getMockImplementation()!;
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    adapter.ensureCreated.mockImplementationOnce(async (plan) => {
      entered();
      await waiting;
      return original(plan);
    });
    const processing = processIdentityOperation(database, binding, adapter);
    await ready;
    try {
      expect(
        (await replica.query('select enabled from users where id=$1', [operation.user_id])).rows[0]
          .enabled,
      ).toBe(false);
      expect(await processIdentityOperation(replica, binding, adapter)).toBe(false);
    } finally {
      release();
      await processing;
    }
    expect(adapter.ensureCreated).toHaveBeenCalledTimes(1);
  });
  it('recovers an account created before a failed readback using the unchanged operation and app user IDs', async () => {
    const operation = await request(),
      { adapter, users } = adapterFixture();
    const original = adapter.ensureCreated.getMockImplementation()!;
    adapter.ensureCreated.mockImplementationOnce(async (plan) => {
      await original(plan);
      throw new KeycloakAdminError('IDENTITY_ADMIN_UNAVAILABLE', true);
    });
    await processIdentityOperation(database, binding, adapter);
    expect(users.size).toBe(1);
    expect(
      (await database.query('select enabled from users where id=$1', [operation.user_id])).rows[0]
        .enabled,
    ).toBe(false);
    await retryAvailable(operation.id);
    await processIdentityOperation(replica, binding, adapter);
    expect(users.size).toBe(1);
    expect(adapter.ensureCreated.mock.calls[0]).toEqual(adapter.ensureCreated.mock.calls[1]);
    expect(
      (
        await database.query('select state from identity_admin_operations where id=$1', [
          operation.id,
        ])
      ).rows[0].state,
    ).toBe('succeeded');
  });
  it('reuses a pending mapping after an enable readback failure', async () => {
    const operation = await request(),
      { adapter } = adapterFixture();
    adapter.setEnabled.mockRejectedValueOnce(
      new KeycloakAdminError('IDENTITY_ADMIN_UNAVAILABLE', true),
    );
    await processIdentityOperation(database, binding, adapter);
    const pending = (
      await database.query('select * from user_identities where user_id=$1', [operation.user_id])
    ).rows[0];
    expect(pending).toMatchObject({ provisioning_state: 'pending', enabled: false });
    await retryAvailable(operation.id);
    await processIdentityOperation(replica, binding, adapter);
    const rows = (
      await database.query('select * from user_identities where user_id=$1', [operation.user_id])
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: pending.id,
      provisioning_state: 'provisioned',
      enabled: true,
    });
  });
  it('refuses to enable the app when the requesting administrator loses authority during the IdP call', async () => {
    const operation = await request(),
      { adapter } = adapterFixture();
    const original = adapter.setEnabled.getMockImplementation()!;
    adapter.setEnabled.mockImplementationOnce(async (id, enabled) => {
      await database.query("update users set role='reviewer' where id=$1", [adminId]);
      return original(id, enabled);
    });
    await processIdentityOperation(database, binding, adapter);
    expect(
      (await database.query('select enabled from users where id=$1', [operation.user_id])).rows[0]
        .enabled,
    ).toBe(false);
    expect(
      (
        await database.query('select enabled from user_identities where user_id=$1', [
          operation.user_id,
        ])
      ).rows[0].enabled,
    ).toBe(false);
    expect(
      (
        await database.query('select state,error_code from identity_admin_operations where id=$1', [
          operation.id,
        ])
      ).rows[0],
    ).toEqual({ state: 'failed', error_code: 'IDENTITY_OPERATION_FORBIDDEN' });
  });
  it('supersedes an in-flight request so a late IdP enable cannot restore app access', async () => {
    const operation = await request(),
      { adapter } = adapterFixture();
    const original = adapter.setEnabled.getMockImplementation()!;
    adapter.setEnabled.mockImplementationOnce(async (id, enabled) => {
      const connection = await replica.connect();
      try {
        await connection.query('begin');
        await connection.query("select pg_advisory_xact_lock(hashtext('gcr:user-administration'))");
        await supersedeIdentityOperations(connection, operation.user_id!);
        await connection.query('update users set enabled=false where id=$1', [operation.user_id]);
        await connection.query('commit');
      } finally {
        connection.release();
      }
      return original(id, enabled);
    });
    await processIdentityOperation(database, binding, adapter);
    expect(
      (await database.query('select enabled from users where id=$1', [operation.user_id])).rows[0]
        .enabled,
    ).toBe(false);
    expect(
      (
        await database.query('select state,error_code from identity_admin_operations where id=$1', [
          operation.id,
        ])
      ).rows[0],
    ).toEqual({ state: 'failed', error_code: 'IDENTITY_ACCESS_CHANGED' });
    await expect(
      retryIdentityOperation(database, binding, adminId, operation.id),
    ).rejects.toMatchObject({ code: 'IDENTITY_OPERATION_CONFLICT' });
  });
  it('links only the explicitly confirmed existing IdP profile and preserves both sides of a disabled account', async () => {
    const user = (
      await database.query(`insert into users(oidc_subject,display_name,role,enabled)
      values('legacy-linked','Legacy linked','administrator',false) returning *`)
    ).rows[0];
    const { adapter, users } = adapterFixture();
    const external: KeycloakUser = {
      id: randomUUID(),
      username: 'legacy-linked',
      email: 'legacy@example.test',
      enabled: false,
      requiredActions: [],
      attributes: { [keycloakNameIdAttribute(binding.entityId)]: ['G-explicit'] },
    };
    users.set(external.id, external);
    const input: IdentityProvisioningRequest = {
      kind: 'link',
      requestId: randomUUID(),
      target: { kind: 'existing', userId: user.id, expectedSubject: user.oidc_subject },
      keycloakUserId: external.id,
      expectedUsername: external.username,
      expectedEmail: external.email!,
      expectedNameId: 'G-explicit',
    };
    const operation = await request(input);
    external.email = 'changed@example.test';
    await processIdentityOperation(database, binding, adapter);
    expect((await database.query('select * from user_identities')).rows).toEqual([]);
    expect(
      (
        await database.query('select error_code from identity_admin_operations where id=$1', [
          operation.id,
        ])
      ).rows[0].error_code,
    ).toBe('IDENTITY_ACCOUNT_CONFLICT');
    external.email = input.expectedEmail;
    await retryIdentityOperation(database, binding, adminId, operation.id);
    await processIdentityOperation(replica, binding, adapter);
    expect((await database.query('select * from users where id=$1', [user.id])).rows[0]).toEqual(
      user,
    );
    expect(
      (
        await database.query(
          'select enabled,provisioning_state from user_identities where user_id=$1',
          [user.id],
        )
      ).rows[0],
    ).toEqual({ enabled: false, provisioning_state: 'provisioned' });
    expect(adapter.setEnabled).not.toHaveBeenCalled();
  });
  it('retains mail uncertainty when SMTP accepted a message but the delivery checkpoint could not commit', async () => {
    const operation = await request(),
      { adapter } = adapterFixture();
    await processIdentityOperation(database, binding, adapter);
    const invite = await request({
      kind: 'invite',
      requestId: randomUUID(),
      target: {
        kind: 'existing',
        userId: operation.user_id!,
        expectedSubject: operation.expected_subject,
      },
      expectedEmail: operation.requested_email!,
    });
    await database.query(`create function fixture_delivery_failure() returns trigger language plpgsql as $$
      begin if new.delivered_at is not null then raise exception 'private-upstream-detail'; end if; return new; end $$;
      create trigger fixture_delivery_failure before update on identity_admin_outbox for each row execute function fixture_delivery_failure()`);
    try {
      await processIdentityOperation(database, binding, adapter);
    } finally {
      await database.query(
        'drop trigger fixture_delivery_failure on identity_admin_outbox; drop function fixture_delivery_failure()',
      );
    }
    expect(adapter.sendActionsEmail).toHaveBeenCalledTimes(1);
    expect(
      (
        await database.query(
          'select state,error_code,retryable from identity_admin_operations where id=$1',
          [invite.id],
        )
      ).rows[0],
    ).toEqual({ state: 'failed', error_code: 'IDENTITY_EMAIL_UNCONFIRMED', retryable: false });
    await retryAvailable(invite.id);
    expect(await processIdentityOperation(replica, binding, adapter)).toBe(false);
    expect(adapter.sendActionsEmail).toHaveBeenCalledTimes(1);
  });
  it('revokes only the reset target sessions before remote work and does not repeat revocation on duplicate requests', async () => {
    const operation = await request(),
      { adapter } = adapterFixture();
    await processIdentityOperation(database, binding, adapter);
    await database.query(
      `update user_identities set security_checked_at=statement_timestamp(),
      security_fresh_until=statement_timestamp()+interval '5 minutes' where user_id=$1`,
      [operation.user_id],
    );
    await database.query(
      `insert into user_sessions(id_hash,user_id,expires_at) values
      ($1,$2,clock_timestamp()+interval '1 hour'),($3,$4,clock_timestamp()+interval '1 hour')`,
      ['a'.repeat(64), operation.user_id, 'b'.repeat(64), adminId],
    );
    const reset: IdentityProvisioningRequest = {
      kind: 'password-reset',
      requestId: randomUUID(),
      target: {
        kind: 'existing',
        userId: operation.user_id!,
        expectedSubject: operation.expected_subject,
      },
      expectedEmail: operation.requested_email!,
      revokeAllSessions: true,
    };
    const queued = await request(reset);
    expect((await database.query('select user_id from user_sessions')).rows).toEqual([
      { user_id: adminId },
    ]);
    expect(
      (
        await database.query(
          'select security_epoch,security_checked_at,security_fresh_until from user_identities where user_id=$1',
          [operation.user_id],
        )
      ).rows[0],
    ).toEqual({ security_epoch: '2', security_checked_at: null, security_fresh_until: null });
    expect(adapter.logoutAll).not.toHaveBeenCalled();
    expect((await request(reset)).id).toBe(queued.id);
    expect(
      (
        await database.query('select security_epoch from user_identities where user_id=$1', [
          operation.user_id,
        ])
      ).rows[0].security_epoch,
    ).toBe('2');
    await processIdentityOperation(replica, binding, adapter);
    expect(adapter.logoutAll).toHaveBeenCalledTimes(1);
    expect(adapter.sendActionsEmail).toHaveBeenCalledWith(
      expect.any(String),
      reset.expectedEmail,
      'password-reset',
    );
    expect(adapter.logoutAll.mock.invocationCallOrder[0]!).toBeLessThan(
      adapter.sendActionsEmail.mock.invocationCallOrder[0]!,
    );
  });
  const apiFixture = async (enabled = true) => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl!,
      AUTH_MODE: 'local',
      LOCAL_BOOTSTRAP_ADMIN_USERNAME: 'fixture-admin',
      LOCAL_BOOTSTRAP_ADMIN_PASSWORD: 'synthetic-fixture-password-only',
      IDENTITY_ADMIN_ENABLED: String(enabled),
      PUBLIC_BASE_URL: 'https://gcr.test',
      SAML_IDP_ISSUER: binding.issuer,
      KEYCLOAK_ADMIN_CLIENT_ID: 'fixture',
      KEYCLOAK_ADMIN_CLIENT_SECRET_FILE: '/mounted/fixture.secret',
    });
    const app = Fastify();
    app.decorateRequest('user', null);
    app.addHook('onRequest', async (request) => {
      request.user =
        request.headers['x-fixture-role'] === 'anonymous'
          ? null
          : {
              id: adminId,
              subject: 'administrator',
              displayName: 'Administrator',
              enabled: true,
              role: request.headers['x-fixture-role'] === 'reviewer' ? 'reviewer' : 'administrator',
              groups: [],
              tenantIds: [tenantId],
              tenants: [],
            };
    });
    app.setErrorHandler((error, _request, reply) =>
      reply
        .code(error instanceof ZodError ? 400 : 500)
        .send({ error: { code: 'INVALID_FIXTURE_REQUEST' } }),
    );
    await registerIdentityAdministrationRoutes(
      app,
      database,
      new AuthorizationService(config),
      config,
    );
    return app;
  };
  it('exposes disabled capabilities and refuses operation creation when administration is off', async () => {
    const app = await apiFixture(false);
    try {
      expect((await app.inject('/api/v1/admin/identity/capabilities')).json()).toMatchObject({
        enabled: false,
        actions: [],
        authMode: 'local',
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/identity/operations',
            payload: create(),
          })
        ).statusCode,
      ).toBe(404);
      expect((await database.query('select * from identity_admin_operations')).rows).toEqual([]);
    } finally {
      await app.close();
    }
  });
  it('protects the API from anonymous/reviewer callers, enforces strict request bodies and returns the same operation after a lost response', async () => {
    const app = await apiFixture(),
      input = create();
    try {
      for (const role of ['anonymous', 'reviewer']) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/identity/operations',
          headers: { 'x-fixture-role': role },
          payload: input,
        });
        expect(response.statusCode).toBe(404);
        expect(response.json().error.code).toBe('RESOURCE_NOT_FOUND');
      }
      const invalid = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/identity/operations',
        payload: { ...input, password: 'must-not-persist' },
      });
      expect(invalid.statusCode).toBe(400);
      expect((await database.query('select * from identity_admin_operations')).rows).toEqual([]);
      const first = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/identity/operations',
        payload: input,
      });
      const repeated = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/identity/operations',
        payload: input,
      });
      expect(first.statusCode).toBe(202);
      expect(repeated.json()).toEqual(first.json());
      expect(first.json().operation).not.toHaveProperty('dedupe_key');
      expect(first.json().operation).not.toHaveProperty('expected_name_id');
      expect(first.json().operation.state).toBe('pending');
      expect((await app.inject('/api/v1/admin/identity/operations')).json().items).toHaveLength(1);
      const conflict = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/identity/operations',
        payload: { ...input, displayName: 'Changed' },
      });
      expect(conflict.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
});
