import { createServer, type Server } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import {
  clientReviewReport,
  type RemoteReviewPayload,
  type RemoteReviewStatus,
} from '@gcr/client-contract';
import { TrustedCentralBinding } from './central-binding.js';
import { KnowledgeHttpTransport } from './knowledge-http.js';
import { RemoteReviewClient } from './remote-review-client.js';
import { contentHash } from './local-identity.js';
import { builtinReviewSkill } from './builtin-review.js';
import {
  prepareRemoteReviewHandle,
  validateRemoteReviewRequest,
  verifyRemoteReviewResult,
} from './remote-review.js';

const audience = { serverId: 'server', tenantId: 'tenant', repositoryId: 'repo', userId: 'user' };
const client = {
  mode: 'standalone' as const,
  profileId: 'profile',
  repositoryKey: 'a'.repeat(64),
  worktreeKey: 'b'.repeat(64),
};
const resources: { server: Server; root: string; clients: RemoteReviewClient[] }[] = [];
afterEach(async () => {
  for (const r of resources.splice(0)) {
    r.clients.forEach((c) => c.close());
    await new Promise<void>((resolve) => {
      r.server.closeAllConnections();
      r.server.close(() => resolve());
    });
    await rm(r.root, { recursive: true, force: true });
  }
});
function request() {
  const text = 'export const NEVER_PERSIST_SOURCE = 1;\n';
  const p: RemoteReviewPayload = {
    schemaVersion: 1,
    requestId: randomUUID(),
    audience,
    clientId: 'gcr-cli',
    client,
    executor: 'central',
    model: { accountId: 'account', name: 'gpt-6-astra', reasoningEffort: 'xhigh' },
    source: {
      provenance: 'client-captured',
      snapshot: {
        kind: 'working-tree',
        hash: 'c'.repeat(64),
        objectFormat: 'sha1',
        baseCommit: null,
        baseTree: 'd'.repeat(40),
      },
      files: [
        {
          metadata: {
            path: 'app.ts',
            side: 'source',
            hash: createHash('sha256').update(text).digest('hex'),
            byteLength: Buffer.byteLength(text),
            lineCount: 2,
          },
          text,
        },
      ],
      selected: [{ path: 'app.ts', side: 'source' }],
      review: {
        incomplete: false,
        changes: [{ path: 'app.ts', side: 'source', status: 'A', base: 'absent' }],
      },
    },
    context: {
      provenance: 'client-supplied',
      documents: [],
      resolved: {
        version: 1,
        client,
        sourceHash: 'c'.repeat(64),
        originalContextHash: 'e'.repeat(64),
        builtin: {
          id: builtinReviewSkill.id,
          revision: builtinReviewSkill.revision,
          hash: builtinReviewSkill.hash,
        },
        knowledge: [],
        requiredSources: [],
        validUntil: null,
      },
    },
    budget: { modelCalls: 2, durationMs: 120000, sourceBytes: 1048576, toolCalls: 100 },
    retention: { sourceSeconds: 3600, resultSeconds: 86400 },
  };
  return {
    payload: p,
    approval: { payloadHash: contentHash(p), approvedAt: new Date().toISOString() },
  };
}
function status(input: ReturnType<typeof request>): RemoteReviewStatus {
  const received = Date.now();
  return {
    schemaVersion: 1,
    requestId: input.payload.requestId,
    audience,
    clientId: 'gcr-cli',
    payloadHash: input.approval.payloadHash,
    receivedAt: new Date(received).toISOString(),
    sourceExpiresAt: new Date(received + 3600000).toISOString(),
    resultExpiresAt: new Date(received + 86400000).toISOString(),
    state: 'queued',
  };
}
function report(input: ReturnType<typeof request>) {
  const h = prepareRemoteReviewHandle(input),
    at = new Date().toISOString();
  return clientReviewReport({
    contractVersion: 1,
    runId: 'remote-run',
    identity: {
      client: h.client,
      source: h.source,
      context: { hash: h.contextHash, entries: [], required: [] },
      reviewProfile: { id: 'profile', revision: 1, hash: 'f'.repeat(64) },
      executor: { id: 'central', version: '1', model: h.model, configHash: h.executorConfigHash },
      toolsHash: 'a'.repeat(64),
    },
    status: 'completed',
    trigger: 'manual',
    requestedAt: at,
    startedAt: at,
    finishedAt: at,
    durationMs: 0,
    summary: 'Synthetic transport fixture, not a model execution.',
    sourceFiles: h.sourceFiles,
    files: h.sourceFiles.map((source) => ({ source, status: 'completed', summary: '' })),
    excluded: [],
    problems: [],
    findings: [],
    evidence: [],
    questions: [],
  });
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'gcr-remote-client-'));
  const state = {
    dropAck: false,
    posts: 0,
    admissions: 0,
    cancels: 0,
    connected: true,
    responseCode: 0,
    errorCode: '',
    redirect: '',
    receipt: null as RemoteReviewStatus | null,
    result: null as ReturnType<typeof report> | null,
    requestBodies: [] as unknown[],
  };
  const token = `gcr_key_${randomUUID()}_${randomBytes(32).toString('base64url')}`;
  const server = createServer(async (req, res) => {
    if (
      req.headers.authorization !== `Bearer ${token}` ||
      req.headers['x-gcr-server-id'] !== audience.serverId
    ) {
      res.writeHead(401).end();
      return;
    }
    if (state.responseCode) {
      res.writeHead(state.responseCode, {
        ...(state.redirect ? { location: state.redirect } : {}),
      });
      res.end(
        JSON.stringify({ error: { code: state.errorCode, message: 'PRIVATE_SERVER_ERROR' } }),
      );
      return;
    }
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : undefined;
    if (req.method === 'POST' && req.url === '/base/api/v1/repositories/repo/remote-reviews') {
      state.posts++;
      state.requestBodies.push(body);
      const input = validateRemoteReviewRequest(body, { audience, clientId: 'gcr-cli' });
      if (!state.receipt) {
        state.admissions++;
        state.receipt = status(input);
      }
      if (state.receipt.payloadHash !== input.approval.payloadHash) {
        res.writeHead(409).end('{}');
        return;
      }
      if (state.dropAck) {
        req.socket.destroy();
        return;
      }
      res.writeHead(201).end(JSON.stringify(state.receipt));
      return;
    }
    if (!state.receipt) {
      res.writeHead(404).end('{}');
      return;
    }
    if (req.url?.endsWith('/cancel')) {
      state.cancels++;
      if (body.payloadHash !== state.receipt.payloadHash) {
        res.writeHead(409).end('{}');
        return;
      }
      state.receipt = { ...state.receipt, state: 'cancelled', reason: 'cancelled' };
    }
    res
      .writeHead(200)
      .end(
        JSON.stringify(
          req.url?.endsWith('/result')
            ? { status: state.receipt, report: state.result }
            : state.receipt,
        ),
      );
  });
  const clients: RemoteReviewClient[] = [];
  resources.push({ root, server, clients });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('port');
  const binding = new TrustedCentralBinding({
    serverUrl: `http://127.0.0.1:${address.port}/base/`,
    allowLoopbackHttp: true,
    audience,
    trustedKeys: new Map([['key', generateKeyPairSync('ed25519').publicKey]]),
  });
  const transport = new KnowledgeHttpTransport(binding, {
    bindingId: binding.id,
    readToken: async () => token,
  });
  const connections = {
    status: async () => ({
      id: binding.id,
      revision: 1,
      status: state.connected ? ('connected' as const) : ('disconnected' as const),
      serverUrl: binding.serverUrl,
      audience,
      offlineBehavior: 'pause' as const,
      keyId: 'key',
      clientId: 'gcr-cli' as const,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      cache: { status: 'unavailable' as const },
    }),
    submitRemoteReview: (
      _id: string,
      input: Parameters<KnowledgeHttpTransport['submitRemoteReview']>[0],
      signal = new AbortController().signal,
    ) => transport.submitRemoteReview(input, signal),
    remoteReviewStatus: (
      _id: string,
      h: Parameters<KnowledgeHttpTransport['remoteReviewStatus']>[0],
      signal = new AbortController().signal,
    ) => transport.remoteReviewStatus(h, signal),
    remoteReviewResult: (
      _id: string,
      h: Parameters<KnowledgeHttpTransport['remoteReviewResult']>[0],
      signal = new AbortController().signal,
    ) => transport.remoteReviewResult(h, signal),
    cancelRemoteReview: (
      _id: string,
      h: Parameters<KnowledgeHttpTransport['cancelRemoteReview']>[0],
      signal = new AbortController().signal,
    ) => transport.cancelRemoteReview(h, signal),
  };
  const values = new Map<string, Buffer>();
  const keys = {
    read: async (id: string) => (values.has(id) ? Buffer.from(values.get(id)!) : undefined),
    write: async (id: string, value: Uint8Array) => {
      values.set(id, Buffer.from(value));
    },
    remove: async (id: string) => {
      values.delete(id);
    },
  };
  const open = async () => {
    const c = await RemoteReviewClient.open({
      scope: {
        kind: 'repository',
        profileId: client.profileId,
        repositoryKey: client.repositoryKey,
        worktreeKey: client.worktreeKey,
      },
      keys,
      dataDirectory: root,
      connectionId: binding.id,
      connections,
    });
    clients.push(c);
    return c;
  };
  return { root, state, open, transport, binding, connections, keys };
}
it('recovers a lost POST acknowledgement after reopening without sending source twice', async () => {
  const f = await fixture(),
    c = await f.open(),
    input = request();
  f.state.dropAck = true;
  await expect(c.submit(input)).rejects.toMatchObject({ code: 'delivery-unconfirmed' });
  expect((await c.get(input.payload.requestId)).status).toBeNull();
  c.close();
  const reopened = await f.open();
  expect((await reopened.submit(input)).status?.state).toBe('queued');
  expect(f.state.posts).toBe(1);
  expect(f.state.admissions).toBe(1);
  f.state.result = report(input);
  f.state.receipt = {
    ...f.state.receipt!,
    state: 'completed',
    reportHash: contentHash(f.state.result),
  };
  expect((await reopened.result(input.payload.requestId)).report.runId).toBe('remote-run');
  const metadata = JSON.stringify(await reopened.list());
  expect(metadata).not.toContain('NEVER_PERSIST_SOURCE');
  expect(metadata).not.toContain('Synthetic transport fixture');
  async function scan(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await scan(file);
      else {
        const text = (await readFile(file)).toString();
        expect(text).not.toContain('NEVER_PERSIST_SOURCE');
        expect(text).not.toContain('app.ts');
      }
    }
  }
  await scan(f.root);
});
it('persists the fence before a network failure and requires explicit same-payload retry after 404', async () => {
  const f = await fixture(),
    c = await f.open(),
    input = request();
  f.state.responseCode = 503;
  await expect(c.submit(input)).rejects.toMatchObject({ statusCode: 503 });
  f.state.responseCode = 0;
  await expect(c.submit(input)).rejects.toMatchObject({ statusCode: 404 });
  expect(f.state.posts).toBe(0);
  const changed = structuredClone(input);
  changed.payload.model.accountId = 'other';
  changed.approval.payloadHash = contentHash(changed.payload);
  await expect(c.retrySubmission(changed)).rejects.toThrow('remote-request-conflict');
  expect((await c.retrySubmission(input)).status?.state).toBe('queued');
  expect(f.state.posts).toBe(1);
});
it('leaves cancellation unconfirmed after a lost response and forbids resubmission', async () => {
  const f = await fixture(),
    c = await f.open(),
    input = request();
  await c.submit(input);
  f.state.responseCode = 503;
  await expect(c.cancel(input.payload.requestId)).rejects.toMatchObject({ statusCode: 503 });
  expect((await c.get(input.payload.requestId)).cancellationRequested).toBe(true);
  await expect(c.retrySubmission(input)).rejects.toThrow('remote-cancellation-requested');
  f.state.responseCode = 0;
  expect((await c.cancel(input.payload.requestId)).status?.state).toBe('cancelled');
  expect(f.state.posts).toBe(1);
});
it('does not send after approval expiry, disconnect or an aborted wait', async () => {
  const f = await fixture(),
    c = await f.open(),
    input = request();
  input.approval.approvedAt = new Date(Date.now() - 360000).toISOString();
  await expect(c.submit(input)).rejects.toMatchObject({ code: 'approval-expired' });
  expect(f.state.posts).toBe(0);
  input.approval.approvedAt = new Date().toISOString();
  f.state.connected = false;
  await expect(c.submit(input)).rejects.toThrow('remote-selection-changed');
  f.state.connected = true;
  const controller = new AbortController();
  controller.abort();
  await expect(c.submit(input, controller.signal)).rejects.toMatchObject({
    code: 'delivery-unconfirmed',
  });
  expect(f.state.posts).toBe(0);
  expect((await c.get(input.payload.requestId)).status).toBeNull();
});
it('detaches approved source before asynchronous credential and record access', async () => {
  const f = await fixture(),
    c = await f.open(),
    input = request(),
    original = structuredClone(input);
  const pending = c.submit(input);
  input.payload.model.accountId = 'other';
  input.payload.requestId = 'changed';
  await pending;
  expect(f.state.requestBodies).toEqual([original]);
});
it('concurrent clients admit one submission and preserve the durable fence', async () => {
  const f = await fixture(),
    a = await f.open(),
    b = await f.open(),
    input = request();
  await Promise.allSettled([a.submit(input), b.submit(input)]);
  expect(f.state.posts).toBe(1);
  expect(f.state.admissions).toBe(1);
  expect((await a.refresh(input.payload.requestId)).status?.state).toBe('queued');
});
it.each(['payloadHash', 'audience', 'retention'] as const)(
  'rejects a mismatched %s receipt',
  async (kind) => {
    const f = await fixture(),
      c = await f.open(),
      input = request();
    await c.submit(input);
    if (kind === 'payloadHash') f.state.receipt!.payloadHash = 'f'.repeat(64);
    if (kind === 'audience') f.state.receipt!.audience = { ...audience, userId: 'other' };
    if (kind === 'retention') f.state.receipt!.sourceExpiresAt = f.state.receipt!.resultExpiresAt;
    await expect(c.refresh(input.payload.requestId)).rejects.toMatchObject({
      code: 'response-mismatch',
    });
  },
);
it.each(['hash', 'account', 'source', 'context', 'model', 'files'] as const)(
  'rejects a mismatched %s report even when self-consistently hashed',
  async (kind) => {
    const f = await fixture(),
      c = await f.open(),
      input = request();
    await c.submit(input);
    const r = report(input);
    if (kind === 'account') r.identity.executor.configHash = '0'.repeat(64);
    if (kind === 'source') r.identity.source.hash = '0'.repeat(64);
    if (kind === 'context') r.identity.context.hash = '0'.repeat(64);
    if (kind === 'model') r.identity.executor.model = 'other';
    if (kind === 'files') {
      r.sourceFiles[0]!.hash = '0'.repeat(64);
      r.files[0]!.source.hash = '0'.repeat(64);
    }
    f.state.result = r;
    f.state.receipt = {
      ...f.state.receipt!,
      state: 'completed',
      reportHash: kind === 'hash' ? '0'.repeat(64) : contentHash(r),
    };
    await expect(c.result(input.payload.requestId)).rejects.toMatchObject({
      code: 'response-mismatch',
    });
  },
);
it('preserves partial results and a known terminal state on stale polling', async () => {
  const f = await fixture(),
    c = await f.open(),
    input = request();
  await c.submit(input);
  const queued = f.state.receipt!;
  const r = report(input);
  r.status = 'partial';
  r.problems = [{ code: 'response-incomplete', message: 'Fixture incomplete.' }];
  f.state.result = r;
  f.state.receipt = { ...queued, state: 'completed', reportHash: contentHash(r) };
  expect((await c.result(input.payload.requestId)).report.status).toBe('partial');
  f.state.receipt = queued;
  expect((await c.refresh(input.payload.requestId)).status?.state).toBe('completed');
});
it('never follows redirects or exposes server error bodies and propagates known authority failure', async () => {
  const f = await fixture(),
    input = request(),
    h = prepareRemoteReviewHandle(input);
  for (const [status, code, authority] of [
    [401, 'CLIENT_AUTHENTICATION_REQUIRED', 'authentication-required'],
    [403, 'CLIENT_ACCESS_REVOKED', 'revoked'],
    [503, 'IDENTITY_UNAVAILABLE', 'identity-unavailable'],
  ] as const) {
    f.state.responseCode = status;
    f.state.errorCode = code;
    await expect(
      f.transport.remoteReviewStatus(h, new AbortController().signal),
    ).rejects.toMatchObject({ statusCode: status, authorityFailure: authority });
  }
  f.state.responseCode = 307;
  f.state.redirect = f.binding.serverUrl + 'redirect-target';
  await expect(
    f.transport.submitRemoteReview(input, new AbortController().signal),
  ).rejects.toMatchObject({ statusCode: 307, message: 'http-error' });
  expect(f.state.posts).toBe(0);
});
it('accepts only the report belonging to the recorded completed receipt', () => {
  const input = request(),
    h = prepareRemoteReviewHandle(input),
    r = report(input);
  const receipt: RemoteReviewStatus = {
    ...status(input),
    state: 'completed',
    reportHash: contentHash(r),
  };
  const changed = structuredClone(r);
  changed.summary = 'Replacement';
  expect(() =>
    verifyRemoteReviewResult(
      h,
      { status: { ...receipt, reportHash: contentHash(changed) }, report: changed },
      receipt,
    ),
  ).toThrow('response-mismatch');
});
it('polls transient read conflicts without repeating submission and stops on a terminal state', async () => {
  const f = await fixture(),
    c = await f.open(),
    input = request();
  await c.submit(input);
  f.state.responseCode = 409;
  const timer = setTimeout(() => {
    f.state.responseCode = 0;
    f.state.receipt = { ...f.state.receipt!, state: 'uncertain', reason: 'execution-lost' };
  }, 80);
  try {
    expect(
      (await c.wait(input.payload.requestId, { timeoutMs: 1000, intervalMs: 10 })).status?.state,
    ).toBe('uncertain');
    expect(f.state.posts).toBe(1);
    expect(f.state.cancels).toBe(0);
  } finally {
    clearTimeout(timer);
  }
});
it('ends a timed out or cancelled wait as unconfirmed and never retries authority failures', async () => {
  const f = await fixture(),
    c = await f.open(),
    input = request();
  await c.submit(input);
  await expect(
    c.wait(input.payload.requestId, { timeoutMs: 40, intervalMs: 10 }),
  ).rejects.toMatchObject({ code: 'delivery-unconfirmed' });
  const controller = new AbortController();
  controller.abort();
  await expect(
    c.wait(input.payload.requestId, { signal: controller.signal }),
  ).rejects.toMatchObject({ code: 'delivery-unconfirmed' });
  f.state.responseCode = 503;
  f.state.errorCode = 'IDENTITY_UNAVAILABLE';
  await expect(
    c.wait(input.payload.requestId, { timeoutMs: 1000, intervalMs: 10 }),
  ).rejects.toMatchObject({ authorityFailure: 'identity-unavailable' });
  expect(f.state.posts).toBe(1);
  expect(f.state.cancels).toBe(0);
  expect((await c.get(input.payload.requestId)).status?.state).toBe('queued');
});
