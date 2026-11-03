import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { persistentNameId, type SamlIdentity } from '../auth/saml-state.js';

export type KeycloakAdminErrorCode =
  | 'IDENTITY_ADMIN_UNAVAILABLE'
  | 'IDENTITY_ADMIN_FORBIDDEN'
  | 'IDENTITY_ADMIN_CREDENTIAL_INVALID'
  | 'IDENTITY_ACCOUNT_CONFLICT'
  | 'IDENTITY_ACCOUNT_NOT_FOUND'
  | 'IDENTITY_PROFILE_INVALID'
  | 'IDENTITY_NAME_ID_UNINITIALIZED'
  | 'IDENTITY_RESULT_UNCONFIRMED'
  | 'IDENTITY_EMAIL_UNCONFIRMED'
  | 'IDENTITY_EMAIL_FAILED';

// Upstream response bodies, exceptions, tokens and profiles never become errors.
export class KeycloakAdminError extends Error {
  constructor(
    readonly code: KeycloakAdminErrorCode,
    readonly retryable = false,
  ) {
    super(code);
    this.name = 'KeycloakAdminError';
  }
}

const hasAsciiControl = (value: string, includeSpace = false) =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= (includeSpace ? 32 : 31) || code === 127;
  });
const boundedText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => !hasAsciiControl(value) && Buffer.from(value).toString('utf8') === value);
const usernameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/);
const identifier = z.string().uuid();
const userSchema = z.object({
  id: identifier,
  username: boundedText(255),
  enabled: z.boolean(),
  email: z.string().email().max(320).optional(),
  emailVerified: z.boolean().optional(),
  firstName: z.string().max(255).optional(),
  lastName: z.string().max(255).optional(),
  attributes: z.record(z.string(), z.array(z.string())).default({}),
  requiredActions: z.array(z.string()).default([]),
  serviceAccountClientId: z.string().optional(),
  federationLink: z.string().optional(),
});
export type KeycloakUser = z.infer<typeof userSchema>;
export interface KeycloakAdminSettings {
  readonly issuer: string;
  readonly entityId: string;
  readonly adminBaseUrl?: string;
  readonly clientId: string;
  readonly clientSecretFile: string;
  readonly timeoutMs?: number;
}
export interface KeycloakCreatePlan {
  readonly operationId: string;
  readonly userId: string;
  readonly username: string;
  readonly email: string;
  readonly displayName: string;
}
export const keycloakAppUserAttribute = 'gcr.identity.user-id';
export const keycloakOperationAttribute = 'gcr.identity.operation-id';
export const keycloakNameIdAttribute = (entityId: string) =>
  `saml.persistent.name.id.for.${entityId}`;
export const plannedKeycloakNameId = (operationId: string) => `G-${identifier.parse(operationId)}`;

export function validateKeycloakAdminSettings(settings: KeycloakAdminSettings) {
  try {
    const issuer = new URL(settings.issuer),
      entity = new URL(settings.entityId);
    const match = /^(.*)\/realms\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(issuer.pathname);
    if (!match || match[2] === 'master') throw Error();
    const admin = new URL(
      settings.adminBaseUrl ?? `${issuer.origin}${match[1]}/admin/realms/${match[2]}`,
    );
    for (const url of [issuer, entity, admin])
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
        throw Error();
    if (
      issuer.href !== settings.issuer ||
      entity.href !== settings.entityId ||
      admin.pathname !== `${match[1]}/admin/realms/${match[2]}` ||
      (settings.adminBaseUrl && admin.href !== settings.adminBaseUrl) ||
      !settings.clientId ||
      settings.clientId.length > 255 ||
      hasAsciiControl(settings.clientId, true) ||
      ['admin-cli', 'security-admin-console'].includes(settings.clientId) ||
      !path.isAbsolute(settings.clientSecretFile) ||
      settings.clientSecretFile.includes('\0') ||
      !Number.isInteger(settings.timeoutMs ?? 10_000) ||
      (settings.timeoutMs ?? 10_000) < 100 ||
      (settings.timeoutMs ?? 10_000) > 10_000
    )
      throw Error();
    return Object.freeze({
      issuer: issuer.href,
      entityId: entity.href,
      adminBaseUrl: admin.href,
      tokenUrl: issuer.href + '/protocol/openid-connect/token',
      realm: match[2]!,
    });
  } catch {
    throw new Error(
      'Invalid configuration: Keycloak administration requires approved HTTPS realm endpoints and a mounted service-account secret',
    );
  }
}

async function secretFile(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw Error();
    const bytes = Buffer.alloc(16 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > 16 * 1024) throw Error();
    const value = new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, length)).trim();
    if (!value || hasAsciiControl(value, true)) throw Error();
    return value;
  } finally {
    await handle.close();
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (
    !response.body ||
    !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')
  ) {
    await response.body?.cancel();
    throw Error();
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 512 * 1024) throw Error();
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export class KeycloakAdminClient {
  readonly endpoints: ReturnType<typeof validateKeycloakAdminSettings>;
  private token: { value: string; until: number } | undefined;
  private tokenPending: Promise<string> | undefined;
  private requestGuard: (() => void) | undefined;
  constructor(
    protected readonly settings: KeycloakAdminSettings,
    private readonly request: typeof fetch = fetch,
  ) {
    this.endpoints = validateKeycloakAdminSettings(settings);
  }
  async withRequestGuard<T>(guard: () => void, action: () => Promise<T>): Promise<T> {
    if (this.requestGuard) throw new KeycloakAdminError('IDENTITY_ADMIN_UNAVAILABLE', true);
    this.requestGuard = guard;
    try {
      guard();
      return await action();
    } finally {
      this.requestGuard = undefined;
    }
  }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    if (this.tokenPending) return this.tokenPending;
    this.tokenPending = (async () => {
      try {
        const secret = await secretFile(this.settings.clientSecretFile);
        this.requestGuard?.();
        const response = await this.request(this.endpoints.tokenUrl, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(this.settings.timeoutMs ?? 10_000),
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: this.settings.clientId,
            client_secret: secret,
          }).toString(),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new KeycloakAdminError(
            response.status >= 500 || response.status === 429
              ? 'IDENTITY_ADMIN_UNAVAILABLE'
              : 'IDENTITY_ADMIN_CREDENTIAL_INVALID',
            response.status >= 500 || response.status === 429,
          );
        }
        const token = z
          .object({
            access_token: boundedText(64 * 1024),
            token_type: z.string().regex(/^bearer$/i),
            expires_in: z.number().positive().max(86400),
          })
          .parse(await boundedJson(response));
        this.token = {
          value: token.access_token,
          until: Date.now() + Math.min(60_000, Math.max(0, token.expires_in * 1000 - 10_000)),
        };
        return token.access_token;
      } catch (error) {
        if (error instanceof KeycloakAdminError) throw error;
        throw new KeycloakAdminError('IDENTITY_ADMIN_UNAVAILABLE', true);
      }
    })();
    try {
      return await this.tokenPending;
    } finally {
      this.tokenPending = undefined;
    }
  }
  protected async freshAccessToken(): Promise<string> {
    if (this.tokenPending) await this.tokenPending;
    this.token = undefined;
    return this.accessToken();
  }
  protected async call(
    method: 'GET' | 'POST' | 'PUT',
    route: string,
    body?: unknown,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken();
      let response: Response;
      try {
        this.requestGuard?.();
        response = await this.request(this.endpoints.adminBaseUrl + route, {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(this.settings.timeoutMs ?? 10_000),
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        throw new KeycloakAdminError(
          method === 'GET' ? 'IDENTITY_ADMIN_UNAVAILABLE' : 'IDENTITY_RESULT_UNCONFIRMED',
          method === 'GET',
        );
      }
      try {
        this.requestGuard?.();
      } catch {
        await response.body?.cancel();
        throw new KeycloakAdminError(
          method === 'GET' ? 'IDENTITY_ADMIN_UNAVAILABLE' : 'IDENTITY_RESULT_UNCONFIRMED',
          method === 'GET',
        );
      }
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        this.token = undefined;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401)
          throw new KeycloakAdminError('IDENTITY_ADMIN_CREDENTIAL_INVALID');
        if (response.status === 403) throw new KeycloakAdminError('IDENTITY_ADMIN_FORBIDDEN');
        if (response.status === 404) throw new KeycloakAdminError('IDENTITY_ACCOUNT_NOT_FOUND');
        if (response.status === 409) throw new KeycloakAdminError('IDENTITY_ACCOUNT_CONFLICT');
        if (response.status === 400) throw new KeycloakAdminError('IDENTITY_PROFILE_INVALID');
        throw new KeycloakAdminError(
          method === 'GET' ? 'IDENTITY_ADMIN_UNAVAILABLE' : 'IDENTITY_RESULT_UNCONFIRMED',
          method === 'GET',
        );
      }
      if (response.status === 201 || response.status === 204) {
        await response.body?.cancel();
        return null;
      }
      try {
        return await boundedJson(response);
      } catch {
        throw new KeycloakAdminError(
          method === 'GET' ? 'IDENTITY_ADMIN_UNAVAILABLE' : 'IDENTITY_RESULT_UNCONFIRMED',
          method === 'GET',
        );
      }
    }
    throw new KeycloakAdminError('IDENTITY_ADMIN_CREDENTIAL_INVALID');
  }
  private user(value: unknown): KeycloakUser {
    const result = userSchema.safeParse(value);
    if (!result.success || result.data.serviceAccountClientId || result.data.federationLink)
      throw new KeycloakAdminError('IDENTITY_PROFILE_INVALID');
    return result.data;
  }
  private async assertHumanAccount(user: KeycloakUser): Promise<void> {
    // Keycloak 26.7.3 omits serviceAccountClientId from GET /users/{id}.
    // Its ordinary free-text search excludes service accounts, whereas the
    // username/exact search includes them. Require positive membership in the
    // former, never infer an account type from an absent field or username.
    const value = await this.call(
      'GET',
      `/users?${new URLSearchParams({
        search: `"${user.username}"`,
        briefRepresentation: 'true',
        max: '100',
      })}`,
    );
    const result = z
      .array(z.object({ id: identifier }))
      .max(100)
      .safeParse(value);
    if (!result.success || !result.data.some((entry) => entry.id === user.id))
      throw new KeycloakAdminError('IDENTITY_PROFILE_INVALID');
  }
  async getUser(userId: string): Promise<KeycloakUser> {
    if (!identifier.safeParse(userId).success)
      throw new KeycloakAdminError('IDENTITY_PROFILE_INVALID');
    const user = this.user(await this.call('GET', `/users/${userId}`));
    if (user.id !== userId) throw new KeycloakAdminError('IDENTITY_PROFILE_INVALID');
    await this.assertHumanAccount(user);
    return user;
  }
  private async findUsername(username: string): Promise<KeycloakUser | null> {
    const value = await this.call(
      'GET',
      `/users?${new URLSearchParams({ username, exact: 'true', briefRepresentation: 'false', max: '2' })}`,
    );
    if (!Array.isArray(value) || value.length > 1)
      throw new KeycloakAdminError('IDENTITY_ACCOUNT_CONFLICT');
    if (!value.length) return null;
    const user = this.user(value[0]);
    if (user.username !== username) throw new KeycloakAdminError('IDENTITY_ACCOUNT_CONFLICT');
    await this.assertHumanAccount(user);
    return user;
  }
  identity(user: KeycloakUser): SamlIdentity {
    const values = user.attributes[keycloakNameIdAttribute(this.endpoints.entityId)];
    if (!values || values.length !== 1 || !boundedText(4096).safeParse(values[0]).success)
      throw new KeycloakAdminError('IDENTITY_NAME_ID_UNINITIALIZED');
    return Object.freeze({
      issuer: this.endpoints.issuer,
      entityId: this.endpoints.entityId,
      nameID: values[0]!,
      nameIDFormat: persistentNameId,
      nameQualifier: null,
      spNameQualifier: null,
    });
  }
  private matchesPlan(user: KeycloakUser, plan: KeycloakCreatePlan): KeycloakUser {
    const expected = {
      [keycloakAppUserAttribute]: plan.userId,
      [keycloakOperationAttribute]: plan.operationId,
      [keycloakNameIdAttribute(this.endpoints.entityId)]: plannedKeycloakNameId(plan.operationId),
    };
    if (
      user.username !== plan.username ||
      user.email !== plan.email ||
      user.firstName !== plan.displayName ||
      Object.entries(expected).some(
        ([key, value]) => user.attributes[key]?.length !== 1 || user.attributes[key]?.[0] !== value,
      )
    )
      throw new KeycloakAdminError('IDENTITY_ACCOUNT_CONFLICT');
    return user;
  }
  async ensureCreated(plan: KeycloakCreatePlan): Promise<KeycloakUser> {
    const valid = z
      .object({
        operationId: identifier,
        userId: identifier,
        username: usernameSchema,
        email: z.string().email().max(320),
        displayName: boundedText(120),
      })
      .strict()
      .safeParse(plan);
    if (!valid.success) throw new KeycloakAdminError('IDENTITY_PROFILE_INVALID');
    const existing = await this.findUsername(plan.username);
    if (existing) return this.matchesPlan(existing, plan);
    let uncertain: KeycloakAdminError | undefined;
    try {
      await this.call('POST', '/users', {
        username: plan.username,
        email: plan.email,
        firstName: plan.displayName,
        enabled: false,
        emailVerified: false,
        requiredActions: ['VERIFY_EMAIL', 'UPDATE_PASSWORD'],
        attributes: {
          [keycloakAppUserAttribute]: [plan.userId],
          [keycloakOperationAttribute]: [plan.operationId],
          [keycloakNameIdAttribute(this.endpoints.entityId)]: [
            plannedKeycloakNameId(plan.operationId),
          ],
        },
      });
    } catch (error) {
      if (
        !(error instanceof KeycloakAdminError) ||
        !['IDENTITY_RESULT_UNCONFIRMED', 'IDENTITY_ACCOUNT_CONFLICT'].includes(error.code)
      )
        throw error;
      uncertain = error;
    }
    // Never treat username/email equality as identity proof. A lost create
    // response is reconciled only against both operation and app-user markers.
    const created = await this.findUsername(plan.username);
    if (!created) throw uncertain ?? new KeycloakAdminError('IDENTITY_RESULT_UNCONFIRMED');
    return this.matchesPlan(created, plan);
  }
  async setEnabled(userId: string, enabled: boolean): Promise<KeycloakUser> {
    await this.getUser(userId);
    await this.call('PUT', `/users/${userId}`, { enabled });
    const user = await this.getUser(userId);
    if (user.enabled !== enabled) throw new KeycloakAdminError('IDENTITY_RESULT_UNCONFIRMED');
    return user;
  }
  async logoutAll(userId: string): Promise<void> {
    await this.getUser(userId);
    await this.call('POST', `/users/${userId}/logout`);
  }
  async sendActionsEmail(
    userId: string,
    expectedEmail: string,
    kind: 'invite' | 'password-reset',
  ): Promise<void> {
    const user = await this.getUser(userId);
    if (
      !user.enabled ||
      user.email !== expectedEmail ||
      !z.string().email().max(320).safeParse(expectedEmail).success
    )
      throw new KeycloakAdminError('IDENTITY_PROFILE_INVALID');
    try {
      // No redirect/client URL is accepted from callers. The action page remains
      // on Keycloak and no password or action token passes through GCR storage.
      await this.call(
        'PUT',
        `/users/${userId}/execute-actions-email?lifespan=1800`,
        kind === 'invite' ? ['VERIFY_EMAIL', 'UPDATE_PASSWORD'] : ['UPDATE_PASSWORD'],
      );
    } catch (error) {
      if (error instanceof KeycloakAdminError && error.code === 'IDENTITY_RESULT_UNCONFIRMED')
        throw new KeycloakAdminError('IDENTITY_EMAIL_UNCONFIRMED');
      if (
        error instanceof KeycloakAdminError &&
        [
          'IDENTITY_ADMIN_FORBIDDEN',
          'IDENTITY_ADMIN_CREDENTIAL_INVALID',
          'IDENTITY_ADMIN_UNAVAILABLE',
        ].includes(error.code)
      )
        throw error;
      throw new KeycloakAdminError('IDENTITY_EMAIL_FAILED');
    }
  }
}
