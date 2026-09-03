import type { AuthUser } from '../auth/index.js';
import type { AppConfig } from '../config.js';

export type AuthorizationAction = 'view' | 'create' | 'update' | 'manage' | 'refresh' | 'chat';

export type AuthorizationResource = {
  kind:
    | 'tenant'
    | 'user'
    | 'membership'
    | 'repository'
    | 'pull_request'
    | 'analysis'
    | 'analysis_prompt';
  id: string;
  tenantId?: string;
  granted?: boolean;
  enabled?: boolean;
};

type AuthorizationEntry = {
  action: AuthorizationAction;
  resource: AuthorizationResource;
};

export class AuthorizationUnavailableError extends Error {
  readonly statusCode = 503;

  constructor() {
    super('Authorization service is unavailable');
    this.name = 'AuthorizationUnavailableError';
  }
}

export class AuthorizationService {
  private readonly mode: 'local' | 'cerbos';
  private readonly endpoint: URL | undefined;
  private readonly timeoutMs: number;

  constructor(
    config: Pick<AppConfig, 'AUTHORIZATION_MODE' | 'CERBOS_URL' | 'CERBOS_TIMEOUT_MS'>,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.mode = config.AUTHORIZATION_MODE;
    this.endpoint = config.CERBOS_URL
      ? new URL('api/check/resources', ensureTrailingSlash(config.CERBOS_URL))
      : undefined;
    this.timeoutMs = config.CERBOS_TIMEOUT_MS;
  }

  async isAllowed(
    principal: AuthUser,
    action: AuthorizationAction,
    resource: AuthorizationResource,
    requestId: string,
  ): Promise<boolean> {
    const [allowed] = await this.check(principal, [{ action, resource }], requestId);
    return allowed ?? false;
  }

  async filterAllowed(
    principal: AuthUser,
    action: AuthorizationAction,
    resources: AuthorizationResource[],
    requestId: string,
  ): Promise<Set<string>> {
    if (resources.length === 0) return new Set();
    const decisions = await this.check(
      principal,
      resources.map((resource) => ({ action, resource })),
      requestId,
    );
    return new Set(resources.filter((_resource, index) => decisions[index]).map(({ id }) => id));
  }

  async health(): Promise<'ok' | 'disabled' | 'degraded'> {
    if (this.mode === 'local') return 'disabled';
    try {
      const response = await this.fetcher(new URL('/_cerbos/health', this.endpoint), {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return response.ok ? 'ok' : 'degraded';
    } catch {
      return 'degraded';
    }
  }

  private async check(
    principal: AuthUser,
    entries: AuthorizationEntry[],
    requestId: string,
  ): Promise<boolean[]> {
    if (!principal.enabled) return entries.map(() => false);
    if (this.mode === 'local') {
      return entries.map(({ action, resource }) => localDecision(principal, action, resource));
    }
    if (!this.endpoint) throw new AuthorizationUnavailableError();

    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId,
          principal: {
            id: principal.subject,
            roles: [principal.role],
            attr: {
              enabled: principal.enabled,
              tenantIds: principal.tenantIds,
              groups: principal.groups,
            },
          },
          resources: entries.map(({ action, resource }) => ({
            resource: {
              kind: resource.kind,
              id: resource.id,
              attr: {
                ...(resource.tenantId ? { tenantId: resource.tenantId } : {}),
                enabled: resource.enabled ?? true,
                granted: resource.granted ?? false,
              },
            },
            actions: [action],
          })),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new AuthorizationUnavailableError();
    }
    if (!response.ok) throw new AuthorizationUnavailableError();

    try {
      const body = (await response.json()) as {
        results?: Array<{ resource?: { id?: string }; actions?: Record<string, string> }>;
      };
      const byResource = new Map(
        (body.results ?? []).map((result) => [result.resource?.id, result.actions]),
      );
      return entries.map(
        ({ action, resource }) => byResource.get(resource.id)?.[action] === 'EFFECT_ALLOW',
      );
    } catch {
      throw new AuthorizationUnavailableError();
    }
  }
}

export function localDecision(
  principal: Pick<AuthUser, 'role' | 'enabled' | 'tenantIds'>,
  action: AuthorizationAction,
  resource: AuthorizationResource,
): boolean {
  if (!principal.enabled || resource.enabled === false) return false;
  if (principal.role === 'administrator') return true;
  const belongsToTenant = Boolean(
    resource.tenantId && principal.tenantIds.includes(resource.tenantId),
  );
  if (resource.kind === 'tenant') return action === 'view' && belongsToTenant;
  if (
    ['repository', 'pull_request', 'analysis'].includes(resource.kind) &&
    ['view', 'refresh', 'chat'].includes(action)
  ) {
    return belongsToTenant && resource.granted === true;
  }
  return false;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
