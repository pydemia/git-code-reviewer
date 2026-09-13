import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  beginSamlLogin,
  consumeSamlLogin,
  linkExistingSamlIdentity,
  loadSamlLogin,
  persistentNameId,
  pruneSamlState,
  samlConfigurationKey,
  samlReturnTo,
  type SamlProviderBinding,
  type SamlIdentity,
  type VerifiedSamlLogin,
} from './saml-state.js';

const provider: SamlProviderBinding = {
  issuer: 'https://idp.test/realms/gcr',
  entityId: 'https://gcr.test/saml',
  acsUrl: 'https://gcr.test/api/auth/saml/acs',
  sloUrl: 'https://gcr.test/api/auth/saml/slo',
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const id = () => `_${randomUUID()}`;

describe('SAML binding input', () => {
  it.each([
    '//evil.test',
    '/\\evil.test',
    '/%5cevil.test',
    '/%255cevil.test',
    '/%2f/evil.test',
    '/a/..//evil.test',
    '/%0d%0aLocation:evil',
    '/%2500',
    'https://evil.test',
    '/bad%',
    ' /path',
  ])('rejects unsafe return path %s', (value) => {
    expect(() => samlReturnTo(value)).toThrow('SAML_INVALID_INPUT');
  });
  it('preserves internal paths and query while normalizing dot segments', () => {
    expect(samlReturnTo('/reviews/../worklist?state=open#top')).toBe('/worklist?state=open#top');
    expect(samlReturnTo('/worklist?q=%ED%95%9C%EA%B8%80')).toBe('/worklist?q=%ED%95%9C%EA%B8%80');
  });
  it('binds exact HTTPS issuer, entity, ACS and SLO with one SP origin', () => {
    expect(samlConfigurationKey(provider)).not.toBe(
      samlConfigurationKey({ ...provider, acsUrl: provider.acsUrl + '/new' }),
    );
    for (const bad of [
      { ...provider, issuer: 'http://idp.test/realm' },
      { ...provider, acsUrl: 'https://evil.test/acs' },
      { ...provider, issuer: provider.issuer + '?x=y' },
    ])
      expect(() => samlConfigurationKey(bad)).toThrow('SAML_INVALID_INPUT');
  });
});

const databaseUrl = process.env.GCR_TEST_DATABASE_URL;
describe
  .skipIf(!databaseUrl)
  .sequential('SAML durable transaction and explicit identity mapping', () => {
    const schema = `gcr_saml_${randomUUID().replaceAll('-', '')}`;
    let root: Database, database: Database, connection: string, adminId: string, oldUserId: string;
    let beforeMigration: unknown;
    let messageCollisionReplicas: ReplicaResult[];
    const legacyState = async () => {
      const tables = [
        'users',
        'local_credentials',
        'repository_grants',
        'tenant_memberships',
        'review_memories',
      ];
      return Object.fromEntries(
        await Promise.all(
          tables.map(async (table) => [
            table,
            (await database.query(`select * from ${table} order by 1`)).rows,
          ]),
        ),
      );
    };
    beforeAll(async () => {
      const url = new URL(databaseUrl!);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw Error('Local isolated PostgreSQL only');
      root = createDatabase(url.href);
      await root.query(`create schema ${schema}`);
      url.searchParams.set('options', `-c search_path=${schema}`);
      connection = url.href;
      database = createDatabase(connection);
      const oldMigrations = await mkdtemp(path.join(tmpdir(), 'gcr-saml-migration-'));
      try {
        for (const file of (await readdir('packages/db/migrations')).filter(
          (file) => file.endsWith('.sql') && file < '0032',
        ))
          await copyFile(path.join('packages/db/migrations', file), path.join(oldMigrations, file));
        await runMigrations(database, oldMigrations);
      } finally {
        await rm(oldMigrations, { recursive: true, force: true });
      }
      adminId = (
        await database.query(
          "insert into users(oidc_subject,display_name,role) values('legacy-admin','Admin','administrator') returning id",
        )
      ).rows[0].id;
      oldUserId = (
        await database.query(`insert into users(oidc_subject,display_name,role,groups_json,personal_prompt)
      values('legacy-subject','Original Reviewer','reviewer','["engineering"]','Original prompt') returning id`)
      ).rows[0].id;
      await database.query(
        "insert into local_credentials(user_id,username,password_hash) values($1,'original-reviewer','synthetic-password-hash')",
        [oldUserId],
      );
      await database.query(
        "insert into user_sessions(id_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 hour')",
        [hash('legacy-session'), oldUserId],
      );
      const tenant = (await database.query("select id from tenants where slug='default'")).rows[0]
        .id;
      await database.query('insert into tenant_memberships(tenant_id,user_id) values($1,$2)', [
        tenant,
        oldUserId,
      ]);
      const instance = (
        await database.query(
          "insert into github_instances(name,api_base_url,web_base_url) values('Fixture','https://github.test/api','https://github.test') returning id",
        )
      ).rows[0].id;
      const repo = (
        await database.query(
          "insert into repositories(instance_id,github_id,installation_id,owner,name,tenant_id) values($1,1,'1','fixture','repo',$2) returning id",
          [instance, tenant],
        )
      ).rows[0].id;
      await database.query(
        "insert into repository_grants(repository_id,subject_or_group,role) values($1,'legacy-subject','reviewer')",
        [repo],
      );
      await database.query(
        `insert into review_memories(tenant_id,repository_id,scope,owner_user_id,kind,state,summary,search_text,aggregation_key,content_hash,source_kind)
      values($1,$2,'personal',$3,'decision','candidate','Original memory','original',$4,$5,'manual')`,
        [tenant, repo, oldUserId, hash('aggregate'), hash('content')],
      );
      beforeMigration = await legacyState();
      await runMigrations(database, path.resolve('packages/db/migrations'));
    }, 30_000);
    afterAll(async () => {
      await database?.end();
      if (root) {
        await root.query(`drop schema ${schema} cascade`);
        await root.end();
      }
    });

    async function mappedUser(options: { existing?: boolean; active?: boolean } = {}) {
      const subject = options.existing ? 'legacy-subject' : `fixture-${randomUUID()}`;
      const userId: string = options.existing
        ? oldUserId
        : (
            await database.query(
              "insert into users(oidc_subject,display_name,role) values($1,'Same email@example.test','reviewer') returning id",
              [subject],
            )
          ).rows[0].id;
      const identity: SamlIdentity = {
        issuer: provider.issuer,
        entityId: provider.entityId,
        nameID: `persistent-${randomUUID()}`,
        nameIDFormat: persistentNameId,
        nameQualifier: provider.issuer,
        spNameQualifier: provider.entityId,
      };
      const input = {
        actorId: adminId,
        userId,
        expectedSubject: subject,
        keycloakUserId: randomUUID(),
        identity,
      };
      const identityId = await linkExistingSamlIdentity(database, provider, input);
      // Fixture-only verified IdP state; production activation is P03-C04/C05.
      if (options.active !== false)
        await database.query(
          `update user_identities set provisioning_state='provisioned',enabled=true,identity_verified_at=clock_timestamp(),
      security_checked_at=statement_timestamp(),security_fresh_until=statement_timestamp()+interval '5 minutes' where id=$1`,
          [identityId],
        );
      return { userId, identityId, identity, input };
    }
    async function pending(identity: SamlIdentity, returnTo = '/worklist') {
      const browser = await beginSamlLogin(database, provider, returnTo);
      // Represents the output of the separately tested crypto/protocol verifier.
      const verified: VerifiedSamlLogin = {
        ...identity,
        requestId: browser.requestId,
        responseId: id(),
        assertionId: id(),
        sessionIndex: randomUUID(),
        sessionExpiresAt: Date.now() + 60_000,
      };
      return { browser, verified };
    }
    const consume = (attempt: Awaited<ReturnType<typeof pending>>) =>
      consumeSamlLogin(database, provider, attempt.browser, attempt.verified);
    const counts = async () =>
      (
        await database.query(`select
    (select count(*)::int from user_sessions where saml_identity_id is not null) as sessions,
    (select count(*)::int from saml_transactions where consumed_at is not null) as transactions,
    (select count(*)::int from saml_message_consumptions) as messages`)
      ).rows[0];

    it('preserves legacy IDs, subjects, role/groups, credentials, grants, personal owner and local session when migrating and linking', async () => {
      expect(await legacyState()).toEqual(beforeMigration);
      const oldSession = (
        await database.query('select * from user_sessions where id_hash=$1', [
          hash('legacy-session'),
        ])
      ).rows[0];
      expect(oldSession).toMatchObject({
        user_id: oldUserId,
        saml_identity_id: null,
        saml_session_index: null,
      });
      const mapped = await mappedUser({ existing: true, active: false });
      expect(await legacyState()).toEqual(beforeMigration);
      expect(
        (
          await database.query(
            'select enabled,provisioning_state,security_fresh_until from user_identities where id=$1',
            [mapped.identityId],
          )
        ).rows[0],
      ).toEqual({ enabled: false, provisioning_state: 'pending', security_fresh_until: null });
      expect(await linkExistingSamlIdentity(database, provider, mapped.input)).toBe(
        mapped.identityId,
      );
      await expect(consume(await pending(mapped.identity))).rejects.toMatchObject({
        code: 'SAML_IDENTITY_UNAVAILABLE',
      });
    });

    it('requires an active admin and explicit expected subject, with no email linking or cross-user reassignment', async () => {
      const a = await mappedUser(),
        b = await mappedUser();
      await expect(
        linkExistingSamlIdentity(database, provider, { ...a.input, actorId: b.userId }),
      ).rejects.toMatchObject({ code: 'SAML_MAPPING_FORBIDDEN' });
      await expect(
        linkExistingSamlIdentity(database, provider, {
          ...a.input,
          expectedSubject: 'changed-subject',
        }),
      ).rejects.toMatchObject({ code: 'SAML_MAPPING_CONFLICT' });
      await expect(
        linkExistingSamlIdentity(database, provider, { ...b.input, identity: a.identity }),
      ).rejects.toMatchObject({ code: 'SAML_MAPPING_CONFLICT' });
      await expect(
        linkExistingSamlIdentity(database, provider, {
          ...b.input,
          keycloakUserId: a.input.keycloakUserId,
        }),
      ).rejects.toMatchObject({ code: 'SAML_MAPPING_CONFLICT' });
      await expect(
        consume(await pending({ ...a.identity, nameID: 'email@example.test' })),
      ).rejects.toMatchObject({ code: 'SAML_IDENTITY_UNAVAILABLE' });
      expect(
        (
          await database.query(
            'select count(*)::int as count from tenant_memberships where user_id=any($1::uuid[])',
            [[a.userId, b.userId]],
          )
        ).rows[0].count,
      ).toBe(0);
    });

    it('stores only nonce/state/message/session hashes and binds the issued session to identity, epoch, SessionIndex and assertion expiry', async () => {
      const mapped = await mappedUser();
      const attempt = await pending(mapped.identity);
      const view = await loadSamlLogin(database, provider, attempt.browser);
      expect(view.requestId).toBe(attempt.verified.requestId);
      const issued = await consume(attempt);
      expect(issued).toMatchObject({
        userId: mapped.userId,
        identityId: mapped.identityId,
        returnTo: '/worklist',
        expiresAt: attempt.verified.sessionExpiresAt,
      });
      const session = (
        await database.query('select * from user_sessions where id_hash=$1', [
          hash(issued.sessionToken),
        ])
      ).rows[0];
      expect(session).toMatchObject({
        user_id: mapped.userId,
        saml_identity_id: mapped.identityId,
        saml_session_index: attempt.verified.sessionIndex,
        saml_security_epoch: '1',
      });
      const tx = (
        await database.query('select * from saml_transactions where request_id=$1', [
          view.requestId,
        ])
      ).rows[0];
      expect(tx.relay_state_hash).toBe(hash(attempt.browser.relayState));
      expect(tx.browser_nonce_hash).toBe(hash(attempt.browser.browserNonce));
      const raw = JSON.stringify({
        session,
        tx,
        messages: (await database.query('select * from saml_message_consumptions')).rows,
      });
      for (const secret of [
        issued.sessionToken,
        attempt.browser.relayState,
        attempt.browser.browserNonce,
        attempt.verified.responseId,
        attempt.verified.assertionId,
      ])
        expect(raw).not.toContain(secret);
      expect(session.expires_at.getTime()).toBe(attempt.verified.sessionExpiresAt);
      await expect(consume(attempt)).rejects.toMatchObject({ code: 'SAML_TRANSACTION_INVALID' });
    });

    it('rejects nonce, RelayState, request, provider and transaction-kind mismatch without consuming valid state', async () => {
      const mapped = await mappedUser();
      const attempt = await pending(mapped.identity);
      const before = await counts();
      for (const field of ['relayState', 'browserNonce'] as const)
        await expect(
          consume({
            ...attempt,
            browser: { ...attempt.browser, [field]: randomBytes(32).toString('base64url') },
          }),
        ).rejects.toMatchObject({ code: 'SAML_TRANSACTION_INVALID' });
      await expect(
        consume({ ...attempt, verified: { ...attempt.verified, requestId: id() } }),
      ).rejects.toMatchObject({ code: 'SAML_TRANSACTION_INVALID' });
      await expect(
        consumeSamlLogin(
          database,
          { ...provider, acsUrl: provider.acsUrl + '/other' },
          attempt.browser,
          attempt.verified,
        ),
      ).rejects.toMatchObject({ code: 'SAML_TRANSACTION_INVALID' });
      await database.query(
        `update saml_transactions set kind='logout',logout_identity_id=$2,logout_session_index='fixture',logout_session_hash=$3 where request_id=$1`,
        [attempt.browser.requestId, mapped.identityId, hash('logout')],
      );
      await expect(consume(attempt)).rejects.toMatchObject({ code: 'SAML_TRANSACTION_INVALID' });
      await database.query(
        "update saml_transactions set kind='login',logout_identity_id=null,logout_session_index=null,logout_session_hash=null where request_id=$1",
        [attempt.browser.requestId],
      );
      expect(await counts()).toEqual(before);
      await consume(attempt);
    });

    it('rejects expired request and expired assertion session even when identity is provisioned', async () => {
      const mapped = await mappedUser();
      const attempt = await pending(mapped.identity);
      await database.query(
        "update saml_transactions set created_at=statement_timestamp()-interval '6 minutes',expires_at=statement_timestamp()-interval '1 minute' where request_id=$1",
        [attempt.browser.requestId],
      );
      await expect(consume(attempt)).rejects.toMatchObject({ code: 'SAML_TRANSACTION_INVALID' });
      const expired = await pending(mapped.identity);
      await expect(
        consume({
          ...expired,
          verified: { ...expired.verified, sessionExpiresAt: Date.now() - 1 },
        }),
      ).rejects.toMatchObject({ code: 'SAML_TRANSACTION_INVALID' });
    });

    it.each([
      'disabled-user',
      'deleted-user',
      'disabled-identity',
      'stale',
      'future-check',
      'pending',
    ] as const)('rejects %s without renewing freshness or creating a session', async (state) => {
      const mapped = await mappedUser();
      const attempt = await pending(mapped.identity);
      const before = await counts();
      if (state === 'disabled-user' || state === 'deleted-user')
        await database.query(
          `update users set enabled=false,deleted_at=${state === 'deleted-user' ? 'clock_timestamp()' : 'null'} where id=$1`,
          [mapped.userId],
        );
      else if (state === 'disabled-identity')
        await database.query('update user_identities set enabled=false where id=$1', [
          mapped.identityId,
        ]);
      else if (state === 'pending')
        await database.query(
          "update user_identities set enabled=false,provisioning_state='pending' where id=$1",
          [mapped.identityId],
        );
      else if (state === 'stale')
        await database.query(
          "update user_identities set security_checked_at=statement_timestamp()-interval '6 minutes',security_fresh_until=statement_timestamp()-interval '1 minute' where id=$1",
          [mapped.identityId],
        );
      else
        await database.query(
          "update user_identities set security_checked_at=statement_timestamp()+interval '1 minute',security_fresh_until=statement_timestamp()+interval '2 minutes' where id=$1",
          [mapped.identityId],
        );
      const freshness = (
        await database.query(
          'select security_checked_at,security_fresh_until from user_identities where id=$1',
          [mapped.identityId],
        )
      ).rows;
      await expect(consume(attempt)).rejects.toMatchObject({
        code: ['stale', 'future-check'].includes(state)
          ? 'SAML_SECURITY_UNAVAILABLE'
          : 'SAML_IDENTITY_UNAVAILABLE',
      });
      expect(await counts()).toEqual(before);
      expect(
        (
          await database.query(
            'select security_checked_at,security_fresh_until from user_identities where id=$1',
            [mapped.identityId],
          )
        ).rows,
      ).toEqual(freshness);
    });

    it('allows separate browser tabs but rejects reused Response or Assertion IDs across requests and message kinds', async () => {
      const mapped = await mappedUser();
      const first = await pending(mapped.identity);
      await consume(first);
      for (const field of ['responseId', 'assertionId'] as const) {
        const next = await pending(mapped.identity);
        const before = await counts();
        await expect(
          consume({ ...next, verified: { ...next.verified, [field]: first.verified[field] } }),
        ).rejects.toMatchObject({ code: 'SAML_REPLAY' });
        expect(await counts()).toEqual(before);
        await consume(next);
      }
      const cross = await pending(mapped.identity);
      await expect(
        consume({
          ...cross,
          verified: { ...cross.verified, responseId: first.verified.assertionId },
        }),
      ).rejects.toMatchObject({ code: 'SAML_REPLAY' });
      const tabs = await Promise.all([
        pending(mapped.identity, '/first'),
        pending(mapped.identity, '/second'),
      ]);
      expect((await Promise.all(tabs.map(consume))).map((result) => result.returnTo)).toEqual([
        '/first',
        '/second',
      ]);
    });

    it('caps an issued session to eight hours', async () => {
      const mapped = await mappedUser();
      const attempt = await pending(mapped.identity);
      const session = await consume({
        ...attempt,
        verified: { ...attempt.verified, sessionExpiresAt: Date.now() + 24 * 60 * 60_000 },
      });
      const row = (
        await database.query('select created_at,expires_at from user_sessions where id_hash=$1', [
          hash(session.sessionToken),
        ])
      ).rows[0];
      expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(8 * 60 * 60_000);
    });

    it('rolls back replay records and session together when storage fails, with sanitized errors and a successful retry', async () => {
      const mapped = await mappedUser();
      const attempt = await pending(mapped.identity);
      const before = await counts();
      await database.query(`create function reject_saml_session() returns trigger language plpgsql as $$ begin
      raise exception 'synthetic-private-database-detail'; end $$;
      create trigger saml_session_failure before insert on user_sessions for each row execute function reject_saml_session()`);
      try {
        await expect(consume(attempt)).rejects.toMatchObject({
          code: 'SAML_STORAGE_UNAVAILABLE',
          message: 'SAML_STORAGE_UNAVAILABLE',
        });
        expect(await counts()).toEqual(before);
        expect((await loadSamlLogin(database, provider, attempt.browser)).requestId).toBe(
          attempt.browser.requestId,
        );
      } finally {
        await database.query(
          'drop trigger saml_session_failure on user_sessions; drop function reject_saml_session()',
        );
      }
      await consume(attempt);
    });

    it('enforces session ownership, bounded freshness and logout transaction fields in PostgreSQL', async () => {
      const a = await mappedUser(),
        b = await mappedUser();
      const attempt = await pending(a.identity);
      const session = await consume(attempt);
      await expect(
        database.query('update user_sessions set user_id=$2 where id_hash=$1', [
          hash(session.sessionToken),
          b.userId,
        ]),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        database.query(
          "update user_identities set security_fresh_until=security_checked_at+interval '6 minutes' where id=$1",
          [a.identityId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      const next = await pending(a.identity);
      await expect(
        database.query(
          "update saml_transactions set kind='logout',logout_identity_id=$2,logout_session_index='fixture' where request_id=$1",
          [next.browser.requestId, a.identityId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      const columns = (
        await database.query(
          "select column_name from information_schema.columns where table_schema=$1 and table_name in ('identity_admin_operations','identity_admin_outbox')",
          [schema],
        )
      ).rows.map((row) => row.column_name);
      expect(columns).not.toContain('payload');
      expect(columns).not.toContain('password');
      expect(columns).not.toContain('token');
    });

    it('rolls back when freshness expires during session insertion', async () => {
      const mapped = await mappedUser();
      const attempt = await pending(mapped.identity);
      const before = await counts();
      await database.query(`create function delay_saml_session() returns trigger language plpgsql as $$ begin
      update user_identities set security_checked_at=statement_timestamp(),
        security_fresh_until=statement_timestamp()+interval '0.1 seconds' where id=new.saml_identity_id;
      perform pg_sleep(0.2); return new; end $$;
      create trigger saml_session_delay before insert on user_sessions for each row execute function delay_saml_session()`);
      try {
        await expect(consume(attempt)).rejects.toMatchObject({ code: 'SAML_TRANSACTION_INVALID' });
        expect(await counts()).toEqual(before);
      } finally {
        await database.query(
          'drop trigger saml_session_delay on user_sessions; drop function delay_saml_session()',
        );
      }
    });

    it('serializes a concurrent administrator block with login and denies the waiting login', async () => {
      const mapped = await mappedUser();
      const attempt = await pending(mapped.identity);
      const before = await counts();
      const blocker = await database.connect();
      const replica = createDatabase(connection, 1);
      const pid = (await replica.query('select pg_backend_pid() as id')).rows[0].id;
      await blocker.query('begin');
      await blocker.query('select id from users where id=$1 for update', [mapped.userId]);
      const result = consumeSamlLogin(replica, provider, attempt.browser, attempt.verified).then(
        () => ({ code: 'UNEXPECTED_SUCCESS' }),
        (error) => ({ code: error.code }),
      );
      try {
        let waiting = false;
        for (let i = 0; i < 100; i++) {
          waiting = (
            await database.query(
              "select wait_event_type='Lock' as waiting from pg_stat_activity where pid=$1",
              [pid],
            )
          ).rows[0]?.waiting;
          if (waiting) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        await blocker.query('update users set enabled=false where id=$1', [mapped.userId]);
        await blocker.query('commit');
        expect(await result).toEqual({ code: 'SAML_IDENTITY_UNAVAILABLE' });
        expect(await counts()).toEqual(before);
      } finally {
        await blocker.query('rollback');
        blocker.release();
        await result;
        await replica.end();
      }
    });

    it('retains live replay records and prunes expired state in bounded batches', async () => {
      const mapped = await mappedUser();
      const attempts = await Promise.all([pending(mapped.identity), pending(mapped.identity)]);
      for (const attempt of attempts) await consume(attempt);
      const responseIds = attempts.map((attempt) => hash(attempt.verified.responseId));
      await database.query(
        "update saml_transactions set created_at=statement_timestamp()-interval '6 minutes',expires_at=statement_timestamp()-interval '1 minute' where request_id=any($1)",
        [attempts.map((attempt) => attempt.browser.requestId)],
      );
      await database.query(
        "update saml_message_consumptions set consumed_at=statement_timestamp()-interval '11 minutes',expires_at=statement_timestamp()-interval '1 minute' where message_id_hash=any($1)",
        [responseIds],
      );
      const before = await counts();
      const pruned = await pruneSamlState(database, 1);
      expect(pruned).toEqual({ transactions: 1, messages: 1, revocations: 0 });
      expect((await counts()).messages).toBe(before.messages - 1);
      for (const attempt of attempts)
        expect(
          (
            await database.query(
              'select count(*)::int as count from saml_message_consumptions where message_id_hash=$1',
              [hash(attempt.verified.assertionId)],
            )
          ).rows[0].count,
        ).toBe(1);
      await expect(pruneSamlState(database, 0)).rejects.toMatchObject({
        code: 'SAML_INVALID_INPUT',
      });
    });

    it('rejects concurrent reuse of a message ID across different users and AuthnRequests', async () => {
      const a = await mappedUser(),
        b = await mappedUser();
      const first = await pending(a.identity),
        second = await pending(b.identity);
      const before = await counts();
      messageCollisionReplicas = await runTwoReplicas(connection, first, {
        ...second,
        verified: { ...second.verified, responseId: first.verified.responseId },
      });
      expect(messageCollisionReplicas.filter((result) => result.status === 'passed')).toHaveLength(
        1,
      );
      expect(
        messageCollisionReplicas.filter((result) => result.code === 'SAML_REPLAY'),
      ).toHaveLength(1);
      expect(await counts()).toEqual({
        sessions: before.sessions + 1,
        transactions: before.transactions + 1,
        messages: before.messages + 2,
      });
    }, 20_000);

    it('lets exactly one of two independent Node replicas consume a response, then rejects it after a pool restart', async () => {
      const mapped = await mappedUser();
      const attempt = await pending(mapped.identity);
      const before = await counts();
      const results = await runTwoReplicas(connection, attempt);
      expect(new Set(results.map((result) => result.pid)).size).toBe(2);
      expect(new Set(results.map((result) => result.backendPid)).size).toBe(2);
      expect(results.filter((result) => result.status === 'passed')).toHaveLength(1);
      expect(results.filter((result) => result.code === 'SAML_TRANSACTION_INVALID')).toHaveLength(
        1,
      );
      expect(await counts()).toEqual({
        sessions: before.sessions + 1,
        transactions: before.transactions + 1,
        messages: before.messages + 2,
      });
      const restarted = createDatabase(connection);
      try {
        await expect(
          consumeSamlLogin(restarted, provider, attempt.browser, attempt.verified),
        ).rejects.toMatchObject({ code: 'SAML_TRANSACTION_INVALID' });
      } finally {
        await restarted.end();
      }
      if (process.env.GCR_SAML_STATE_EVIDENCE) {
        const sources = [
          'apps/runtime/src/auth/saml-state.ts',
          'apps/runtime/src/auth/saml-state.integration.test.ts',
          'packages/db/migrations/0032_saml_identity_state.sql',
        ];
        const sourceHashes = Object.fromEntries(
          await Promise.all(
            sources.map(async (file) => [file, hash(await readFile(file, 'utf8'))]),
          ),
        );
        await writeFile(
          process.env.GCR_SAML_STATE_EVIDENCE,
          JSON.stringify(
            {
              status: 'passed',
              at: new Date().toISOString(),
              node: process.version,
              sourceHashes,
              replicas: results,
              messageCollisionReplicas,
              successfulConsumers: 1,
              newSessions: 1,
              newConsumedTransactions: 1,
              newMessageHashes: 2,
              restartReplayRejected: true,
              verifierInput:
                'Synthetic already-verified identity fixture; cryptographic/IdP verification is covered separately by P03-C01.',
            },
            null,
            2,
          ) + '\n',
          { flag: 'wx', mode: 0o600 },
        );
      }
    }, 20_000);
  });

type ReplicaResult = { pid: number; backendPid: number; status: string; code?: string };
async function runTwoReplicas(
  connection: string,
  attempt: { browser: unknown; verified: VerifiedSamlLogin },
  otherAttempt = attempt,
): Promise<ReplicaResult[]> {
  const loader = createRequire(import.meta.url).resolve('tsx');
  const stateModule = pathToFileURL(path.resolve('apps/runtime/src/auth/saml-state.ts')).href;
  const databaseModule = pathToFileURL(path.resolve('packages/db/dist/index.js')).href;
  const program = `
    import {createDatabase} from ${JSON.stringify(databaseModule)};
    import {consumeSamlLogin} from ${JSON.stringify(stateModule)};
    const db=createDatabase(process.env.GCR_TEST_DATABASE_URL,1);
    const backendPid=(await db.query('select pg_backend_pid() as id')).rows[0].id;
    process.once('message',async input=>{
      let result;
      try {await consumeSamlLogin(db,input.provider,input.browser,input.verified);result={status:'passed'};}
      catch(error){result={status:'rejected',code:error.code ?? 'UNEXPECTED'};}
      await db.end();process.send({...result,pid:process.pid,backendPid});process.disconnect();
    });
    process.send({ready:true});
  `;
  const workers = Array.from({ length: 2 }, () =>
    spawn(process.execPath, ['--import', loader, '--input-type=module', '-e', program], {
      env: { ...process.env, GCR_TEST_DATABASE_URL: connection },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Error('SAML replica test deadline exceeded')), 10_000);
  });
  try {
    await Promise.race([
      deadline,
      Promise.all(
        workers.map(
          (worker) =>
            new Promise<void>((resolve, reject) => {
              worker.once('message', () => resolve());
              worker.once('error', reject);
              worker.once('exit', (code) => reject(Error(`Replica exited before ready (${code})`)));
            }),
        ),
      ),
    ]);
    return await Promise.race([
      deadline,
      Promise.all(
        workers.map(
          (worker, index) =>
            new Promise<ReplicaResult>((resolve, reject) => {
              worker.once('message', (result) => resolve(result as ReplicaResult));
              worker.once('error', reject);
              worker.once('exit', () => reject(Error('Replica exited before result')));
              worker.send({ ...(index === 0 ? attempt : otherAttempt), provider });
            }),
        ),
      ),
    ]);
  } finally {
    clearTimeout(timer);
    for (const worker of workers)
      if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGTERM');
  }
}
