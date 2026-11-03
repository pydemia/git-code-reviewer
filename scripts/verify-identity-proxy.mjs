// Real Node HTTPS edge and HTTP fixture backends. This does not claim a real
// Keycloak, browser SAML, Docker network, or production TLS verification.
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createIdentityProxy, validateProxySettings } from '../deploy/identity/https-proxy.mjs';

const execFile = promisify(execFileCallback);
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), 'gcr-identity-proxy-'));
const evidence = {
  startedAt: new Date().toISOString(),
  node: process.version,
  checks: [],
  cleanup: false,
};
const servers = [],
  sockets = new Set(),
  observed = [];
const check = (name) => evidence.checks.push(name);
async function listen(server) {
  servers.push(server);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}
const bodyOf = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
};
async function openssl(...args) {
  await execFile('openssl', args, { cwd: directory, timeout: 30_000, maxBuffer: 64 * 1024 });
}
let finishEvents;
try {
  await openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-days',
    '1',
    '-keyout',
    'ca.key',
    '-out',
    'ca.crt',
    '-subj',
    '/CN=GCR proxy fixture CA',
  );
  await openssl(
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-keyout',
    'edge.key',
    '-out',
    'edge.csr',
    '-subj',
    '/CN=gcr.test',
  );
  await writeFile(
    path.join(directory, 'leaf.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:gcr.test,DNS:identity.test\n',
  );
  await openssl(
    'x509',
    '-req',
    '-in',
    'edge.csr',
    '-CA',
    'ca.crt',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'edge.crt',
    '-days',
    '1',
    '-sha256',
    '-extfile',
    'leaf.ext',
  );
  const ca = await readFile(path.join(directory, 'ca.crt'));
  const key = await readFile(path.join(directory, 'edge.key'));
  const certificate = await readFile(path.join(directory, 'edge.crt'));
  const backend = (name) =>
    http.createServer(async (request, response) => {
      const record = {
        name,
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: await bodyOf(request),
      };
      observed.push(record);
      if (request.url === '/events') {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        response.write('data: first\n\n');
        finishEvents = () => response.end('data: last\n\n');
      } else if (request.url === '/redirect') {
        response.writeHead(302, {
          location:
            'https://identity.test/realms/git-code-reviewer/protocol/saml?SAMLRequest=opaque',
          'set-cookie': [
            '__Host-gcr_saml_tx=opaque; Secure; HttpOnly; Path=/; SameSite=None',
            'second=opaque; Secure; Path=/',
          ],
          connection: 'keep-alive, x-hop-only',
          'x-hop-only': 'discard',
        });
        response.end();
      } else if (request.url === '/abort') {
        request.socket.destroy();
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(record));
      }
    });
  const appPort = await listen(backend('app')),
    identityPort = await listen(backend('identity'));
  // Reserve a listener first, then use its real port for the public Host contract.
  const portHolder = http.createServer();
  const port = await listen(portHolder);
  await new Promise((resolve) => portHolder.close(resolve));
  const settings = {
    publicHost: 'gcr.test',
    identityHost: 'identity.test',
    realm: 'git-code-reviewer',
    port,
    key,
    certificate,
    appUpstream: `http://127.0.0.1:${appPort}/`,
    identityUpstream: `http://127.0.0.1:${identityPort}/`,
  };
  const proxy = createIdentityProxy(settings);
  servers.push(proxy);
  proxy.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(port, '127.0.0.1', resolve);
  });
  const getResponse = (url, options = {}) =>
    new Promise((resolve, reject) => {
      const request = https.request(
        {
          host: '127.0.0.1',
          port,
          servername: options.servername ?? 'gcr.test',
          ca: options.ca ?? ca,
          method: options.method ?? 'GET',
          path: url,
          agent: false,
          headers: { host: options.host ?? `gcr.test:${port}`, ...options.headers },
          timeout: 10_000,
        },
        resolve,
      );
      request.on('error', reject);
      request.on('timeout', () => request.destroy(Error('fixture request timeout')));
      request.end(options.body);
    });
  async function fetch(url, options) {
    const response = await getResponse(url, options);
    return { status: response.statusCode, headers: response.headers, body: await bodyOf(response) };
  }
  const app = await fetch('/health/ready');
  assert.equal(JSON.parse(app.body).name, 'app');
  check('verified-leaf-TLS-and-application-routing');
  const goodPaths = [
    '/realms/git-code-reviewer',
    '/realms/git-code-reviewer/protocol/saml/descriptor',
    '/realms/git-code-reviewer/login-actions/authenticate?session_code=%2Fopaque%2B',
    '/resources/app/login.js',
  ];
  for (const url of goodPaths) {
    const result = await fetch(url, { host: `identity.test:${port}` });
    assert.equal(result.status, 200, url);
    assert.equal(JSON.parse(result.body).name, 'identity');
    assert.equal(JSON.parse(result.body).url, url);
  }
  check('realm-protocol-static-resource-and-encoded-query-forwarding');
  const forbidden = [
    '/admin/',
    '/admin/realms/git-code-reviewer',
    '/realms/master',
    '/health/ready',
    '/metrics',
    '/',
    '/realms/git-code-reviewer-other',
    '/resources-other',
    '/realms/git-code-reviewer/../../admin',
    '/realms/git-code-reviewer/%2e%2e/master',
    '/realms/git-code-reviewer/%252e%252e/master',
    '/realms/git-code-reviewer/..;/master',
    '/realms/git-code-reviewer/\\..\\master',
    '/realms//git-code-reviewer',
    '//realms/git-code-reviewer',
    '/resources/../admin',
    '/resources%2f..%2fadmin',
    'https://identity.test/resources/a',
  ];
  const countBefore = observed.length;
  for (const url of forbidden)
    assert.equal((await fetch(url, { host: `identity.test:${port}` })).status, 404, url);
  for (const host of [
    `evil.test:${port}`,
    'identity.test',
    `identity.test.:${port}`,
    `identity.test:${port}@evil.test`,
  ])
    assert.equal((await fetch('/resources/a', { host })).status, 404);
  assert.equal(observed.length, countBefore);
  check('public-admin-master-management-and-ambiguous-paths-never-reach-backend');
  const postBody = 'SAMLResponse=opaque%2B%2F%3D&RelayState=opaque';
  const post = JSON.parse(
    (
      await fetch('/auth/saml/acs', {
        method: 'POST',
        body: postBody,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: '__Host-gcr_saml_tx=opaque',
          origin: `https://identity.test:${port}`,
          forwarded: 'for=attacker;proto=http',
          'x-forwarded-host': 'attacker.test',
          'x-forwarded-proto': 'http',
          'x-forwarded-port': '80',
          'x-forwarded-for': 'attacker',
          'x-original-forwarded-for': 'attacker',
          'x-real-ip': 'attacker',
          'x-original-url': '/admin',
          traceparent: 'attacker',
          'x-b3-traceid': 'attacker',
          connection: 'close, x-hop-only',
          'x-hop-only': 'attacker',
        },
      })
    ).body,
  );
  assert.equal(post.body, postBody);
  assert.equal(post.method, 'POST');
  assert.equal(post.headers.cookie, '__Host-gcr_saml_tx=opaque');
  assert.equal(post.headers.origin, `https://identity.test:${port}`);
  assert.equal(post.headers.host, `gcr.test:${port}`);
  assert.equal(post.headers['x-forwarded-host'], `gcr.test:${port}`);
  assert.equal(post.headers['x-forwarded-proto'], 'https');
  assert.equal(post.headers['x-forwarded-port'], String(port));
  assert.equal(post.headers['x-forwarded-for'], '127.0.0.1');
  for (const header of [
    'forwarded',
    'x-original-forwarded-for',
    'x-real-ip',
    'x-original-url',
    'traceparent',
    'x-b3-traceid',
    'x-hop-only',
  ])
    assert.equal(post.headers[header], undefined, header);
  check('SAML-POST-body-cookie-origin-preservation-and-proxy-header-overwrite');
  const redirect = await fetch('/redirect');
  assert.equal(redirect.status, 302);
  assert.equal(
    redirect.headers.location,
    'https://identity.test/realms/git-code-reviewer/protocol/saml?SAMLRequest=opaque',
  );
  assert.deepEqual(redirect.headers['set-cookie'], [
    '__Host-gcr_saml_tx=opaque; Secure; HttpOnly; Path=/; SameSite=None',
    'second=opaque; Secure; Path=/',
  ]);
  assert.equal(redirect.headers['x-hop-only'], undefined);
  check('redirect-and-multiple-secure-SameSite-cookies-preserved');
  const events = await getResponse('/events');
  const iterator = events[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value.toString(), 'data: first\n\n');
  assert.equal(events.complete, false);
  finishEvents();
  let rest = '';
  for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) rest += chunk.toString();
  assert.equal(rest, 'data: last\n\n');
  check('SSE-first-event-received-before-backend-completes');
  assert.equal((await fetch('/abort')).status, 502);
  check('upstream-disconnect-returns-static-502');
  for (const patch of [
    { publicHost: undefined },
    { identityHost: 'bad..test' },
    { realm: undefined },
    { realm: 'master' },
    { port: 443 },
    { publicHost: 'wrong.test' },
    { key: await readFile(path.join(directory, 'ca.key')) },
    { appUpstream: 'https://localhost/' },
    { identityUpstream: 'http://user:password@localhost/' },
    { identityUpstream: 'http://localhost/admin' },
  ])
    assert.throws(() => validateProxySettings({ ...settings, ...patch }));
  check('invalid-host-realm-port-upstream-and-TLS-key-material-refused');
  await assert.rejects(() => fetch('/health/ready', { servername: 'wrong.test' }), {
    code: 'ERR_TLS_CERT_ALTNAME_INVALID',
  });
  await assert.rejects(() => fetch('/health/ready', { ca: certificate }));
  check('client-rejects-untrusted-chain-and-hostname-mismatch');
  async function rawRequest(value) {
    const socket = tls.connect({ host: '127.0.0.1', port, servername: 'gcr.test', ca });
    socket.setTimeout(10_000, () => socket.destroy(Error('raw probe timeout')));
    socket.once('secureConnect', () => socket.end(value));
    return bodyOf(socket);
  }
  assert.match(
    await rawRequest(
      `GET /resources/a HTTP/1.1\r\nHost: identity.test:${port}\r\nHost: gcr.test:${port}\r\nConnection: close\r\n\r\n`,
    ),
    /^HTTP\/1.1 (400|404)/,
  );
  assert.match(
    await rawRequest(
      `GET /events HTTP/1.1\r\nHost: gcr.test:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
    ),
    /^HTTP\/1.1 400/,
  );
  check('duplicate-Host-and-unsupported-upgrade-refused');
  const env = {
    ...process.env,
    NODE_EXTRA_CA_CERTS: path.join(directory, 'ca.crt'),
    GCR_PUBLIC_HOST: 'gcr.test',
    GCR_HTTPS_PORT: String(port),
  };
  await execFile(process.execPath, ['deploy/identity/https-proxy.mjs', '--healthcheck'], {
    cwd: root,
    env,
    timeout: 10_000,
  });
  await assert.rejects(() =>
    execFile(process.execPath, ['deploy/identity/https-proxy.mjs', '--healthcheck'], {
      cwd: root,
      env: { ...env, GCR_PUBLIC_HOST: 'wrong.test' },
      timeout: 10_000,
    }),
  );
  check('container-healthcheck-uses-verified-TLS-and-fails-wrong-host');
  evidence.sourceSha256 = createHash('sha256')
    .update(await readFile(path.join(root, 'deploy/identity/https-proxy.mjs')))
    .digest('hex');
  evidence.success = true;
} catch (error) {
  evidence.success = false;
  evidence.failure =
    error instanceof assert.AssertionError ? error.message : 'Proxy fixture failed';
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.destroy();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
  evidence.cleanup = true;
  evidence.completedAt = new Date().toISOString();
  if (process.env.GCR_IDENTITY_PROXY_EVIDENCE)
    await writeFile(
      process.env.GCR_IDENTITY_PROXY_EVIDENCE,
      JSON.stringify(evidence, null, 2) + '\n',
      { flag: 'wx' },
    );
  console.log(JSON.stringify(evidence, null, 2));
}
