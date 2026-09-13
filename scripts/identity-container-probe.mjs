// Owned Compose fixture only; credentials are mounted by the verifier.
import assert from 'node:assert/strict';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createAdminTransport } from '/run/config/identity/configure.mjs';
import { desiredConfiguration } from '/run/config/identity/configuration.mjs';
import { isDeepStrictEqual } from 'node:util';
const read = async (name) => (await readFile(name, 'utf8')).trim();
const plan = JSON.parse(await read('/run/config/identity/plan.json'));
const ca = await read('/run/config/ca.crt');
const username = await read('/run/secrets/bootstrap-admin-username');
const password = await read('/run/secrets/bootstrap-admin-password');
const userPassword = await read('/run/secrets/fixture-user-password');
const admin = createAdminTransport(plan, { ca, username, password });
const route = '/' + plan.realm;
const request = (endpoint, body, token) =>
  new Promise((resolve, reject) => {
    const outgoing = https.request(
      plan.adminOrigin + endpoint,
      {
        ca,
        rejectUnauthorized: true,
        method: body ? 'POST' : 'GET',
        signal: AbortSignal.timeout(30000),
        headers: {
          ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(token ? { authorization: 'Bearer ' + token } : {}),
        },
      },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (data += chunk));
        response.on('error', reject);
        response.on('end', () => resolve({ status: response.statusCode, data }));
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body?.toString());
  });
try {
  if (process.argv[2] === 'diagnose') {
    const desired = desiredConfiguration(plan, await read('/run/secrets/sp-signing-cert'));
    const differences = [];
    const compare = (actual, expected, prefix) => {
      for (const [key, value] of Object.entries(expected)) {
        const field = prefix + '.' + key;
        if (value && typeof value === 'object' && !Array.isArray(value))
          compare(actual?.[key], value, field);
        else if (!isDeepStrictEqual(actual?.[key], value))
          differences.push({ field, expected: value, actual: actual?.[key] });
      }
    };
    compare(await admin(route), desired.realm, 'realm');
    for (const kind of ['saml', 'administration']) {
      const clients = await admin(
        route + '/clients?clientId=' + encodeURIComponent(desired[kind].clientId),
      );
      if (clients.length === 1)
        compare(await admin(route + '/clients/' + clients[0].id), desired[kind], kind);
    }
    console.log(
      JSON.stringify(
        differences.map((item) =>
          item.field.includes('certificate') ? { field: item.field, different: true } : item,
        ),
      ),
    );
  } else {
    if (process.argv[2] === 'create') {
      await admin(route + '/users', 'POST', {
        username: 'fixture-user',
        enabled: true,
        firstName: 'Fixture',
        lastName: 'User',
        email: 'fixture@example.test',
        emailVerified: true,
        credentials: [{ type: 'password', value: userPassword, temporary: false }],
      });
      await admin(route + '/clients', 'POST', {
        clientId: 'fixture-password-check',
        protocol: 'openid-connect',
        publicClient: true,
        directAccessGrantsEnabled: true,
        standardFlowEnabled: false,
      });
    }
    const users = await admin(route + '/users?username=fixture-user&exact=true');
    assert.equal(users.length, 1);
    const keys = await admin(route + '/keys');
    const clients = await admin(route + '/clients');
    const snapshot = {
      user: users[0],
      activeKeys: keys.active,
      keys: keys.keys
        .map(({ kid, publicKey, certificate, status, algorithm }) => ({
          kid,
          publicKey,
          certificate,
          status,
          algorithm,
        }))
        .sort((a, b) => a.kid.localeCompare(b.kid)),
      clients: clients
        .filter((client) => client.attributes?.['gcr.configure.owner'] === plan.configurationId)
        .map(({ id, clientId }) => ({ id, clientId }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
    assert.equal(snapshot.clients.length, 2);
    const auth = await request(
      '/realms/' + plan.realm + '/protocol/openid-connect/token',
      new URLSearchParams({
        grant_type: 'password',
        client_id: 'fixture-password-check',
        username: 'fixture-user',
        password: userPassword,
      }),
    );
    assert.equal(auth.status, 200, 'retained user password');
    const tokens = JSON.parse(auth.data);
    const logout = await request(
      '/realms/' + plan.realm + '/protocol/openid-connect/logout',
      new URLSearchParams({
        client_id: 'fixture-password-check',
        refresh_token: tokens.refresh_token,
      }),
    );
    assert.equal(logout.status, 204);
    const serviceAuth = await request(
      '/realms/' + plan.realm + '/protocol/openid-connect/token',
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: 'gcr-identity-administration',
        client_secret: await read('/run/secrets/identity-admin-client-secret'),
      }),
    );
    assert.equal(serviceAuth.status, 200, 'configured service account authenticates');
    const token = JSON.parse(serviceAuth.data).access_token;
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    const service = clients.find((client) => client.clientId === 'gcr-identity-administration');
    const serviceUser = await admin(route + '/clients/' + service.id + '/service-account-user');
    assert.equal(claims.sub, serviceUser.id, 'service token identifies the C05 security collector');
    assert.equal(claims.iss, plan.identityOrigin + '/realms/' + plan.realm);
    assert.equal(claims.azp, 'gcr-identity-administration');
    assert.deepEqual(claims.resource_access?.['realm-management']?.roles?.sort(), [
      'manage-users',
      'view-events',
    ]);
    for (const [endpoint, expected] of [
      ['users', 200],
      ['events', 200],
      ['clients', 403],
    ]) {
      assert.equal(
        (await request('/admin/realms/' + plan.realm + '/' + endpoint, undefined, token)).status,
        expected,
        'service account ' + endpoint,
      );
    }
    for (const endpoint of ['/health/ready', '/health/live', '/metrics'])
      assert.equal(
        (await request(endpoint)).status,
        404,
        'management endpoint on main HTTPS interface',
      );
    console.log(
      JSON.stringify({
        sha256: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
        userId: users[0].id,
        keys: snapshot.keys.length,
        ownedClients: snapshot.clients.length,
        uid: process.getuid(),
        groups: process.getgroups(),
      }),
    );
  }
} finally {
  await admin.close();
}
