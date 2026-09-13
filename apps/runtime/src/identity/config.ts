import type { AppConfig } from '../config.js';
import { samlRoutes } from '../auth/saml-config.js';
import { samlConfigurationKey } from '../auth/saml-state.js';
import { validateKeycloakAdminSettings, type KeycloakAdminSettings } from './keycloak-admin.js';

export function identityAdministrationConfig(config: AppConfig) {
  if (config.IDENTITY_SECURITY_ENABLED && !config.IDENTITY_ADMIN_ENABLED)
    throw new Error('Invalid configuration: identity security requires identity administration');
  if (!config.IDENTITY_ADMIN_ENABLED) return undefined;
  try {
    const origin = new URL(config.PUBLIC_BASE_URL!);
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      throw Error();
    const binding = {
      issuer: config.SAML_IDP_ISSUER!,
      entityId: config.SAML_ENTITY_ID ?? origin.origin + samlRoutes.metadata,
      acsUrl: origin.origin + samlRoutes.acs,
      sloUrl: origin.origin + samlRoutes.slo,
    };
    samlConfigurationKey(binding);
    const settings: KeycloakAdminSettings = {
      issuer: binding.issuer,
      entityId: binding.entityId,
      clientId: config.KEYCLOAK_ADMIN_CLIENT_ID!,
      clientSecretFile: config.KEYCLOAK_ADMIN_CLIENT_SECRET_FILE!,
      ...(config.KEYCLOAK_ADMIN_BASE_URL ? { adminBaseUrl: config.KEYCLOAK_ADMIN_BASE_URL } : {}),
    };
    validateKeycloakAdminSettings(settings);
    return { binding, settings };
  } catch {
    throw new Error(
      'Invalid configuration: identity administration requires approved HTTPS SAML endpoints and a realm service-account secret file',
    );
  }
}
