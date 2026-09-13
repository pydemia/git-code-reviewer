import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { identityAdministrationConfig } from './config.js';

const environment = {
  DATABASE_URL: 'postgresql://localhost/fixture',
  AUTH_MODE: 'local',
  LOCAL_BOOTSTRAP_ADMIN_USERNAME: 'fixture-admin',
  LOCAL_BOOTSTRAP_ADMIN_PASSWORD: 'synthetic-fixture-password-only',
  IDENTITY_ADMIN_ENABLED: 'true',
  PUBLIC_BASE_URL: 'https://gcr.test',
  SAML_IDP_ISSUER: 'https://idp.test/realms/gcr',
  KEYCLOAK_ADMIN_CLIENT_ID: 'gcr-administration',
  KEYCLOAK_ADMIN_CLIENT_SECRET_FILE: '/mounted/admin.secret',
};
describe('Identity administration opt-in configuration', () => {
  it('is disabled by default and ignores credentials until explicitly enabled', () => {
    expect(
      identityAdministrationConfig(loadConfig({ DATABASE_URL: environment.DATABASE_URL })),
    ).toBeUndefined();
  });
  it('allows preprovisioning in local mode and gives the worker no requirement to read SP signing keys', () => {
    for (const command of ['serve', 'worker'] as const) {
      const config = loadConfig(environment, command);
      expect(config.AUTH_MODE).toBe('local');
      expect(identityAdministrationConfig(config)?.binding).toEqual({
        issuer: environment.SAML_IDP_ISSUER,
        entityId: 'https://gcr.test/auth/saml/metadata',
        acsUrl: 'https://gcr.test/auth/saml/acs',
        sloUrl: 'https://gcr.test/auth/saml/slo',
      });
    }
  });
  it.each([
    { PUBLIC_BASE_URL: 'http://gcr.test' },
    { PUBLIC_BASE_URL: 'https://gcr.test/path' },
    { SAML_IDP_ISSUER: 'https://idp.test/realms/master' },
    { KEYCLOAK_ADMIN_CLIENT_ID: 'admin-cli' },
    { KEYCLOAK_ADMIN_CLIENT_SECRET_FILE: '' },
    { KEYCLOAK_ADMIN_BASE_URL: 'https://idp.test/admin/realms/another' },
    { SAML_ENTITY_ID: 'https://another.test/metadata' },
  ])('rejects incomplete or mismatched enabled settings without reflecting values', (change) => {
    expect(() => loadConfig({ ...environment, ...change })).toThrow(/^Invalid configuration:/);
  });
  it('does not require the service-account mount to migrate or run retention', () => {
    const withoutSecret = { ...environment, KEYCLOAK_ADMIN_CLIENT_SECRET_FILE: '' };
    expect(() => loadConfig(withoutSecret, 'migrate')).not.toThrow();
    expect(() => loadConfig(withoutSecret, 'retention')).not.toThrow();
  });
});
