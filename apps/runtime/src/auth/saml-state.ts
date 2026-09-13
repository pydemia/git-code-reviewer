import { createHash, randomBytes } from 'node:crypto';
import type { Database, DatabaseClient } from '@gcr/db';

export const persistentNameId = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
const transactionMs = 5 * 60_000;
const sessionMs = 8 * 60 * 60_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SamlStateErrorCode =
  | 'SAML_INVALID_INPUT'
  | 'SAML_MAPPING_FORBIDDEN'
  | 'SAML_MAPPING_CONFLICT'
  | 'SAML_TRANSACTION_INVALID'
  | 'SAML_IDENTITY_UNAVAILABLE'
  | 'SAML_SECURITY_UNAVAILABLE'
  | 'SAML_REPLAY'
  | 'SAML_STORAGE_UNAVAILABLE';

// Do not attach a PG error/cause: its detail can contain identifiers or a token hash.
export class SamlStateError extends Error {
  constructor(readonly code: SamlStateErrorCode) {
    super(code);
    this.name = 'SamlStateError';
  }
}

export interface SamlProviderBinding {
  readonly issuer: string;
  readonly entityId: string;
  readonly acsUrl: string;
  readonly sloUrl: string;
}

export interface SamlIdentity {
  readonly issuer: string;
  readonly entityId: string;
  readonly nameID: string;
  readonly nameIDFormat: typeof persistentNameId;
  readonly nameQualifier?: string | null;
  readonly spNameQualifier?: string | null;
}

export interface SamlBrowserBinding {
  readonly relayState: string;
  readonly browserNonce: string;
}

// Only a signature/protocol verifier may supply this input. This persistence
// layer does not parse XML and must never receive unverified request fields.
export interface VerifiedSamlLogin extends SamlIdentity {
  readonly requestId: string;
  readonly responseId: string;
  readonly assertionId: string;
  readonly sessionIndex: string;
  readonly sessionExpiresAt: number;
}

export interface VerifiedSamlLogoutRequest extends SamlIdentity {
  readonly requestId: string;
  readonly sessionIndexes: readonly string[];
}

interface TransactionRow {
  id: string;
  request_id: string;
  return_to: string;
  created_at: Date;
  expires_at: Date;
}

function fail(code: SamlStateErrorCode): never {
  throw new SamlStateError(code);
}

function hasControl(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

function text(value: unknown, max: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > max ||
    hasControl(value) ||
    Buffer.from(value).toString('utf8') !== value
  )
    fail('SAML_INVALID_INPUT');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tuple(values: unknown[]): string {
  return hash(JSON.stringify(values));
}

function trustedUrl(value: string): URL {
  text(value, 2048);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('SAML_INVALID_INPUT');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== value
  )
    fail('SAML_INVALID_INPUT');
  return url;
}

export function samlConfigurationKey(binding: SamlProviderBinding): string {
  trustedUrl(binding.issuer);
  const sp = trustedUrl(binding.entityId);
  if (
    trustedUrl(binding.acsUrl).origin !== sp.origin ||
    trustedUrl(binding.sloUrl).origin !== sp.origin
  )
    fail('SAML_INVALID_INPUT');
  return tuple([binding.issuer, binding.entityId, binding.acsUrl, binding.sloUrl]);
}

function identityKey(binding: SamlProviderBinding, identity: SamlIdentity): string {
  samlConfigurationKey(binding);
  text(identity.nameID, 4096);
  if (
    identity.issuer !== binding.issuer ||
    identity.entityId !== binding.entityId ||
    identity.nameIDFormat !== persistentNameId
  )
    fail('SAML_INVALID_INPUT');
  if (identity.nameQualifier != null && identity.nameQualifier !== binding.issuer)
    fail('SAML_INVALID_INPUT');
  if (identity.spNameQualifier != null && identity.spNameQualifier !== binding.entityId)
    fail('SAML_INVALID_INPUT');
  return tuple([
    identity.issuer,
    identity.entityId,
    identity.nameIDFormat,
    identity.nameID,
    identity.nameQualifier ?? null,
    identity.spNameQualifier ?? null,
  ]);
}

export function samlReturnTo(value: string = '/'): string {
  text(value, 2048);
  let decoded = value;
  for (let i = 0; i < 5; i++) {
    if (
      !decoded.startsWith('/') ||
      decoded.startsWith('//') ||
      decoded.includes('\\') ||
      hasControl(decoded)
    )
      fail('SAML_INVALID_INPUT');
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return fail('SAML_INVALID_INPUT');
    }
    if (next === decoded) break;
    if (i === 4) fail('SAML_INVALID_INPUT');
    decoded = next;
  }
  const url = new URL(value, 'https://return.invalid');
  if (url.origin !== 'https://return.invalid' || url.pathname.startsWith('//'))
    fail('SAML_INVALID_INPUT');
  return `${url.pathname}${url.search}${url.hash}`;
}

async function atomic<T>(
  database: Database,
  action: (client: DatabaseClient) => Promise<T>,
  conflict: SamlStateErrorCode,
): Promise<T> {
  let client: DatabaseClient | undefined;
  try {
    client = await database.connect();
    await client.query('begin');
    await client.query("set local lock_timeout = '5s'");
    await client.query("set local statement_timeout = '10s'");
    const value = await action(client);
    await client.query('commit');
    return value;
  } catch (error) {
    await client?.query('rollback').catch(() => undefined);
    if (error instanceof SamlStateError) throw error;
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505')
      fail(conflict);
    return fail('SAML_STORAGE_UNAVAILABLE');
  } finally {
    client?.release();
  }
}

export async function linkExistingSamlIdentity(
  database: Database,
  binding: SamlProviderBinding,
  input: {
    actorId: string;
    userId: string;
    expectedSubject: string;
    keycloakUserId: string;
    identity: SamlIdentity;
  },
): Promise<string> {
  if (!uuid.test(input.actorId) || !uuid.test(input.userId)) fail('SAML_INVALID_INPUT');
  text(input.expectedSubject, 4096);
  text(input.keycloakUserId, 255);
  const key = identityKey(binding, input.identity);
  const userKey = tuple([input.userId, binding.issuer, binding.entityId]);
  // One Keycloak account is bound to one existing app user. Email is not a key.
  const keycloakKey = tuple([binding.issuer, input.keycloakUserId]);
  return atomic(
    database,
    async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext('gcr:user-administration'))");
      const users = (
        await client.query<{
          id: string;
          oidc_subject: string;
          role: string;
          enabled: boolean;
          deleted_at: Date | null;
        }>(
          'select id,oidc_subject,role,enabled,deleted_at from users where id=any($1::uuid[]) order by id for update',
          [[input.actorId, input.userId]],
        )
      ).rows;
      const actor = users.find((row) => row.id === input.actorId);
      if (!actor?.enabled || actor.deleted_at || actor.role !== 'administrator')
        fail('SAML_MAPPING_FORBIDDEN');
      const user = users.find((row) => row.id === input.userId);
      if (!user || user.deleted_at || user.oidc_subject !== input.expectedSubject)
        fail('SAML_MAPPING_CONFLICT');
      const matches = (
        await client.query<{
          id: string;
          identity_key: string;
          user_binding_key: string;
          keycloak_identity_key: string;
        }>(
          'select id,identity_key,user_binding_key,keycloak_identity_key from user_identities where identity_key=$1 or user_binding_key=$2 or keycloak_identity_key=$3 for update',
          [key, userKey, keycloakKey],
        )
      ).rows;
      if (matches.length) {
        const row = matches[0]!;
        if (
          matches.length !== 1 ||
          row.identity_key !== key ||
          row.user_binding_key !== userKey ||
          row.keycloak_identity_key !== keycloakKey
        )
          fail('SAML_MAPPING_CONFLICT');
        return row.id;
      }
      const row = (
        await client.query<{ id: string }>(
          `insert into user_identities(user_id,identity_key,user_binding_key,keycloak_identity_key,idp_issuer,sp_entity_id,
       name_id_format,name_id,name_qualifier,sp_name_qualifier,keycloak_user_id,linked_by)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
          [
            input.userId,
            key,
            userKey,
            keycloakKey,
            binding.issuer,
            binding.entityId,
            input.identity.nameIDFormat,
            input.identity.nameID,
            input.identity.nameQualifier ?? null,
            input.identity.spNameQualifier ?? null,
            input.keycloakUserId,
            input.actorId,
          ],
        )
      ).rows[0]!;
      return row.id;
    },
    'SAML_MAPPING_CONFLICT',
  );
}

export async function beginSamlLogin(
  database: Database,
  binding: SamlProviderBinding,
  returnTo = '/',
) {
  const key = samlConfigurationKey(binding);
  const destination = samlReturnTo(returnTo);
  const requestId = `_${randomBytes(32).toString('hex')}`;
  const relayState = randomBytes(32).toString('base64url');
  const browserNonce = randomBytes(32).toString('base64url');
  return atomic(
    database,
    async (client) => {
      const row = (
        await client.query<TransactionRow>(
          `insert into saml_transactions(kind,request_id,configuration_key,relay_state_hash,browser_nonce_hash,return_to)
       values('login',$1,$2,$3,$4,$5) returning id,request_id,return_to,created_at,expires_at`,
          [requestId, key, hash(relayState), hash(browserNonce), destination],
        )
      ).rows[0]!;
      return {
        requestId,
        relayState,
        browserNonce,
        createdAt: row.created_at.getTime(),
        expiresAt: row.expires_at.getTime(),
      };
    },
    'SAML_TRANSACTION_INVALID',
  );
}

async function transaction(
  client: DatabaseClient,
  key: string,
  browser: SamlBrowserBinding,
  lock: boolean,
  kind: 'login' | 'logout' = 'login',
): Promise<TransactionRow> {
  for (const value of [browser.relayState, browser.browserNonce]) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) fail('SAML_TRANSACTION_INVALID');
  }
  const result = await client.query<TransactionRow>(
    `select id,request_id,return_to,created_at,expires_at from saml_transactions
     where kind=$4 and configuration_key=$1 and relay_state_hash=$2 and browser_nonce_hash=$3
       and consumed_at is null and expires_at>clock_timestamp()${lock ? ' for update' : ''}`,
    [key, hash(browser.relayState), hash(browser.browserNonce), kind],
  );
  if (!result.rows[0]) fail('SAML_TRANSACTION_INVALID');
  return result.rows[0];
}

export async function loadSamlLogin(
  database: Database,
  binding: SamlProviderBinding,
  browser: SamlBrowserBinding,
) {
  const key = samlConfigurationKey(binding);
  return atomic(
    database,
    async (client) => {
      const row = await transaction(client, key, browser, false);
      return {
        requestId: row.request_id,
        createdAt: row.created_at.getTime(),
        expiresAt: row.expires_at.getTime(),
      };
    },
    'SAML_TRANSACTION_INVALID',
  );
}

export async function consumeSamlLogin(
  database: Database,
  binding: SamlProviderBinding,
  browser: SamlBrowserBinding,
  verified: VerifiedSamlLogin,
) {
  const key = samlConfigurationKey(binding);
  const identity = identityKey(binding, verified);
  for (const id of [verified.requestId, verified.responseId, verified.assertionId]) {
    if (!/^[_A-Za-z][_A-Za-z0-9.-]{0,255}$/.test(id)) fail('SAML_INVALID_INPUT');
  }
  text(verified.sessionIndex, 1024);
  if (
    !Number.isSafeInteger(verified.sessionExpiresAt) ||
    !Number.isFinite(new Date(verified.sessionExpiresAt).getTime())
  )
    fail('SAML_INVALID_INPUT');
  if (verified.responseId === verified.assertionId) fail('SAML_REPLAY');
  return atomic(
    database,
    async (client) => {
      const tx = await transaction(client, key, browser, true);
      if (tx.request_id !== verified.requestId) fail('SAML_TRANSACTION_INVALID');
      const candidate = (
        await client.query<{ id: string; user_id: string }>(
          'select id,user_id from user_identities where identity_key=$1',
          [identity],
        )
      ).rows[0];
      if (!candidate) fail('SAML_IDENTITY_UNAVAILABLE');
      // Admin block/delete also locks users first. It must serialize with login.
      const user = (
        await client.query(
          'select id from users where id=$1 and enabled and deleted_at is null for update',
          [candidate.user_id],
        )
      ).rows[0];
      if (!user) fail('SAML_IDENTITY_UNAVAILABLE');
      const active = (
        await client.query<{
          security_epoch: string;
          fresh: boolean | null;
          security_login_after: Date | null;
        }>(
          `select security_epoch,security_login_after,security_checked_at<=clock_timestamp() and security_fresh_until>clock_timestamp() as fresh
       from user_identities where id=$1 and identity_key=$2 and enabled
       and provisioning_state='provisioned' and identity_verified_at<=clock_timestamp() for update`,
          [candidate.id, identity],
        )
      ).rows[0];
      if (!active) fail('SAML_IDENTITY_UNAVAILABLE');
      if (!active.fresh) fail('SAML_SECURITY_UNAVAILABLE');
      if (active.security_login_after && tx.created_at <= active.security_login_after)
        fail('SAML_TRANSACTION_INVALID');
      const idpRevoked = await client.query(
        `select 1 from identity_idp_session_revocations where identity_id=$1 and keycloak_session_hash=$2
         and expires_at>clock_timestamp()`,
        [candidate.id, hash(verified.sessionIndex.split('::')[0]!)],
      );
      if (idpRevoked.rowCount) fail('SAML_TRANSACTION_INVALID');
      const revoked = await client.query(
        `select 1 from saml_session_revocations where identity_id=$1 and session_index_hash=$2
         and revoked_at >= (select created_at from saml_transactions where id=$3) and expires_at>clock_timestamp()`,
        [candidate.id, hash(verified.sessionIndex), tx.id],
      );
      if (revoked.rowCount) fail('SAML_TRANSACTION_INVALID');
      const now = (await client.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]!
        .now;
      const expiresAt = new Date(Math.min(now.getTime() + sessionMs, verified.sessionExpiresAt));
      // Lock waits may cross a deadline; recheck after all identity locks.
      if (
        tx.expires_at <= now ||
        tx.created_at.getTime() + transactionMs < now.getTime() ||
        expiresAt <= now
      )
        fail('SAML_TRANSACTION_INVALID');
      const messages = [
        { kind: 'response', id: hash(verified.responseId) },
        { kind: 'assertion', id: hash(verified.assertionId) },
      ].sort((a, b) => a.id.localeCompare(b.id));
      for (const message of messages) {
        await client.query(
          'insert into saml_message_consumptions(configuration_key,message_id_hash,kind) values($1,$2,$3)',
          [key, message.id, message.kind],
        );
      }
      const sessionToken = randomBytes(32).toString('base64url');
      await client.query(
        `insert into user_sessions(id_hash,user_id,expires_at,created_at,saml_identity_id,saml_session_index,saml_security_epoch,saml_session_not_on_or_after)
       values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          hash(sessionToken),
          candidate.user_id,
          expiresAt,
          now,
          candidate.id,
          verified.sessionIndex,
          active.security_epoch,
          new Date(verified.sessionExpiresAt),
        ],
      );
      const consumed = await client.query(
        `update saml_transactions set consumed_at=clock_timestamp() where id=$1
         and consumed_at is null and expires_at>clock_timestamp() and $2::timestamptz>clock_timestamp()
         and exists(select 1 from user_identities where id=$3 and security_fresh_until>clock_timestamp()) returning id`,
        [tx.id, expiresAt, candidate.id],
      );
      if (consumed.rowCount !== 1) fail('SAML_TRANSACTION_INVALID');
      return {
        sessionToken,
        userId: candidate.user_id,
        identityId: candidate.id,
        expiresAt: expiresAt.getTime(),
        returnTo: tx.return_to,
      };
    },
    'SAML_REPLAY',
  );
}

// Call from bounded maintenance work. Signature validation also limits assertion
// age to five minutes plus one minute skew; ten-minute ID retention exceeds it.
export async function pruneSamlState(database: Database, batchSize = 500) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000)
    fail('SAML_INVALID_INPUT');
  return atomic(
    database,
    async (client) => {
      const transactions = await client.query(
        `delete from saml_transactions where id in
       (select id from saml_transactions where expires_at<=clock_timestamp()
        order by expires_at limit $1 for update skip locked)`,
        [batchSize],
      );
      const messages = await client.query(
        `delete from saml_message_consumptions where (configuration_key,message_id_hash) in
       (select configuration_key,message_id_hash from saml_message_consumptions where expires_at<=clock_timestamp()
        order by expires_at limit $1 for update skip locked)`,
        [batchSize],
      );
      const revocations = await client.query(
        `delete from saml_session_revocations where (identity_id,session_index_hash) in
       (select identity_id,session_index_hash from saml_session_revocations where expires_at<=clock_timestamp()
        order by expires_at limit $1 for update skip locked)`,
        [batchSize],
      );
      return {
        transactions: transactions.rowCount ?? 0,
        messages: messages.rowCount ?? 0,
        revocations: revocations.rowCount ?? 0,
      };
    },
    'SAML_STORAGE_UNAVAILABLE',
  );
}

export async function beginSamlLogout(
  database: Database,
  binding: SamlProviderBinding,
  sessionToken: string,
) {
  const key = samlConfigurationKey(binding);
  if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return null;
  const sessionHash = hash(sessionToken);
  return atomic(
    database,
    async (client) => {
      const candidate = (
        await client.query<{ user_id: string }>(
          'select user_id from user_sessions where id_hash=$1 and expires_at>clock_timestamp()',
          [sessionHash],
        )
      ).rows[0];
      if (!candidate) return null;
      // Match admin block/delete lock order; logout is allowed for disabled users.
      await client.query('select id from users where id=$1 for update', [candidate.user_id]);
      const session = (
        await client.query<{ saml_identity_id: string | null; saml_session_index: string | null }>(
          'delete from user_sessions where id_hash=$1 and user_id=$2 returning saml_identity_id,saml_session_index',
          [sessionHash, candidate.user_id],
        )
      ).rows[0];
      if (!session?.saml_identity_id || !session.saml_session_index) return null;
      const identity = (
        await client.query<{
          name_id: string;
          name_id_format: typeof persistentNameId;
          name_qualifier: string | null;
          sp_name_qualifier: string | null;
        }>(
          'select name_id,name_id_format,name_qualifier,sp_name_qualifier from user_identities where id=$1 and user_id=$2 and idp_issuer=$3 and sp_entity_id=$4',
          [session.saml_identity_id, candidate.user_id, binding.issuer, binding.entityId],
        )
      ).rows[0];
      if (!identity) return null;
      await revokeSamlSessionIndexes(client, session.saml_identity_id, candidate.user_id, [
        session.saml_session_index,
      ]);
      const requestId = `_${randomBytes(32).toString('hex')}`;
      const relayState = randomBytes(32).toString('base64url');
      const browserNonce = randomBytes(32).toString('base64url');
      const tx = (
        await client.query<TransactionRow>(
          `insert into saml_transactions(kind,request_id,configuration_key,relay_state_hash,browser_nonce_hash,return_to,
       logout_identity_id,logout_session_index,logout_session_hash) values('logout',$1,$2,$3,$4,'/login',$5,$6,$7)
       returning id,request_id,return_to,created_at,expires_at`,
          [
            requestId,
            key,
            hash(relayState),
            hash(browserNonce),
            session.saml_identity_id,
            session.saml_session_index,
            sessionHash,
          ],
        )
      ).rows[0]!;
      return {
        requestId,
        relayState,
        browserNonce,
        createdAt: tx.created_at.getTime(),
        expiresAt: tx.expires_at.getTime(),
        identity: {
          issuer: binding.issuer,
          entityId: binding.entityId,
          nameID: identity.name_id,
          nameIDFormat: identity.name_id_format,
          nameQualifier: identity.name_qualifier,
          spNameQualifier: identity.sp_name_qualifier,
          sessionIndex: session.saml_session_index,
        },
      };
    },
    'SAML_TRANSACTION_INVALID',
  );
}

export async function loadSamlLogout(
  database: Database,
  binding: SamlProviderBinding,
  browser: SamlBrowserBinding,
) {
  const key = samlConfigurationKey(binding);
  return atomic(
    database,
    async (client) => {
      const tx = await transaction(client, key, browser, false, 'logout');
      return {
        requestId: tx.request_id,
        createdAt: tx.created_at.getTime(),
        expiresAt: tx.expires_at.getTime(),
      };
    },
    'SAML_TRANSACTION_INVALID',
  );
}

export async function consumeSamlLogout(
  database: Database,
  binding: SamlProviderBinding,
  browser: SamlBrowserBinding,
  verified: { readonly requestId: string; readonly responseId: string },
) {
  const key = samlConfigurationKey(binding);
  for (const id of [verified.requestId, verified.responseId])
    if (!/^[_A-Za-z][_A-Za-z0-9.-]{0,255}$/.test(id)) fail('SAML_INVALID_INPUT');
  return atomic(
    database,
    async (client) => {
      const tx = await transaction(client, key, browser, true, 'logout');
      if (tx.request_id !== verified.requestId) fail('SAML_TRANSACTION_INVALID');
      await client.query(
        "insert into saml_message_consumptions(configuration_key,message_id_hash,kind) values($1,$2,'logout-response')",
        [key, hash(verified.responseId)],
      );
      const result = await client.query(
        'update saml_transactions set consumed_at=clock_timestamp() where id=$1 and consumed_at is null and expires_at>clock_timestamp() returning id',
        [tx.id],
      );
      if (result.rowCount !== 1) fail('SAML_TRANSACTION_INVALID');
      return tx.return_to;
    },
    'SAML_REPLAY',
  );
}

export async function consumeIdpSamlLogout(
  database: Database,
  binding: SamlProviderBinding,
  verified: VerifiedSamlLogoutRequest,
) {
  const key = samlConfigurationKey(binding),
    identity = identityKey(binding, verified);
  if (
    !/^[_A-Za-z][_A-Za-z0-9.-]{0,255}$/.test(verified.requestId) ||
    !Array.isArray(verified.sessionIndexes) ||
    verified.sessionIndexes.length < 1 ||
    verified.sessionIndexes.length > 32 ||
    new Set(verified.sessionIndexes).size !== verified.sessionIndexes.length
  )
    fail('SAML_INVALID_INPUT');
  for (const index of verified.sessionIndexes) text(index, 1024);
  return atomic(
    database,
    async (client) => {
      const candidate = (
        await client.query<{ id: string; user_id: string }>(
          'select id,user_id from user_identities where identity_key=$1',
          [identity],
        )
      ).rows[0];
      if (!candidate) fail('SAML_IDENTITY_UNAVAILABLE');
      await client.query('select id from users where id=$1 for update', [candidate.user_id]);
      const current = await client.query(
        'select id from user_identities where id=$1 and identity_key=$2 for update',
        [candidate.id, identity],
      );
      if (!current.rowCount) fail('SAML_IDENTITY_UNAVAILABLE');
      await client.query(
        "insert into saml_message_consumptions(configuration_key,message_id_hash,kind) values($1,$2,'logout-request')",
        [key, hash(verified.requestId)],
      );
      const deletedSessions = await revokeSamlSessionIndexes(
        client,
        candidate.id,
        candidate.user_id,
        verified.sessionIndexes,
      );
      return { deletedSessions };
    },
    'SAML_REPLAY',
  );
}

async function revokeSamlSessionIndexes(
  client: DatabaseClient,
  identityId: string,
  userId: string,
  indexes: readonly string[],
) {
  for (const indexHash of indexes.map(hash).sort()) {
    await client.query(
      `insert into saml_session_revocations(identity_id,session_index_hash) values($1,$2)
       on conflict(identity_id,session_index_hash) do update set revoked_at=statement_timestamp(),
         expires_at=statement_timestamp()+interval '10 minutes'`,
      [identityId, indexHash],
    );
  }
  const deleted = await client.query(
    'delete from user_sessions where saml_identity_id=$1 and user_id=$2 and saml_session_index=any($3::text[])',
    [identityId, userId, indexes],
  );
  return deleted.rowCount ?? 0;
}
