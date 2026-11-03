import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { KeycloakAdminClient, KeycloakAdminError } from './keycloak-admin.js';

export const requiredSecurityEventTypes = [
  'CLIENT_LOGIN',
  'LOGIN',
  'LOGOUT',
  'UPDATE_PASSWORD',
  'RESET_PASSWORD',
  'UPDATE_CREDENTIAL',
  'REMOVE_CREDENTIAL',
  'UPDATE_TOTP',
  'REMOVE_TOTP',
  'DELETE_ACCOUNT',
  'FEDERATED_IDENTITY_LINK',
  'REMOVE_FEDERATED_IDENTITY',
  'FEDERATED_IDENTITY_OVERRIDE_LINK',
  'IDENTITY_PROVIDER_LINK_ACCOUNT',
  'UPDATE_EMAIL',
  'USER_DISABLED_BY_PERMANENT_LOCKOUT',
  'USER_DISABLED_BY_TEMPORARY_LOCKOUT',
  'USER_SESSION_DELETED',
] as const;
const uuid = z.string().uuid();
const text = z.string().min(1).max(1024);
const time = z.number().int().nonnegative().safe();
const anchorSchema = z.object({ id: uuid, time });
const userEventSchema = anchorSchema.extend({
  realmId: text,
  type: text,
  clientId: text.optional(),
  userId: uuid.optional(),
  // Keycloak 26.7.3 uses 24-character opaque session IDs, not user UUIDs.
  sessionId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,128}$/)
    .optional(),
  error: text.optional(),
  details: z.record(z.string(), z.string()).optional(),
});
const adminEventSchema = anchorSchema.extend({
  realmId: text,
  operationType: text,
  resourceType: text,
  resourcePath: text.optional(),
  error: text.optional(),
  authDetails: z.object({ userId: uuid.optional() }).optional(),
  representation: z.null().optional(),
});
const eventConfigurationSchema = z.object({
  eventsEnabled: z.literal(true),
  eventsExpiration: z.number().int().min(3600),
  enabledEventTypes: z.array(text).max(512),
  adminEventsEnabled: z.literal(true),
  adminEventsDetailsEnabled: z.literal(false),
});
export type SecurityAnchor = z.infer<typeof anchorSchema>;
export interface SecurityCheckpoint {
  readonly realmId: string;
  readonly configurationHash: string;
  readonly security: SecurityAnchor;
  readonly administration: SecurityAnchor;
  readonly observedAt: number;
}
export interface IdentitySecurityEvent {
  readonly id: string;
  readonly time: number;
  readonly stream: 'security' | 'administration';
  readonly kind: 'logout-session' | 'revoke-identity' | 'revoke-provider';
  readonly userId?: string;
  readonly sessionId?: string;
  readonly remoteLogoutConfirmed?: boolean;
  readonly ownAdministration?: true;
  readonly administrationAction?: 'update-user' | 'logout-user' | 'other';
}
export interface SecurityObservation {
  readonly checkpoint: SecurityCheckpoint;
  readonly continuity: 'baseline' | 'continuous' | 'gap';
  readonly events: readonly IdentitySecurityEvent[];
}
export type SecurityObservationFailure =
  | 'IDENTITY_EVENT_CONFIGURATION_INVALID'
  | 'IDENTITY_EVENT_BATCH_INCOMPLETE'
  | 'IDENTITY_EVENT_PROBE_UNCONFIRMED';
export class KeycloakSecurityError extends Error {
  constructor(
    readonly code: SecurityObservationFailure,
    readonly reason?:
      | 'security-schema'
      | 'admin-schema'
      | 'bounds'
      | 'realm'
      | 'missing-anchor'
      | 'unscoped-logout',
  ) {
    super(code);
    this.name = 'KeycloakSecurityError';
  }
}
const fail = (
  code: SecurityObservationFailure,
  reason?: KeycloakSecurityError['reason'],
): never => {
  throw new KeycloakSecurityError(code, reason);
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const batchLimit = 500;
const windowMs = 5 * 60_000;
// The companion deployment must bound Keycloak transactions to five minutes.
// Revisit that entire interval in addition to the freshness window so events
// timestamped before a delayed commit can still be applied exactly once.
const overlapMs = 5 * 60_000;
const maximumCaptureMs = 60_000;
const maximumClockSkewMs = 30_000;

// REST timestamps are not durable offsets. Read a complete bounded overlap on
// every pass, retain IDs of both write probes, and deduplicate effects in SQL.
// The pinned Keycloak JPA store and transaction/clock bounds are deployment
// prerequisites. A successful profile read alone never establishes continuity.
export class KeycloakSecurityClient extends KeycloakAdminClient {
  private async eventConfiguration(): Promise<string> {
    const result = eventConfigurationSchema.safeParse(await this.call('GET', '/events/config'));
    if (
      !result.success ||
      requiredSecurityEventTypes.some((type) => !result.data.enabledEventTypes.includes(type))
    )
      return fail('IDENTITY_EVENT_CONFIGURATION_INVALID');
    return hash(
      JSON.stringify({
        ...result.data,
        enabledEventTypes: [...new Set(result.data.enabledEventTypes)].sort(),
      }),
    );
  }

  async capture(previous?: SecurityCheckpoint): Promise<SecurityObservation> {
    const observedAt = Date.now();
    // Only the TLS-issued service token is decoded, solely to correlate our own
    // CLIENT_LOGIN event. No user authentication decision trusts decoded claims.
    let claims: { iss: string; sub: string; azp: string; jti: string; iat: number };
    try {
      const token = await this.freshAccessToken();
      const parts = token.split('.');
      if (parts.length !== 3) return fail('IDENTITY_EVENT_PROBE_UNCONFIRMED');
      claims = z
        .object({ iss: text, sub: uuid, azp: text, jti: text, iat: time })
        .parse(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')));
      if (
        claims.iss !== this.settings.issuer ||
        claims.azp !== this.settings.clientId ||
        Math.abs(claims.iat * 1000 - observedAt) > maximumClockSkewMs
      )
        return fail('IDENTITY_EVENT_PROBE_UNCONFIRMED');
    } catch (error) {
      // Preserve only our static adapter errors, never a JWT/parser exception.
      if (error instanceof KeycloakAdminError) throw error;
      return fail('IDENTITY_EVENT_PROBE_UNCONFIRMED');
    }
    const configurationHash = await this.eventConfiguration();
    const from = observedAt - windowMs - overlapMs - maximumClockSkewMs;
    const read = async () => {
      const query = `?${new URLSearchParams({ dateFrom: String(from), max: String(batchLimit + 1), direction: 'asc' })}`;
      const [securityValue, administrationValue] = await Promise.all([
        this.call('GET', '/events' + query),
        this.call('GET', '/admin-events' + query),
      ]);
      const security = z.array(userEventSchema).max(batchLimit).safeParse(securityValue);
      const administration = z
        .array(adminEventSchema)
        .max(batchLimit)
        .safeParse(administrationValue);
      if (!security.success) return fail('IDENTITY_EVENT_BATCH_INCOMPLETE', 'security-schema');
      if (!administration.success) return fail('IDENTITY_EVENT_BATCH_INCOMPLETE', 'admin-schema');
      for (const batch of [security.data, administration.data]) {
        if (
          new Set(batch.map((event) => event.id)).size !== batch.length ||
          batch.some((event) => event.time < from || event.time > Date.now() + maximumClockSkewMs)
        )
          return fail('IDENTITY_EVENT_BATCH_INCOMPLETE');
      }
      return { security: security.data, administration: administration.data };
    };
    const before = await read();
    const tokenEvents = before.security.filter(
      (event) =>
        event.type === 'CLIENT_LOGIN' &&
        !event.error &&
        event.userId === claims.sub &&
        event.clientId === claims.azp &&
        event.details?.token_id === claims.jti,
    );
    if (tokenEvents.length !== 1) return fail('IDENTITY_EVENT_PROBE_UNCONFIRMED');
    const security = tokenEvents[0]!;
    const ownSchema = z.object({
      id: uuid,
      attributes: z.record(z.string(), z.array(z.string())).default({}),
    });
    const own = ownSchema.safeParse(await this.call('GET', `/users/${claims.sub}`));
    if (!own.success || own.data.id !== claims.sub) return fail('IDENTITY_EVENT_PROBE_UNCONFIRMED');
    const marker = randomUUID();
    await this.call('PUT', `/users/${claims.sub}`, {
      attributes: { ...own.data.attributes, 'gcr.security.probe': [marker] },
    });
    const readback = ownSchema.safeParse(await this.call('GET', `/users/${claims.sub}`));
    if (
      !readback.success ||
      readback.data.id !== claims.sub ||
      JSON.stringify(readback.data.attributes['gcr.security.probe']) !== JSON.stringify([marker])
    )
      return fail('IDENTITY_EVENT_PROBE_UNCONFIRMED');
    const after = await read();
    const oldAdminIds = new Set(before.administration.map((event) => event.id));
    const probes = after.administration.filter(
      (event) =>
        !oldAdminIds.has(event.id) &&
        !event.error &&
        event.resourceType === 'USER' &&
        event.operationType === 'UPDATE' &&
        event.resourcePath === `users/${claims.sub}` &&
        event.authDetails?.userId === claims.sub,
    );
    if (
      probes.length !== 1 ||
      probes[0]!.realmId !== security.realmId ||
      (await this.eventConfiguration()) !== configurationHash ||
      Date.now() - observedAt > maximumCaptureMs
    )
      return fail('IDENTITY_EVENT_PROBE_UNCONFIRMED');
    for (const batch of [after.security, after.administration])
      if (batch.some((event) => event.realmId !== security.realmId))
        return fail('IDENTITY_EVENT_BATCH_INCOMPLETE');
    const securityIds = new Set(after.security.map((event) => event.id));
    const adminIds = new Set(after.administration.map((event) => event.id));
    if (
      !securityIds.has(security.id) ||
      before.security.some((event) => !securityIds.has(event.id)) ||
      before.administration.some((event) => !adminIds.has(event.id))
    )
      return fail('IDENTITY_EVENT_BATCH_INCOMPLETE');
    const continuous =
      previous &&
      previous.realmId === security.realmId &&
      previous.configurationHash === configurationHash &&
      previous.observedAt <= observedAt &&
      previous.observedAt > observedAt - windowMs &&
      securityIds.has(previous.security.id) &&
      adminIds.has(previous.administration.id);
    const events: IdentitySecurityEvent[] = [];
    for (const event of after.security) {
      if (
        event.error ||
        event.userId === claims.sub ||
        ['LOGIN', 'CLIENT_LOGIN'].includes(event.type)
      )
        continue;
      if (!event.userId) return fail('IDENTITY_EVENT_BATCH_INCOMPLETE');
      if (event.type === 'LOGOUT' || event.type === 'USER_SESSION_DELETED') {
        // An unscoped LOGOUT cannot safely become an all-device credential
        // revocation. Refuse freshness until the event can be reconciled.
        if (!event.sessionId) return fail('IDENTITY_EVENT_BATCH_INCOMPLETE');
        events.push({
          id: event.id,
          time: event.time,
          stream: 'security',
          kind: 'logout-session',
          userId: event.userId,
          sessionId: event.sessionId,
        });
      } else if (
        requiredSecurityEventTypes.includes(
          event.type as (typeof requiredSecurityEventTypes)[number],
        )
      ) {
        events.push({
          id: event.id,
          time: event.time,
          stream: 'security',
          kind: 'revoke-identity',
          userId: event.userId,
        });
      }
    }
    for (const event of after.administration) {
      if (event.error || !['UPDATE', 'DELETE', 'ACTION'].includes(event.operationType)) continue;
      const target = /^users\/([0-9a-f-]{36})(?:\/|$)/i.exec(event.resourcePath ?? '')?.[1];
      if (target === claims.sub) continue;
      if (target && uuid.safeParse(target).success)
        events.push({
          id: event.id,
          time: event.time,
          stream: 'administration',
          kind: 'revoke-identity',
          userId: target,
          ...(event.authDetails?.userId === claims.sub ? { ownAdministration: true as const } : {}),
          administrationAction:
            event.operationType === 'UPDATE' && event.resourcePath === `users/${target}`
              ? 'update-user'
              : event.operationType === 'ACTION' && event.resourcePath === `users/${target}/logout`
                ? 'logout-user'
                : 'other',
          ...(event.operationType === 'ACTION' && event.resourcePath === `users/${target}/logout`
            ? { remoteLogoutConfirmed: true }
            : {}),
        });
      else
        events.push({
          id: event.id,
          time: event.time,
          stream: 'administration',
          kind: 'revoke-provider',
        });
    }
    return {
      checkpoint: {
        realmId: security.realmId,
        configurationHash,
        security: { id: security.id, time: security.time },
        administration: { id: probes[0]!.id, time: probes[0]!.time },
        observedAt,
      },
      continuity: previous ? (continuous ? 'continuous' : 'gap') : 'baseline',
      events,
    };
  }
}
