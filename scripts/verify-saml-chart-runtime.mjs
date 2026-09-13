// Invoked by verify-saml-chart.py with synthetic, rendered configuration only.
// Does not start GCR, connect to a database or perform a SAML browser login.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../apps/runtime/dist/config.js';
import { loadSamlProtocolConfig } from '../apps/runtime/dist/auth/saml-config.js';
import { identityAdministrationConfig } from '../apps/runtime/dist/identity/config.js';
import { validateKeycloakAdminSettings } from '../apps/runtime/dist/identity/keycloak-admin.js';

const fixture = JSON.parse(await readFile(process.argv[2], 'utf8'));
const checks = [];
for (const item of fixture.configurations) {
  const expectedEntityId = item.entityId ?? fixture.entityId;
  const config = loadConfig(item.environment, item.command);
  assert.equal(config.AUTH_MODE, item.authMode);
  assert.equal(config.IDENTITY_ADMIN_ENABLED, item.identityEnabled);
  assert.equal(config.IDENTITY_SECURITY_ENABLED, item.securityEnabled);
  if (item.identityEnabled) {
    const administration = identityAdministrationConfig(config);
    const endpoints = validateKeycloakAdminSettings(administration.settings);
    assert.equal(endpoints.tokenUrl, fixture.issuer + '/protocol/openid-connect/token');
    assert.equal(endpoints.adminBaseUrl, fixture.adminBaseUrl);
    assert.equal(administration.binding.entityId, expectedEntityId);
  }
  if (item.command === 'serve' && item.authMode === 'saml') {
    assert.equal(config.SESSION_SECRET, fixture.expectedSessionSecret);
    assert.equal(item.environment.UNRELATED_AUTH_SETTING, undefined);
    let requests = 0;
    const request = async (url, options) => {
      requests++;
      assert.equal(url, fixture.issuer + '/protocol/saml/descriptor');
      assert.equal(options.redirect, 'error');
      return new Response(fixture.metadata, {
        headers: { 'content-type': 'application/samlmetadata+xml' },
      });
    };
    const protocol = await loadSamlProtocolConfig(config, request);
    assert.equal(protocol.entityId, expectedEntityId);
    assert.equal(protocol.idpIssuer, fixture.issuer);
    assert.equal(protocol.idpCerts.length, 1);
    assert.equal(requests, item.metadataFile ? 0 : 1);
    if (item.metadataFile) {
      await assert.rejects(
        loadSamlProtocolConfig(
          { ...config, SAML_IDP_METADATA_FILE: config.SAML_IDP_METADATA_FILE + '.missing' },
          request,
        ),
        /SAML signing key or approved IdP metadata could not be verified/,
      );
      assert.equal(requests, 0, 'Missing metadata pin must not fetch another trust source');
    }
    await assert.rejects(
      loadSamlProtocolConfig({ ...config, SAML_PUBLIC_CERT_FILE: fixture.idpCertificatePath }),
      /SAML signing key or approved IdP metadata could not be verified/,
    );
    checks.push(`${item.name}: compiled SAML settings, real key/cert, metadata and trust failures`);
  } else {
    assert.equal(config.SAML_PRIVATE_KEY_FILE, undefined);
    assert.equal(config.SAML_PUBLIC_CERT_FILE, undefined);
    checks.push(`${item.name}: compiled command config and identity scope`);
  }
}
const modules = [
  'config.js',
  'auth/saml-config.js',
  'auth/saml-protocol.js',
  'auth/saml-state.js',
  'identity/config.js',
  'identity/keycloak-admin.js',
];
const hashes = {};
for (const module of modules)
  hashes[`apps/runtime/dist/${module}`] = createHash('sha256')
    .update(await readFile(new URL(`../apps/runtime/dist/${module}`, import.meta.url)))
    .digest('hex');
console.log(
  JSON.stringify({
    status: 'passed',
    node: process.version,
    checks,
    compiledSha256: hashes,
    metadataUrlResponse: 'fixture response; no real HTTPS or IdP request',
    databaseConnected: false,
  }),
);
