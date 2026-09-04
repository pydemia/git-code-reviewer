import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import cookie from '@fastify/cookie';
import type { Database } from '@gcr/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { importSPKI, jwtVerify } from 'jose';
import * as oidc from 'openid-client';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import {
  assertLocalUsername,
  hashLocalPassword,
  normalizeLocalUsername,
  verifyLocalPassword,
} from '../services/local-accounts.js';

export type AuthUser = {
  id: string;
  subject: string;
  displayName: string;
  role: 'reviewer' | 'administrator';
  groups: string[];
  enabled: boolean;
  tenantIds: string[];
  tenants: Array<{ id: string; slug: string; displayName: string }>;
};

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

const sessionCookie = 'gcr_session';
const transactionCookie = 'gcr_oidc_tx';
const sessionTtlSeconds = 8 * 60 * 60;
const localLoginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
  returnTo: z.string().optional(),
});
const unavailablePasswordHash = hashLocalPassword('unavailable local account credential');

export async function registerAuthentication(
  app: FastifyInstance,
  config: AppConfig,
  database: Database,
): Promise<void> {
  await app.register(cookie, { secret: config.SESSION_SECRET, hook: 'onRequest' });
  app.decorateRequest('user', null);

  if (config.AUTH_MODE === 'local') await bootstrapLocalAccounts(database, config);

  let developmentUser: Promise<AuthUser> | undefined;
  let oidcConfiguration: Promise<oidc.Configuration> | undefined;
  let proxyPublicKey: ReturnType<typeof importSPKI> | undefined;

  app.addHook('preHandler', async (request) => {
    if (request.url.startsWith('/health/')) return;
    if (config.AUTH_MODE === 'development') {
      developmentUser ??= upsertUser(
        database,
        {
          subject: config.DEV_USER_SUBJECT,
          displayName: config.DEV_USER_NAME,
          role: config.DEV_USER_ROLE === 'admin' ? 'administrator' : config.DEV_USER_ROLE,
          groups: [],
        },
        config,
      );
      const user = await developmentUser;
      request.user = user.enabled ? user : null;
      return;
    }

    if (config.AUTH_MODE === 'proxy') {
      const assertion = request.headers['x-gcr-identity-assertion'];
      if (typeof assertion !== 'string') return;
      proxyPublicKey ??= readFile(config.PROXY_IDENTITY_PUBLIC_KEY_FILE!, 'utf8').then((key) =>
        importSPKI(key, 'RS256'),
      );
      const { payload } = await jwtVerify(assertion, await proxyPublicKey, {
        issuer: config.PROXY_IDENTITY_ISSUER!,
        audience: config.PROXY_IDENTITY_AUDIENCE,
        algorithms: ['RS256'],
      });
      if (!payload.sub) return;
      const groups = Array.isArray(payload.groups)
        ? payload.groups.filter((group): group is string => typeof group === 'string')
        : [];
      const user = await upsertUser(
        database,
        {
          subject: payload.sub,
          displayName: typeof payload.name === 'string' ? payload.name : payload.sub,
          role: resolveIdentityRole(payload, groups, config),
          groups,
        },
        config,
      );
      request.user = user.enabled ? user : null;
      return;
    }

    const token = request.cookies[sessionCookie];
    if (!token) return;
    request.user = await findSessionUser(database, token);
  });

  app.get('/auth/login', async (request, reply) => {
    if (config.AUTH_MODE === 'development' || config.AUTH_MODE === 'proxy') {
      return reply.redirect(safeReturnTo(request.query));
    }
    if (config.AUTH_MODE === 'local') {
      return reply.redirect(`/login?returnTo=${encodeURIComponent(safeReturnTo(request.query))}`);
    }

    oidcConfiguration ??= oidc.discovery(
      new URL(config.OIDC_ISSUER!),
      config.OIDC_CLIENT_ID!,
      config.OIDC_CLIENT_SECRET!,
    );
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const transaction = await database.query<{ id: string }>(
      `insert into auth_transactions(state_hash, nonce, code_verifier, return_to, expires_at)
       values ($1, $2, $3, $4, clock_timestamp() + interval '10 minutes') returning id`,
      [hash(state), nonce, verifier, safeReturnTo(request.query)],
    );
    setCookie(reply, transactionCookie, transaction.rows[0]!.id, config, 10 * 60, true);
    const authorizationUrl = oidc.buildAuthorizationUrl(await oidcConfiguration, {
      redirect_uri: config.OIDC_REDIRECT_URI!,
      scope: 'openid profile email groups',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return reply.redirect(authorizationUrl.toString());
  });

  app.get('/auth/callback', async (request, reply) => {
    if (config.AUTH_MODE !== 'oidc') return reply.redirect('/');
    const signedCookie = request.cookies[transactionCookie];
    const transactionId = signedCookie ? request.unsignCookie(signedCookie) : null;
    if (!transactionId?.valid) return reply.code(400).send({ error: 'Invalid login transaction' });
    const transaction = await database.query<{
      state_hash: string;
      nonce: string;
      code_verifier: string;
      return_to: string;
    }>(
      `delete from auth_transactions
       where id = $1 and expires_at > clock_timestamp()
       returning state_hash, nonce, code_verifier, return_to`,
      [transactionId.value],
    );
    const row = transaction.rows[0];
    const query = request.query as Record<string, unknown>;
    if (!row || typeof query.state !== 'string' || hash(query.state) !== row.state_hash) {
      return reply.code(400).send({ error: 'Invalid login state' });
    }

    oidcConfiguration ??= oidc.discovery(
      new URL(config.OIDC_ISSUER!),
      config.OIDC_CLIENT_ID!,
      config.OIDC_CLIENT_SECRET!,
    );
    const callbackUrl = new URL(config.OIDC_REDIRECT_URI!);
    for (const [name, value] of Object.entries(query)) {
      if (typeof value === 'string') callbackUrl.searchParams.set(name, value);
    }
    const tokens = await oidc.authorizationCodeGrant(await oidcConfiguration, callbackUrl, {
      pkceCodeVerifier: row.code_verifier,
      expectedState: query.state,
      expectedNonce: row.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims?.sub) return reply.code(401).send({ error: 'OIDC subject is missing' });
    const groups = Array.isArray(claims.groups)
      ? claims.groups.filter((group): group is string => typeof group === 'string')
      : [];
    const user = await upsertUser(
      database,
      {
        subject: claims.sub,
        displayName:
          typeof claims.name === 'string'
            ? claims.name
            : typeof claims.preferred_username === 'string'
              ? claims.preferred_username
              : claims.sub,
        role: resolveIdentityRole(claims, groups, config),
        groups,
      },
      config,
    );
    if (!user.enabled) return reply.code(403).send({ error: 'Application access is disabled' });
    const token = randomBytes(32).toString('base64url');
    await database.query(
      `insert into user_sessions(id_hash, user_id, expires_at)
       values ($1, $2, clock_timestamp() + interval '8 hours')`,
      [hash(token), user.id],
    );
    setCookie(reply, sessionCookie, token, config, sessionTtlSeconds);
    reply.clearCookie(transactionCookie, { path: '/auth' });
    return reply.redirect(row.return_to);
  });

  app.post('/auth/local/login', async (request, reply) => {
    if (config.AUTH_MODE !== 'local') {
      return reply.code(404).send({ error: 'Local login is unavailable' });
    }
    const body = localLoginBody.parse(request.body);
    await database.query(
      `delete from local_login_limits
       where updated_at < clock_timestamp() - interval '1 day'`,
    );
    const username = normalizeLocalUsername(body.username);
    const usernameHash = hash(username);
    const limited = await localLoginLimited(database, usernameHash);
    const result = await database.query<{
      userId: string;
      passwordHash: string;
      enabled: boolean;
    }>(
      `select credential.user_id as "userId", credential.password_hash as "passwordHash",
              app_user.enabled
       from local_credentials credential join users app_user on app_user.id = credential.user_id
       where credential.username = $1`,
      [username],
    );
    const credential = result.rows[0];
    const valid = await verifyLocalPassword(
      body.password,
      credential?.passwordHash ?? (await unavailablePasswordHash),
    );
    if (limited || !credential?.enabled || !valid) {
      await recordLocalLoginFailure(database, usernameHash);
      return reply.code(401).send({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: '사용자 이름 또는 비밀번호가 올바르지 않습니다.',
          requestId: request.id,
          retryable: false,
        },
      });
    }
    await database.query('delete from local_login_limits where username_hash = $1', [usernameHash]);
    await database.query('delete from user_sessions where expires_at <= clock_timestamp()');
    const token = randomBytes(32).toString('base64url');
    await database.query(
      `insert into user_sessions(id_hash, user_id, expires_at)
       values ($1, $2, clock_timestamp() + interval '8 hours')`,
      [hash(token), credential.userId],
    );
    setCookie(reply, sessionCookie, token, config, sessionTtlSeconds);
    await database.query(
      `insert into audit_events(actor, action, resource_type, resource_id, outcome, request_id)
       values ($1, 'auth.login', 'user', $2, 'success', $3)`,
      [`local:${username}`, credential.userId, request.id],
    );
    return { returnTo: safeReturnTo({ returnTo: body.returnTo }) };
  });

  app.post('/auth/logout', async (request, reply) => {
    const token = request.cookies[sessionCookie];
    if (token) await database.query('delete from user_sessions where id_hash = $1', [hash(token)]);
    reply.clearCookie(sessionCookie, { path: '/' });
    return reply.code(204).send();
  });
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  if (request.user) return;
  return reply.code(401).send({
    error: {
      code: 'AUTHENTICATION_REQUIRED',
      message: '로그인이 필요합니다.',
      requestId: request.id,
      retryable: false,
    },
  });
}

export async function requireAdministrator(request: FastifyRequest, reply: FastifyReply) {
  if (request.user?.role === 'administrator') return;
  return reply.code(404).send({
    error: {
      code: 'RESOURCE_NOT_FOUND',
      message: '리소스를 찾을 수 없습니다.',
      requestId: request.id,
      retryable: false,
    },
  });
}

async function upsertUser(
  database: Database,
  user: Pick<AuthUser, 'subject' | 'displayName' | 'role' | 'groups'>,
  config: AppConfig,
): Promise<AuthUser> {
  const result = await database.query<{
    id: string;
    oidc_subject: string;
    display_name: string;
    role: 'reviewer' | 'administrator';
    groups_json: string[];
    enabled: boolean;
  }>(
    `insert into users(oidc_subject, display_name, role, groups_json)
     values ($1, $2, $3, $4::jsonb)
     on conflict (oidc_subject) do update set
       display_name = excluded.display_name,
       role = excluded.role,
       groups_json = excluded.groups_json,
       updated_at = clock_timestamp()
     returning id, oidc_subject, display_name, role, groups_json, enabled`,
    [user.subject, user.displayName, user.role, JSON.stringify(user.groups)],
  );
  const row = result.rows[0]!;
  if (config.AUTO_JOIN_DEFAULT_TENANT) {
    await database.query(
      `insert into tenant_memberships(tenant_id, user_id)
       select id, $1 from tenants where slug = $2 and enabled
       on conflict (tenant_id, user_id) do nothing`,
      [row.id, config.DEFAULT_TENANT_SLUG],
    );
  }
  return hydrateUser(database, {
    id: row.id,
    subject: row.oidc_subject,
    displayName: row.display_name,
    role: row.role,
    groups: row.groups_json,
    enabled: row.enabled,
  });
}

async function findSessionUser(database: Database, token: string): Promise<AuthUser | null> {
  const result = await database.query<{
    id: string;
    oidc_subject: string;
    display_name: string;
    role: 'reviewer' | 'administrator';
    groups_json: string[];
    enabled: boolean;
  }>(
    `update user_sessions s set last_seen_at = clock_timestamp()
     from users u
     where s.id_hash = $1 and s.expires_at > clock_timestamp() and u.id = s.user_id and u.enabled
     returning u.id, u.oidc_subject, u.display_name, u.role, u.groups_json, u.enabled`,
    [hash(token)],
  );
  const row = result.rows[0];
  return row
    ? hydrateUser(database, {
        id: row.id,
        subject: row.oidc_subject,
        displayName: row.display_name,
        role: row.role,
        groups: row.groups_json,
        enabled: row.enabled,
      })
    : null;
}

async function hydrateUser(
  database: Database,
  user: Omit<AuthUser, 'tenantIds' | 'tenants'>,
): Promise<AuthUser> {
  const result = await database.query<{ id: string; slug: string; displayName: string }>(
    user.role === 'administrator'
      ? `select id, slug, display_name as "displayName" from tenants
         where enabled order by display_name, id`
      : `select tenant.id, tenant.slug, tenant.display_name as "displayName"
         from tenant_memberships membership join tenants tenant on tenant.id = membership.tenant_id
         where membership.user_id = $1 and membership.enabled and tenant.enabled
         order by tenant.display_name, tenant.id`,
    user.role === 'administrator' ? [] : [user.id],
  );
  return {
    ...user,
    tenantIds: result.rows.map((tenant) => tenant.id),
    tenants: result.rows,
  };
}

export function resolveIdentityRole(
  claims: Record<string, unknown>,
  groups: string[],
  config: Pick<AppConfig, 'OIDC_CLIENT_ID' | 'OIDC_ADMIN_ROLE' | 'OIDC_ADMIN_GROUP'>,
): 'reviewer' | 'administrator' {
  const realmAccess = objectValue(claims.realm_access);
  const resourceAccess = objectValue(claims.resource_access);
  const clientAccess = objectValue(resourceAccess?.[config.OIDC_CLIENT_ID ?? '']);
  const roles = [...stringArray(realmAccess?.roles), ...stringArray(clientAccess?.roles)];
  return roles.includes(config.OIDC_ADMIN_ROLE) || groups.includes(config.OIDC_ADMIN_GROUP)
    ? 'administrator'
    : 'reviewer';
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function setCookie(
  reply: FastifyReply,
  name: string,
  value: string,
  config: AppConfig,
  maxAge: number,
  signed = false,
) {
  reply.setCookie(name, value, {
    path: name === transactionCookie ? '/auth' : '/',
    httpOnly: true,
    secure: config.PUBLIC_BASE_URL
      ? new URL(config.PUBLIC_BASE_URL).protocol === 'https:'
      : config.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge,
    signed,
  });
}

async function bootstrapLocalAccounts(database: Database, config: AppConfig): Promise<void> {
  await bootstrapLocalAccount(
    database,
    config,
    config.LOCAL_BOOTSTRAP_ADMIN_USERNAME!,
    config.LOCAL_BOOTSTRAP_ADMIN_PASSWORD!,
    config.LOCAL_BOOTSTRAP_ADMIN_NAME,
    'administrator',
  );
  if (config.LOCAL_BOOTSTRAP_REVIEWER_USERNAME && config.LOCAL_BOOTSTRAP_REVIEWER_PASSWORD) {
    await bootstrapLocalAccount(
      database,
      config,
      config.LOCAL_BOOTSTRAP_REVIEWER_USERNAME,
      config.LOCAL_BOOTSTRAP_REVIEWER_PASSWORD,
      config.LOCAL_BOOTSTRAP_REVIEWER_NAME,
      'reviewer',
    );
  }
}

async function bootstrapLocalAccount(
  database: Database,
  config: AppConfig,
  usernameValue: string,
  password: string,
  displayName: string,
  role: 'reviewer' | 'administrator',
): Promise<void> {
  const username = assertLocalUsername(usernameValue);
  const passwordHash = await hashLocalPassword(password);
  const connection = await database.connect();
  try {
    await connection.query('begin');
    const user = await connection.query<{ id: string }>(
      `insert into users(oidc_subject, display_name, role)
       values ($1, $2, $3)
       on conflict (oidc_subject) do update set updated_at = users.updated_at
       returning id`,
      [`local:${username}`, displayName, role],
    );
    await connection.query(
      `insert into local_credentials(user_id, username, password_hash)
       values ($1, $2, $3) on conflict (user_id) do nothing`,
      [user.rows[0]!.id, username, passwordHash],
    );
    if (config.AUTO_JOIN_DEFAULT_TENANT) {
      await connection.query(
        `insert into tenant_memberships(tenant_id, user_id)
         select id, $1 from tenants where slug = $2 and enabled
         on conflict (tenant_id, user_id) do nothing`,
        [user.rows[0]!.id, config.DEFAULT_TENANT_SLUG],
      );
    }
    await connection.query('commit');
  } catch (error) {
    await connection.query('rollback');
    throw error;
  } finally {
    connection.release();
  }
}

async function localLoginLimited(database: Database, usernameHash: string): Promise<boolean> {
  const result = await database.query<{ limited: boolean }>(
    `select coalesce(locked_until > clock_timestamp(), false) as limited
     from local_login_limits where username_hash = $1`,
    [usernameHash],
  );
  return result.rows[0]?.limited ?? false;
}

async function recordLocalLoginFailure(database: Database, usernameHash: string): Promise<void> {
  await database.query(
    `insert into local_login_limits(username_hash, failed_count)
     values ($1, 1)
     on conflict (username_hash) do update set
       failed_count = case
         when local_login_limits.window_started_at < clock_timestamp() - interval '15 minutes'
           then 1
         else local_login_limits.failed_count + 1
       end,
       window_started_at = case
         when local_login_limits.window_started_at < clock_timestamp() - interval '15 minutes'
           then clock_timestamp()
         else local_login_limits.window_started_at
       end,
       locked_until = case
         when (
           case
             when local_login_limits.window_started_at < clock_timestamp() - interval '15 minutes'
               then 1
             else local_login_limits.failed_count + 1
           end
         ) >= 5 then clock_timestamp() + interval '15 minutes'
         else local_login_limits.locked_until
       end,
       updated_at = clock_timestamp()`,
    [usernameHash],
  );
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeReturnTo(query: unknown): string {
  const value =
    typeof query === 'object' && query !== null && 'returnTo' in query
      ? (query as { returnTo?: unknown }).returnTo
      : '/';
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    ? value
    : '/';
}
