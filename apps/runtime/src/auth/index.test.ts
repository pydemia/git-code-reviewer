import { describe, expect, it } from 'vitest';
import { resolveIdentityRole } from './index.js';

const config = {
  OIDC_CLIENT_ID: 'git-code-reviewer',
  OIDC_ADMIN_ROLE: 'git-code-reviewer-admin',
  OIDC_ADMIN_GROUP: 'git-code-reviewer-admins',
};

describe('resolveIdentityRole', () => {
  it('accepts the configured Keycloak client role', () => {
    expect(
      resolveIdentityRole(
        {
          resource_access: {
            'git-code-reviewer': { roles: ['git-code-reviewer-admin'] },
          },
        },
        [],
        config,
      ),
    ).toBe('administrator');
  });

  it('accepts realm role and group fallback claims', () => {
    expect(
      resolveIdentityRole({ realm_access: { roles: ['git-code-reviewer-admin'] } }, [], config),
    ).toBe('administrator');
    expect(resolveIdentityRole({}, ['git-code-reviewer-admins'], config)).toBe('administrator');
  });

  it('ignores another client role and malformed claims', () => {
    expect(
      resolveIdentityRole(
        {
          resource_access: {
            'another-client': { roles: ['git-code-reviewer-admin'] },
          },
          realm_access: { roles: 'git-code-reviewer-admin' },
        },
        [],
        config,
      ),
    ).toBe('reviewer');
  });
});
