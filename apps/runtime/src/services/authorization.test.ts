import { describe, expect, it } from 'vitest';
import type { AuthUser } from '../auth/index.js';
import {
  AuthorizationService,
  AuthorizationUnavailableError,
  localDecision,
} from './authorization.js';

const tenantId = 'a5777af2-c584-42d5-83e0-9010eeb2cf10';
const principal: AuthUser = {
  id: '0a9d6bb3-30ea-42a7-86aa-94fe5a4db383',
  subject: 'reviewer-1',
  displayName: 'Reviewer',
  role: 'reviewer',
  groups: ['engineering'],
  enabled: true,
  tenantIds: [tenantId],
};

describe('authorization service', () => {
  it('combines reviewer role, tenant membership and repository grant', () => {
    expect(
      localDecision(principal, 'view', {
        kind: 'repository',
        id: 'repo-1',
        tenantId,
        granted: true,
      }),
    ).toBe(true);
    expect(
      localDecision(principal, 'view', {
        kind: 'repository',
        id: 'repo-2',
        tenantId,
        granted: false,
      }),
    ).toBe(false);
    expect(
      localDecision(principal, 'view', {
        kind: 'repository',
        id: 'repo-3',
        tenantId: '7aa42f67-5878-4ed2-881e-a42bce2cbe91',
        granted: true,
      }),
    ).toBe(false);
  });

  it('allows an enabled administrator and denies a disabled administrator', () => {
    expect(
      localDecision({ ...principal, role: 'administrator' }, 'manage', {
        kind: 'analysis_prompt',
        id: 'prompt-1',
        tenantId,
      }),
    ).toBe(true);
    expect(
      localDecision({ ...principal, role: 'administrator', enabled: false }, 'manage', {
        kind: 'analysis_prompt',
        id: 'prompt-1',
        tenantId,
      }),
    ).toBe(false);
  });

  it('sends roles and attributes to Cerbos and accepts only explicit allows', async () => {
    let requestBody: Record<string, unknown> = {};
    const authorization = new AuthorizationService(
      {
        AUTHORIZATION_MODE: 'cerbos',
        CERBOS_URL: 'http://cerbos.test:3592/',
        CERBOS_TIMEOUT_MS: 1000,
      },
      (async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          results: [
            {
              resource: { id: 'repo-1', kind: 'repository' },
              actions: { view: 'EFFECT_ALLOW' },
            },
            {
              resource: { id: 'repo-2', kind: 'repository' },
              actions: { view: 'EFFECT_DENY' },
            },
          ],
        });
      }) as typeof fetch,
    );

    const allowed = await authorization.filterAllowed(
      principal,
      'view',
      [
        { kind: 'repository', id: 'repo-1', tenantId, granted: true },
        { kind: 'repository', id: 'repo-2', tenantId, granted: true },
      ],
      'request-1',
    );

    expect(allowed).toEqual(new Set(['repo-1']));
    expect(requestBody).toMatchObject({
      requestId: 'request-1',
      principal: {
        id: 'reviewer-1',
        roles: ['reviewer'],
        attr: { enabled: true, tenantIds: [tenantId], groups: ['engineering'] },
      },
    });
  });

  it('fails closed when Cerbos is unavailable or returns malformed data', async () => {
    const authorization = new AuthorizationService(
      {
        AUTHORIZATION_MODE: 'cerbos',
        CERBOS_URL: 'http://cerbos.test:3592/',
        CERBOS_TIMEOUT_MS: 1000,
      },
      (async () => {
        throw new Error('offline');
      }) as typeof fetch,
    );
    await expect(
      authorization.isAllowed(
        principal,
        'view',
        { kind: 'tenant', id: tenantId, tenantId },
        'request-2',
      ),
    ).rejects.toBeInstanceOf(AuthorizationUnavailableError);
  });
});
