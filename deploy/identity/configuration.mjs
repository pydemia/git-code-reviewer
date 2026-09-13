// Owned-realm configuration, separate from Keycloak startup and user lifecycle.
// Admin API writes are deliberately narrow: no realm import, user CRUD, key
// generation, client-secret rotation, or automatic adoption of existing objects.
import { timingSafeEqual, X509Certificate } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const ownerAttribute = 'gcr.configure.owner';
const bindingAttribute = 'gcr.configure.binding';
const stateAttribute = 'gcr.configure.state';
const smtpRevisionAttribute = 'gcr.configure.smtp-revision';
export const administrationClientId = 'gcr-identity-administration';
export const requiredEventTypes = Object.freeze([
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
]);
const roleNames = ['manage-users', 'view-events'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hostname =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
export class ConfigurationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ConfigurationError';
  }
}
const requireState = (condition, code) => {
  if (!condition) throw new ConfigurationError(code);
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeText = (value, maximum = 256) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maximum &&
  !containsControl(value);
export const containsControl = (value) =>
  [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
function exactKeys(value, keys) {
  requireState(
    object(value) && Object.keys(value).every((key) => keys.includes(key)),
    'INVALID_CONFIGURATION_FIELDS',
  );
}
function origin(value) {
  try {
    const url = new URL(value);
    requireState(
      url.protocol === 'https:' && url.origin === value && !url.username && !url.password,
      'INVALID_HTTPS_ORIGIN',
    );
    return url.origin;
  } catch {
    throw new ConfigurationError('INVALID_HTTPS_ORIGIN');
  }
}
export function validateConfiguration(input) {
  exactKeys(input, [
    'version',
    'configurationId',
    'realm',
    'publicOrigin',
    'identityOrigin',
    'adminOrigin',
    'smtp',
  ]);
  requireState(
    input.version === 1 &&
      typeof input.configurationId === 'string' &&
      uuid.test(input.configurationId),
    'INVALID_CONFIGURATION_ID',
  );
  requireState(input.realm === 'git-code-reviewer', 'INVALID_APPLICATION_REALM');
  const publicOrigin = origin(input.publicOrigin),
    identityOrigin = origin(input.identityOrigin),
    adminOrigin = origin(input.adminOrigin);
  requireState(
    new Set([publicOrigin, identityOrigin, adminOrigin]).size === 3,
    'PRIVATE_ADMIN_ORIGIN_REQUIRED',
  );
  let smtp;
  if (input.smtp !== undefined) {
    exactKeys(input.smtp, [
      'host',
      'port',
      'from',
      'fromDisplayName',
      'tls',
      'username',
      'revision',
    ]);
    const value = input.smtp;
    requireState(
      typeof value.host === 'string' &&
        hostname.test(value.host) &&
        Number.isInteger(value.port) &&
        value.port >= 1 &&
        value.port <= 65535 &&
        ['starttls', 'tls'].includes(value.tls) &&
        safeText(value.from, 320) &&
        /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(value.from) &&
        (value.fromDisplayName === undefined || safeText(value.fromDisplayName, 128)) &&
        (value.username === undefined || safeText(value.username, 256)) &&
        typeof value.revision === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.revision),
      'INVALID_SMTP_CONFIGURATION',
    );
    smtp = { ...value };
  }
  return Object.freeze({
    version: 1,
    configurationId: input.configurationId,
    realm: input.realm,
    publicOrigin,
    identityOrigin,
    adminOrigin,
    ...(smtp ? { smtp } : {}),
  });
}
function certificateBody(pem) {
  try {
    const cert = new X509Certificate(pem);
    requireState(
      cert.publicKey.asymmetricKeyType === 'rsa' &&
        (cert.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048 &&
        Date.parse(cert.validFrom) <= Date.now() &&
        Date.parse(cert.validTo) > Date.now(),
      'INVALID_SP_CERTIFICATE',
    );
    return cert.toString().replace(/-----[^-]+-----|\s/g, '');
  } catch {
    throw new ConfigurationError('INVALID_SP_CERTIFICATE');
  }
}
function sameSecret(left, right) {
  if (!safeText(left, 16_384) || !safeText(right, 16_384)) return false;
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
const asArray = (value) => {
  requireState(Array.isArray(value) && value.length <= 1000, 'INVALID_ADMIN_RESPONSE');
  return value;
};
const id = (value) => {
  requireState(typeof value === 'string' && uuid.test(value), 'INVALID_ADMIN_IDENTIFIER');
  return value;
};
const sameFields = (actual, expected) =>
  Object.entries(expected).every(
    ([key, value]) =>
      (object(value)
        ? sameFields(actual?.[key], value)
        : isDeepStrictEqual(actual?.[key], value)) ||
      (value === '' && actual?.[key] === undefined),
  );
function attributes(current, desired) {
  return { ...(current?.attributes ?? {}), ...desired };
}

export function desiredConfiguration(plan, spCertificate) {
  const entityId = plan.publicOrigin + '/auth/saml/metadata';
  const owned = { [ownerAttribute]: plan.configurationId };
  const binding = JSON.stringify({
    entityId,
    issuer: plan.identityOrigin + '/realms/' + plan.realm,
  });
  return {
    binding,
    realm: {
      sslRequired: 'all',
      registrationAllowed: false,
      ssoSessionMaxLifespan: 3600,
      ssoSessionIdleTimeout: 1800,
    },
    saml: {
      clientId: entityId,
      protocol: 'saml',
      enabled: true,
      frontchannelLogout: true,
      redirectUris: [plan.publicOrigin + '/auth/saml/acs'],
      defaultClientScopes: [],
      optionalClientScopes: [],
      attributes: {
        ...owned,
        saml_name_id_format: 'persistent',
        saml_force_name_id_format: 'true',
        'saml.authnstatement': 'true',
        'saml.server.signature': 'true',
        'saml.assertion.signature': 'true',
        'saml.client.signature': 'true',
        'saml.signature.algorithm': 'RSA_SHA256',
        saml_signature_canonicalization_method: 'http://www.w3.org/2001/10/xml-exc-c14n#',
        'saml.force.post.binding': 'false',
        'saml.server.signature.keyinfo.ext': 'false',
        'saml.assertion.lifespan': '240',
        'saml.signing.certificate': certificateBody(spCertificate),
        saml_assertion_consumer_url_post: plan.publicOrigin + '/auth/saml/acs',
        saml_single_logout_service_url_redirect: plan.publicOrigin + '/auth/saml/slo',
        'saml.allow.ecp.flow': 'false',
        'saml.artifact.binding': 'false',
        'saml.encrypt': 'false',
        'saml.useMetadataDescriptorUrl': 'false',
        saml_idp_initiated_sso_url_name: '',
        saml_idp_initiated_sso_relay_state: '',
      },
    },
    administration: {
      clientId: administrationClientId,
      protocol: 'openid-connect',
      enabled: true,
      publicClient: false,
      bearerOnly: false,
      clientAuthenticatorType: 'client-secret',
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      fullScopeAllowed: false,
      authorizationServicesEnabled: false,
      redirectUris: [],
      webOrigins: [],
      defaultClientScopes: ['roles'],
      optionalClientScopes: [],
      attributes: owned,
    },
  };
}

// admin(path, method, body, allowMissing) accepts paths relative to /admin/realms.
// It must reject redirects, cap responses, and return null only for an allowed 404.
export async function configureIdentity(
  input,
  { mode = 'inspect', admin, spCertificate, clientSecret, smtpPassword },
) {
  const plan = validateConfiguration(input);
  requireState(['inspect', 'apply'].includes(mode), 'INVALID_CONFIGURATION_MODE');
  requireState(
    safeText(clientSecret, 16_384) && clientSecret.length >= 32,
    'INVALID_ADMIN_CLIENT_SECRET',
  );
  const desired = desiredConfiguration(plan, spCertificate),
    base = '/' + plan.realm;
  const actions = [];
  const write = async (action, route, method, body) => {
    actions.push(action);
    if (mode === 'apply') await admin(route, method, body);
  };
  const lookup = async (clientId) => {
    const found = asArray(await admin(`${base}/clients?clientId=${encodeURIComponent(clientId)}`));
    requireState(
      found.length <= 1 && found.every((client) => client.clientId === clientId),
      'AMBIGUOUS_CLIENT',
    );
    if (!found.length) return null;
    return admin(`${base}/clients/${id(found[0].id)}`);
  };
  let realm = await admin(base, 'GET', undefined, true);
  if (!realm) {
    if (mode === 'inspect')
      return {
        mode,
        realm: plan.realm,
        actions: [
          'realm.create',
          'profile.configure',
          'events.configure',
          'saml-client.create',
          'admin-client.create',
          'roles.configure',
          ...(plan.smtp ? ['smtp.configure'] : []),
          'realm.enable',
        ],
        smtp: plan.smtp ? 'pending' : 'unconfigured',
        converged: false,
      };
    await write('realm.create', '', 'POST', {
      realm: plan.realm,
      enabled: false,
      ...desired.realm,
      attributes: {
        [ownerAttribute]: plan.configurationId,
        [bindingAttribute]: desired.binding,
        [stateAttribute]: 'preparing',
      },
      adminEventsDetailsEnabled: false,
    });
    realm = await admin(base);
  }
  requireState(
    realm?.realm === plan.realm &&
      realm.attributes?.[ownerAttribute] === plan.configurationId &&
      realm.attributes?.[bindingAttribute] === desired.binding &&
      ['preparing', 'ready'].includes(realm.attributes?.[stateAttribute]),
    'REALM_OWNERSHIP_CONFLICT',
  );
  requireState(
    realm.enabled === true || realm.attributes[stateAttribute] === 'preparing',
    'EXISTING_REALM_DISABLED',
  );
  const realmId = realm.id;
  const profile = await admin(`${base}/users/profile`);
  requireState(object(profile) && Array.isArray(profile.attributes), 'INVALID_USER_PROFILE');
  for (const attribute of profile.attributes) {
    requireState(safeText(attribute.name), 'INVALID_USER_PROFILE');
    if (
      attribute.name.startsWith('gcr.identity.') ||
      attribute.name.startsWith('saml.persistent.name.id.')
    )
      requireState(
        Array.isArray(attribute.permissions?.view) &&
          Array.isArray(attribute.permissions?.edit) &&
          attribute.permissions.view.every((role) => role === 'admin') &&
          attribute.permissions.edit.every((role) => role === 'admin'),
        'USER_EDITABLE_IDENTITY_ATTRIBUTE',
      );
  }
  const events = await admin(`${base}/events/config`);
  requireState(object(events), 'INVALID_EVENT_CONFIGURATION');
  const saml = await lookup(desired.saml.clientId),
    service = await lookup(administrationClientId);
  for (const [client, expected] of [
    [saml, desired.saml],
    [service, desired.administration],
  ]) {
    if (!client) continue;
    requireState(
      client.attributes?.[ownerAttribute] === plan.configurationId &&
        client.clientId === expected.clientId &&
        client.protocol === expected.protocol,
      'CLIENT_OWNERSHIP_CONFLICT',
    );
    requireState(client.enabled === true, 'EXISTING_CLIENT_DISABLED');
    requireState(
      asArray(client.protocolMappers ?? []).length === 0,
      'UNEXPECTED_CLIENT_PROTOCOL_MAPPER',
    );
    requireState(
      !client.attributes?.['saml.signing.private.key'] &&
        !client.attributes?.['saml.encryption.private.key'],
      'UNEXPECTED_CLIENT_PRIVATE_KEY',
    );
  }
  if (service) {
    requireState(
      service.serviceAccountsEnabled === true &&
        service.publicClient === false &&
        service.clientAuthenticatorType === 'client-secret',
      'UNEXPECTED_ADMIN_CLIENT_AUTHENTICATION',
    );
    const secret = await admin(`${base}/clients/${id(service.id)}/client-secret`);
    requireState(sameSecret(secret?.value, clientSecret), 'ADMIN_CLIENT_SECRET_MISMATCH');
    requireState(
      (await admin(
        `${base}/clients/${id(service.id)}/client-secret/rotated`,
        'GET',
        undefined,
        true,
      )) === null,
      'CLIENT_SECRET_ROTATION_IN_PROGRESS',
    );
  }
  const management = await lookup('realm-management');
  requireState(management, 'REALM_MANAGEMENT_CLIENT_MISSING');
  const managementId = id(management.id);
  const roles = [];
  for (const name of roleNames) {
    const role = await admin(`${base}/clients/${managementId}/roles/${name}`);
    requireState(
      role?.name === name && role.clientRole === true && role.composite === false,
      'UNEXPECTED_MANAGEMENT_ROLE',
    );
    id(role.id);
    roles.push(role);
  }
  async function serviceRoles(client) {
    const user = await admin(`${base}/clients/${id(client.id)}/service-account-user`);
    id(user?.id);
    requireState(
      user.enabled === true &&
        (!user.serviceAccountClientId || user.serviceAccountClientId === administrationClientId),
      'INVALID_SERVICE_ACCOUNT_USER',
    );
    const groups = asArray(await admin(`${base}/users/${user.id}/groups?max=1000`));
    requireState(groups.length === 0, 'UNEXPECTED_SERVICE_ACCOUNT_GROUP');
    for (const [route, serviceUser] of [
      [`${base}/users/${user.id}/role-mappings`, true],
      [`${base}/clients/${client.id}/scope-mappings`, false],
    ]) {
      const mappings = await admin(route);
      requireState(
        object(mappings) &&
          object(mappings.clientMappings ?? {}) &&
          Object.values(mappings.clientMappings ?? {}).every(
            (mapping) => mapping.id === managementId && mapping.client === 'realm-management',
          ) &&
          asArray(mappings.realmMappings ?? []).every(
            (role) => serviceUser && role.name === `default-roles-${plan.realm}`,
          ),
        'UNEXPECTED_SERVICE_ACCOUNT_MAPPINGS',
      );
    }
    const roleBase = `${base}/users/${user.id}/role-mappings/clients/${managementId}`;
    const scopeBase = `${base}/clients/${client.id}/scope-mappings/clients/${managementId}`;
    const assigned = asArray(await admin(roleBase)),
      scopes = asArray(await admin(scopeBase));
    const effective = asArray(await admin(roleBase + '/composite'));
    const effectiveScopes = asArray(await admin(scopeBase + '/composite'));
    for (const list of [assigned, scopes, effective, effectiveScopes])
      requireState(
        list.every((role) =>
          roles.some(
            (expected) =>
              role.name === expected.name && role.id === expected.id && role.composite === false,
          ),
        ),
        'EXCESSIVE_MANAGEMENT_ROLES',
      );
    requireState(
      asArray(await admin(`${base}/clients/${client.id}/scope-mappings/realm`)).length === 0,
      'UNEXPECTED_REALM_SCOPE',
    );
    return { assigned, scopes, roleBase, scopeBase };
  }
  // Detect known credential/permission/profile conflicts before the first write.
  if (service) await serviceRoles(service);
  if (plan.smtp) {
    const expected = smtpConfiguration(plan.smtp);
    if (realm.attributes[smtpRevisionAttribute] === plan.smtp.revision)
      requireState(sameFields(realm.smtpServer, expected), 'SMTP_REVISION_CONFIGURATION_CONFLICT');
    else if (mode === 'apply' && plan.smtp.username)
      requireState(safeText(smtpPassword, 16_384), 'SMTP_PASSWORD_REQUIRED');
  }
  if (!sameFields(realm, desired.realm)) await write('realm.configure', base, 'PUT', desired.realm);
  if (profile.unmanagedAttributePolicy !== 'ADMIN_EDIT')
    await write('profile.configure', `${base}/users/profile`, 'PUT', {
      ...profile,
      unmanagedAttributePolicy: 'ADMIN_EDIT',
    });
  const expectedEvents = {
    eventsEnabled: true,
    eventsExpiration: 86400,
    enabledEventTypes: [
      ...new Set([...asArray(events.enabledEventTypes ?? []), ...requiredEventTypes]),
    ].sort(),
    adminEventsEnabled: true,
    adminEventsDetailsEnabled: false,
  };
  if (
    !sameFields(
      { ...events, enabledEventTypes: [...(events.enabledEventTypes ?? [])].sort() },
      expectedEvents,
    )
  )
    await write('events.configure', `${base}/events/config`, 'PUT', expectedEvents);
  // Never send a secret-bearing Admin API write until target-realm details are off.
  if (mode === 'apply')
    requireState(
      (await admin(`${base}/events/config`)).adminEventsDetailsEnabled === false,
      'ADMIN_EVENT_DETAILS_NOT_DISABLED',
    );
  for (const [label, current, expected] of [
    ['saml-client', saml, desired.saml],
    ['admin-client', service, desired.administration],
  ]) {
    if (!current) {
      await write(label + '.create', `${base}/clients`, 'POST', {
        ...expected,
        ...(label === 'admin-client' ? { secret: clientSecret } : {}),
      });
    } else {
      const patch = { ...expected, attributes: attributes(current, expected.attributes) };
      // Keycloak 26.7.3 omits authorizationServicesEnabled when no resource
      // server exists. Other required false flags remain strict readbacks.
      if (
        !sameFields(
          {
            ...current,
            authorizationServicesEnabled: current.authorizationServicesEnabled ?? false,
          },
          patch,
        )
      )
        await write(label + '.configure', `${base}/clients/${id(current.id)}`, 'PUT', patch);
    }
  }
  const activeService = mode === 'apply' ? await lookup(administrationClientId) : service;
  if (activeService) {
    const state = await serviceRoles(activeService);
    for (const [list, route, label] of [
      [state.assigned, state.roleBase, 'roles.assign'],
      [state.scopes, state.scopeBase, 'roles.scope'],
    ]) {
      const missing = roles.filter((role) => !list.some((existing) => existing.id === role.id));
      if (missing.length)
        await write(
          label,
          route,
          'POST',
          missing.map(({ id, name, clientRole, composite }) => ({
            id,
            name,
            clientRole,
            composite,
          })),
        );
    }
  } else actions.push('roles.configure');
  if (plan.smtp && realm.attributes[smtpRevisionAttribute] !== plan.smtp.revision) {
    await write('smtp.configure', base, 'PUT', {
      smtpServer: {
        ...smtpConfiguration(plan.smtp),
        ...(plan.smtp.username ? { password: smtpPassword } : {}),
      },
      attributes: attributes(realm, { [smtpRevisionAttribute]: plan.smtp.revision }),
    });
    if (mode === 'apply') realm = await admin(base);
  }
  if (realm.attributes[stateAttribute] === 'preparing') {
    if (mode === 'apply') {
      const staged = await configureIdentity(plan, {
        mode: 'inspect',
        admin,
        spCertificate,
        clientSecret,
      });
      requireState(
        staged.actions.length === 1 && staged.actions[0] === 'realm.enable',
        'STAGED_CONFIGURATION_READBACK_FAILED',
      );
    }
    await write('realm.enable', base, 'PUT', {
      enabled: true,
      attributes: attributes(realm, { [stateAttribute]: 'ready' }),
    });
  }
  if (mode === 'apply') {
    const after = await configureIdentity(plan, {
      mode: 'inspect',
      admin,
      spCertificate,
      clientSecret,
    });
    requireState(
      after.converged && (await admin(base)).id === realmId,
      'CONFIGURATION_READBACK_FAILED',
    );
  }
  return {
    mode,
    realm: plan.realm,
    actions,
    converged: mode === 'apply' || actions.length === 0,
    smtp: plan.smtp
      ? mode === 'inspect' && actions.includes('smtp.configure')
        ? 'pending'
        : 'configured-delivery-unverified'
      : 'unmanaged-delivery-unverified',
  };
}

function smtpConfiguration(smtp) {
  return {
    host: smtp.host,
    port: String(smtp.port),
    from: smtp.from,
    fromDisplayName: smtp.fromDisplayName ?? '',
    ssl: String(smtp.tls === 'tls'),
    starttls: String(smtp.tls === 'starttls'),
    auth: String(Boolean(smtp.username)),
    user: smtp.username ?? '',
  };
}
