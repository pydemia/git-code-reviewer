// Local Compose TLS edge. Keycloak admin/master/management paths have no public route.
import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const hopByHop = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const untrustedProxyHeaders = new Set([
  'forwarded',
  'x-real-ip',
  'x-original-url',
  'x-original-method',
  'traceparent',
  'tracestate',
  'baggage',
  'b3',
  'uber-trace-id',
  'x-ot-span-context',
]);
function transportHeaders(headers) {
  const excluded = new Set(hopByHop);
  for (const name of String(headers.connection ?? '').split(','))
    excluded.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name)));
}
function authority(hostname, port) {
  return `${hostname}:${port}`;
}
export function validateProxySettings(settings) {
  const { publicHost, identityHost, realm, port, key, certificate } = settings;
  const hostname =
    /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
  if (
    typeof publicHost !== 'string' ||
    !hostname.test(publicHost) ||
    typeof identityHost !== 'string' ||
    !hostname.test(identityHost) ||
    publicHost === identityHost ||
    typeof realm !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(realm) ||
    realm === 'master' ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  )
    throw Error('Invalid identity proxy routing configuration');
  const cert = new X509Certificate(certificate);
  if (
    !cert.checkHost(publicHost) ||
    !cert.checkHost(identityHost) ||
    Date.parse(cert.validFrom) > Date.now() ||
    Date.parse(cert.validTo) <= Date.now() ||
    !cert.publicKey
      .export({ type: 'spki', format: 'der' })
      .equals(createPublicKey(createPrivateKey(key)).export({ type: 'spki', format: 'der' }))
  )
    throw Error('Invalid identity proxy TLS material');
  for (const upstream of [settings.appUpstream, settings.identityUpstream]) {
    const url = new URL(upstream);
    if (
      url.protocol !== 'http:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw Error('Invalid identity proxy upstream');
  }
  return Object.freeze({ ...settings });
}

export function routeRequest(settings, request) {
  // Absolute-form targets, duplicate Host and noncanonical IdP paths must not
  // create a second interpretation at the upstream router.
  const hostCount = request.rawHeaders
    .filter((_, index) => index % 2 === 0)
    .filter((name) => name.toLowerCase() === 'host').length;
  if (
    hostCount !== 1 ||
    !request.url?.startsWith('/') ||
    request.url.startsWith('//') ||
    request.url.length > 8192
  )
    return undefined;
  const host = request.headers.host?.toLowerCase();
  if (host === authority(settings.publicHost, settings.port)) return settings.appUpstream;
  if (host !== authority(settings.identityHost, settings.port)) return undefined;
  const path = request.url.split('?')[0];
  if (
    /[%;\\]/.test(path) ||
    path.includes('//') ||
    path.split('/').some((part) => part === '.' || part === '..')
  )
    return undefined;
  if (new URL(request.url, 'https://identity.invalid').pathname !== path) return undefined;
  for (const prefix of [`/realms/${settings.realm}`, '/resources'])
    if (path === prefix || path.startsWith(prefix + '/')) return settings.identityUpstream;
  return undefined;
}

export function createIdentityProxy(input) {
  const settings = validateProxySettings(input);
  const server = https.createServer(
    {
      key: settings.key,
      cert: settings.certificate,
      minVersion: 'TLSv1.2',
      requestTimeout: 120_000,
      headersTimeout: 15_000,
    },
    (request, response) => {
      const upstream = routeRequest(settings, request);
      if (!upstream) {
        response.writeHead(404, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end('Not found\n');
        return;
      }
      const headers = transportHeaders(request.headers);
      for (const name of Object.keys(headers))
        if (
          untrustedProxyHeaders.has(name) ||
          name.startsWith('x-forwarded-') ||
          name.startsWith('x-original-forwarded-') ||
          name.startsWith('x-b3-')
        )
          delete headers[name];
      const hostname =
        request.headers.host.toLowerCase() === authority(settings.publicHost, settings.port)
          ? settings.publicHost
          : settings.identityHost;
      Object.assign(headers, {
        host: authority(hostname, settings.port),
        'x-forwarded-host': authority(hostname, settings.port),
        'x-forwarded-proto': 'https',
        'x-forwarded-port': String(settings.port),
        'x-forwarded-for': request.socket.remoteAddress,
      });
      const destination = new URL(upstream);
      const outgoing = http.request(
        {
          hostname: destination.hostname,
          port: destination.port || 80,
          method: request.method,
          path: request.url,
          headers,
        },
        (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, transportHeaders(incoming.headers));
          response.flushHeaders();
          incoming.on('error', () => response.destroy());
          incoming.on('aborted', () => response.destroy());
          incoming.pipe(response);
        },
      );
      const fail = () => {
        if (response.headersSent) response.destroy();
        else if (!response.writableEnded) {
          response.writeHead(502, {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
          });
          response.end('Upstream unavailable\n');
        }
      };
      outgoing.on('error', fail);
      outgoing.setTimeout(300_000, () => outgoing.destroy());
      request.on('aborted', () => outgoing.destroy());
      request.on('error', () => outgoing.destroy());
      response.on('close', () => {
        if (!response.writableFinished) outgoing.destroy();
      });
      request.pipe(outgoing);
    },
  );
  server.maxHeadersCount = 100;
  server.on('upgrade', (_request, socket) =>
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'),
  );
  // HTTP/SAML data, query strings, cookies and TLS errors are never access-logged.
  return server;
}

async function main() {
  const port = Number(process.env.GCR_HTTPS_PORT);
  const publicHost = process.env.GCR_PUBLIC_HOST;
  if (process.argv[2] === '--healthcheck') {
    await new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: '127.0.0.1',
        port,
        servername: publicHost,
        rejectUnauthorized: true,
      });
      socket.setTimeout(5000, () => socket.destroy(Error('TLS probe timeout')));
      socket.once('secureConnect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', reject);
    });
    return;
  }
  const server = createIdentityProxy({
    port,
    publicHost,
    identityHost: process.env.GCR_IDENTITY_HOST,
    realm: process.env.GCR_IDENTITY_REALM,
    key: await readFile('/run/secrets/proxy-tls-key'),
    certificate: await readFile('/run/secrets/proxy-tls-cert'),
    appUpstream: 'http://server:4000/',
    identityUpstream: 'http://keycloak:8080/',
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  console.log(JSON.stringify({ component: 'identity-proxy', event: 'listening', port }));
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 90_000).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch(() => {
    console.error('Identity proxy initialization or TLS probe failed');
    process.exitCode = 1;
  });
