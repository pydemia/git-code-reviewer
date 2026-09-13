import { createServer as httpServer, type Server, type RequestListener } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TrustedCentralBinding } from './central-binding.js';
import { KnowledgeHttpTransport } from './knowledge-http.js';
const token = `gcr_key_${randomUUID()}_${randomBytes(32).toString('base64url')}`;
const pair = generateKeyPairSync('ed25519');
const servers: Server[] = [],
  directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const binding = (url: string) =>
  new TrustedCentralBinding({
    serverUrl: url,
    allowLoopbackHttp: true,
    audience: { serverId: 'server', tenantId: 'tenant', repositoryId: 'repo', userId: 'alice' },
    trustedKeys: new Map([['key', pair.publicKey]]),
  });
async function listen(server: Server, scheme = 'http') {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Expected a bound fixture port');
  return `${scheme}://127.0.0.1:${address.port}/base/`;
}
const transport = (url: string, ca?: string) => {
  const b = binding(url);
  return new KnowledgeHttpTransport(b, { bindingId: b.id, readToken: async () => token }, ca);
};
const signal = () => new AbortController().signal;
async function certificate(san: string) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gcr-http-tls-'));
  directories.push(directory);
  const config = path.join(directory, 'openssl.cnf'),
    cert = path.join(directory, 'cert.pem'),
    key = path.join(directory, 'key.pem');
  await writeFile(
    config,
    `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=Fixture\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`,
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-config',
      config,
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore', timeout: 15000 },
  );
  return { cert: await readFile(cert, 'utf8'), key: await readFile(key, 'utf8') };
}
describe('bound central HTTP transport', () => {
  it('waits for initial publication on 503 and rereads the bound credential before retrying', async () => {
    const requests: number[] = [];
    let reads = 0;
    const origin = await listen(
      httpServer((_req, res) => {
        requests.push(Date.now());
        res.writeHead(requests.length === 1 ? 503 : 200);
        res.end(requests.length === 1 ? '{}' : '{"ready":true}');
      }),
    );
    const b = binding(origin);
    const client = new KnowledgeHttpTransport(b, {
      bindingId: b.id,
      readToken: async () => {
        reads++;
        return token;
      },
    });
    expect(await client.initialPublication().manifest({ signal: signal() })).toEqual({
      status: 200,
      manifest: { ready: true },
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]! - requests[0]!).toBeGreaterThanOrEqual(700);
    expect(reads).toBe(2);
  }, 10000);
  it('cancels initial publication backoff before another request', async () => {
    let requests = 0;
    const controller = new AbortController();
    const origin = await listen(
      httpServer((_req, res) => {
        requests++;
        res.writeHead(503);
        res.end('{}');
        setTimeout(() => controller.abort(), 30);
      }),
    );
    const started = Date.now();
    await expect(
      transport(origin).initialPublication().manifest({ signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(700);
    expect(requests).toBe(1);
  });
  it('stops when access is revoked during initial publication', async () => {
    let requests = 0;
    const origin = await listen(
      httpServer((_req, res) => {
        requests++;
        res.writeHead(requests === 1 ? 503 : 403);
        res.end('{}');
      }),
    );
    expect(await transport(origin).initialPublication().manifest({ signal: signal() })).toEqual({
      status: 403,
    });
    expect(requests).toBe(2);
  }, 10000);
  it.each([401, 403, 404, 409, 426, 429, 500, 502, 504, 307])(
    'does not retry HTTP %s during initial publication',
    async (status) => {
      let requests = 0;
      const origin = await listen(
        httpServer((_req, res) => {
          requests++;
          res.writeHead(status, { location: '/elsewhere' });
          res.end('{}');
        }),
      );
      expect(await transport(origin).initialPublication().manifest({ signal: signal() })).toEqual({
        status: status === 307 ? 503 : status,
      });
      expect(requests).toBe(1);
    },
  );
  it('does not retry malformed successful responses', async () => {
    let requests = 0;
    const origin = await listen(
      httpServer((_req, res) => {
        requests++;
        res.end('not-json');
      }),
    );
    await expect(
      transport(origin).initialPublication().manifest({ signal: signal() }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(requests).toBe(1);
  });
  it('preserves base paths, sends only the explicitly bound bearer and supports conditional requests', async () => {
    const requests: {
      url?: string;
      authorization?: string;
      cookie?: string;
      server?: string | string[];
      etag?: string;
    }[] = [];
    const origin = await listen(
      httpServer((req, res) => {
        requests.push({
          url: req.url,
          authorization: req.headers.authorization,
          cookie: req.headers.cookie,
          server: req.headers['x-gcr-server-id'],
          etag: req.headers['if-none-match'],
        });
        if (req.headers['if-none-match']) {
          res.writeHead(304);
          res.end();
        } else {
          res.writeHead(200);
          res.end('{"fixture":true}');
        }
      }),
    );
    const client = transport(origin);
    expect(await client.manifest({ signal: signal() })).toEqual({
      status: 200,
      manifest: { fixture: true },
    });
    expect(await client.manifest({ signal: signal(), etag: '"known"' })).toEqual({ status: 304 });
    expect(requests[0]).toEqual({
      url: '/base/api/v1/repositories/repo/review-knowledge/manifest?clientContractVersion=2',
      authorization: `Bearer ${token}`,
      cookie: undefined,
      server: 'server',
      etag: undefined,
    });
    expect(requests[1]?.etag).toBe('"known"');
  });
  it('does not follow redirects or send a credential to their destination', async () => {
    let calls = 0;
    const destination = await listen(
      httpServer((_req, res) => {
        calls++;
        res.end('{}');
      }),
    );
    const origin = await listen(
      httpServer((_req, res) => {
        res.writeHead(307, { location: destination });
        res.end();
      }),
    );
    expect(await transport(origin).manifest({ signal: signal() })).toEqual({ status: 503 });
    expect(calls).toBe(0);
  });
  it('requires a trusted certificate and matching hostname before sending the bearer', async () => {
    const good = await certificate('IP:127.0.0.1');
    let calls = 0;
    const handler: RequestListener = (_req, res) => {
      calls++;
      res.end('{}');
    };
    const origin = await listen(httpsServer(good, handler), 'https');
    await expect(transport(origin).manifest({ signal: signal() })).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(calls).toBe(0);
    expect(await transport(origin, good.cert).manifest({ signal: signal() })).toEqual({
      status: 200,
      manifest: {},
    });
    expect(calls).toBe(1);
    const wrong = await certificate('DNS:wrong.invalid');
    const bad = await listen(httpsServer(wrong, handler), 'https');
    await expect(transport(bad, wrong.cert).manifest({ signal: signal() })).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(calls).toBe(1);
  }, 20000);
  it.each([401, 403, 409, 426, 429, 503] as const)(
    'preserves HTTP %s without returning error bodies',
    async (status) => {
      const origin = await listen(
        httpServer((_req, res) => {
          res.writeHead(status);
          res.end('PRIVATE_ERROR_DETAIL');
        }),
      );
      expect(await transport(origin).manifest({ signal: signal() })).toEqual({ status });
    },
  );
  it.each(['oversized', 'utf8', 'json'])('rejects an invalid %s manifest body', async (kind) => {
    const origin = await listen(
      httpServer((_req, res) => {
        res.end(
          kind === 'oversized'
            ? Buffer.alloc(65537, 32)
            : kind === 'utf8'
              ? Buffer.from([0xff])
              : 'not json',
        );
      }),
    );
    await expect(transport(origin).manifest({ signal: signal() })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
  it('does not send a late credential after cancellation or after its binding changes', async () => {
    let requests = 0;
    const origin = await listen(
      httpServer((_req, res) => {
        requests++;
        res.end('{}');
      }),
    );
    const b = binding(origin);
    let release!: (value: string) => void;
    const credential = {
      bindingId: b.id,
      readToken: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    };
    const client = new KnowledgeHttpTransport(b, credential);
    const controller = new AbortController();
    const pending = client.manifest({ signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'unavailable' });
    controller.abort();
    release(token);
    await assertion;
    expect(requests).toBe(0);
    const changing = client.manifest({ signal: signal() });
    const rejected = expect(changing).rejects.toMatchObject({ code: 'invalid-binding' });
    credential.bindingId = 'different';
    release(token);
    await rejected;
    await expect(client.manifest({ signal: signal() })).rejects.toMatchObject({
      code: 'invalid-binding',
    });
    expect(requests).toBe(0);
  });
  it('does not expose errors returned by the credential port', async () => {
    const b = binding('https://fixture.invalid');
    const client = new KnowledgeHttpTransport(b, {
      bindingId: b.id,
      readToken: async () => {
        throw Error('PRIVATE_CREDENTIAL_ERROR');
      },
    });
    await expect(client.manifest({ signal: signal() })).rejects.toMatchObject({
      code: 'unavailable',
      message: 'Central HTTP request failed.',
    });
  });
});
