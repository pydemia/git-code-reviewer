import { createServer, type Server } from 'node:https';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  canonicalKnowledgeJson,
  reviewSubmission,
  encodeKnowledgeBundle,
  KNOWLEDGE_SIGNATURE_CONTEXT,
  type CentralKnowledgeBundle,
  type KnowledgeManifestPayload,
} from '@gcr/client-contract';
import {
  contentHash,
  LocalRecordStore,
  ReviewRequests,
  PlatformLocalKeyStore,
  PlatformCentralCredentialStore,
  discoverLocalIdentity,
  CentralConnections,
  callLocalService,
  type CentralCredentialStore,
  type LocalKeyStore,
  type LocalReviewExecutor,
  type LocalReviewChatExecutor,
} from '@gcr/client-core';
import { executeCli } from './cli.js';

let root: string, repo: string, data: string, configFile: string, server: Server, origin: string;
const accountModelSmoke = process.env.GCR_CENTRAL_MODEL_SMOKE === '1';
const policyWitness = `CENTRAL_CENTS_${randomBytes(12).toString('hex')}`;
const signing = generateKeyPairSync('ed25519');
const keyId = randomUUID();
const secret = `gcr_key_${keyId}_${randomBytes(32).toString('base64url')}`;
const keysMap = new Map<string, Buffer>();
const secrets = new Map<string, string>();
const keys: LocalKeyStore = {
  async read(id) {
    const value = keysMap.get(id);
    return value && Buffer.from(value);
  },
  async write(id, value) {
    keysMap.set(id, Buffer.from(value));
  },
  async remove(id) {
    keysMap.delete(id);
  },
};
const credentials: CentralCredentialStore = {
  async read(id) {
    return secrets.get(id);
  },
  async write(id, value) {
    secrets.set(id, value);
  },
  async remove(id) {
    secrets.delete(id);
  },
};
const audience = { serverId: 'server', tenantId: 'tenant', repositoryId: 'repo', userId: 'alice' };
let calls = 0,
  models = 0,
  status = 200,
  wrongIdentity = false;
let initialManifestStatuses: number[] = [];
const submitted = new Map<string, unknown>();
let submissionError: string | undefined;
let onInitialManifest: (() => void) | undefined;
let config: Record<string, unknown>;
let identityClientId: 'gcr-cli' | 'commit-defender' = 'gcr-cli';
const descriptor = {
  id: 'synthetic',
  version: '1',
  model: 'fixture-model',
  configHash: contentHash('fixture'),
  capabilities: {
    available: true,
    sourceIsolation: 'fixed-source-only' as const,
    cancellation: true,
    timeout: true,
    childProcessCleanup: true,
    outputTokenLimit: false,
  },
};
const reviewer =
  (central: boolean): LocalReviewExecutor['review'] =>
  async (request) => {
    models++;
    if (central) expect(request.prompt).toContain('CENTRAL_INSTRUCTION');
    else expect(request.prompt).not.toContain('CENTRAL_INSTRUCTION');
    const reads = [];
    for (const side of ['source', 'base'])
      reads.push(JSON.parse(await request.source.execute('read_file', { path: 'a.ts', side })));
    return {
      model: descriptor.model,
      raw: JSON.stringify({
        summary: central
          ? 'Read central policy and fixed source/base'
          : 'Read local knowledge and fixed source/base',
        files: [
          {
            path: 'a.ts',
            side: 'source',
            complete: true,
            summary: 'Reviewed',
            readIds: reads.map((r) => r.readId),
          },
        ],
        findings: [],
        questions: [],
      }),
    };
  };
const review = reviewer(true);
const localReview = reviewer(false);
function manifest() {
  const common = { schemaVersion: 2 as const, tenantId: 'tenant', repositoryId: 'repo' };
  const b: Record<'policy' | 'collective' | 'personal', CentralKnowledgeBundle> = {
    policy: {
      ...common,
      component: 'policy',
      ownerUserId: null,
      criteria: [],
      skills: {
        schemaVersion: 1,
        hash: contentHash('skills'),
        skills: Array.from({ length: 4 }, (_, i) => ({
          name: `skill-${i}`,
          title: 'Review',
          kind: 'perspective',
          unit: 'file',
          version: 1,
          enabled: true,
          instructions:
            'CENTRAL_INSTRUCTION: inspect current code and base' +
            (accountModelSmoke
              ? `\nRepository contract for a.ts: total() receives amounts already in cents and must return their sum in cents. Converting the result to dollars violates the API contract. Cite policy reference ${policyWitness} in a finding about this contract.`
              : ''),
          markdown: '# Review',
          contentHash: contentHash(`skill-${i}`),
        })),
      },
    },
    collective: { ...common, component: 'collective', ownerUserId: null, memories: [] },
    personal: { ...common, component: 'personal', ownerUserId: 'alice', memories: [] },
  };
  const bytes = Object.fromEntries(
    Object.entries(b).map(([k, v]) => [k, Buffer.from(encodeKnowledgeBundle(v))]),
  );
  const now = Date.now();
  const payload: KnowledgeManifestPayload = {
    schemaVersion: 1,
    audience,
    snapshotId: 'snapshot',
    authorizationRevision: 1,
    components: Object.fromEntries(
      Object.entries(bytes).map(([k, v]) => [
        k,
        {
          bundleId: k,
          releaseSequence: 1,
          contentHash: createHash('sha256').update(v).digest('hex'),
          sizeBytes: v.length,
        },
      ]),
    ) as KnowledgeManifestPayload['components'],
    revocations: {
      policyMinimumSequence: 1,
      collectiveMinimumSequence: 1,
      personalMinimumSequence: 1,
    },
    compatibleClientContracts: { minimum: 2, maximum: 2 },
    issuedAt: new Date(now - 1000).toISOString(),
    refreshAfter: new Date(now + (accountModelSmoke ? 299_000 : 240_000)).toISOString(),
    offlineValidUntil: new Date(now + 3600_000).toISOString(),
    signingKeyId: 'key',
  };
  const encoded = canonicalKnowledgeJson(payload);
  return {
    bytes,
    signed: {
      payload,
      manifestHash: createHash('sha256').update(encoded).digest('hex'),
      signature: sign(
        null,
        Buffer.from(KNOWLEDGE_SIGNATURE_CONTEXT + encoded),
        signing.privateKey,
      ).toString('base64url'),
    },
  };
}
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcr-connected-cli-'));
  repo = path.join(root, 'repo');
  data = path.join(root, 'private');
  fs.mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      {
        stdio: 'pipe',
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      },
    );
  git('init', '-b', 'main');
  fs.writeFileSync(
    path.join(repo, 'a.ts'),
    accountModelSmoke
      ? 'export function total(amounts: number[]): number {\n  return amounts.reduce((sum, amount) => sum + amount, 0);\n}\n'
      : 'export const value = 0;\n',
  );
  if (accountModelSmoke) {
    fs.writeFileSync(
      path.join(repo, 'caller.ts'),
      "import { total } from './a.js';\n\nexport function invoice() {\n  return { amountCents: total([125, 75]), currency: 'USD' };\n}\n",
    );
    fs.writeFileSync(
      path.join(repo, 'a.test.ts'),
      "import assert from 'node:assert/strict';\nimport { total } from './a.js';\n\nassert.equal(total([125, 75]), 200);\nassert.equal(total([]), 0);\n",
    );
  }
  git('add', '.');
  git('commit', '-m', 'base');
  fs.writeFileSync(
    path.join(repo, 'a.ts'),
    accountModelSmoke
      ? 'export function total(amounts: number[]): number {\n  return amounts.reduce((sum, amount) => sum + amount, 0) / 100;\n}\n'
      : 'export const value = 1;\n',
  );
  git('add', '.');
  const cert = path.join(root, 'cert.pem'),
    key = path.join(root, 'key.pem'),
    cnf = path.join(root, 'openssl.cnf');
  fs.writeFileSync(
    cnf,
    '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=Fixture\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n',
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
      cnf,
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore', timeout: 15000 },
  );
  const published = manifest();
  server = createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    calls++;
    res.setHeader('content-type', 'application/json');
    if (
      req.headers.authorization !== `Bearer ${secret}` ||
      req.headers['x-gcr-server-id'] !== 'server'
    ) {
      res.statusCode = 403;
      res.end('{}');
      return;
    }
    expect(req.headers.cookie).toBeUndefined();
    if (req.url?.includes('/review-knowledge/manifest') && initialManifestStatuses.length) {
      res.writeHead(initialManifestStatuses.shift()!);
      res.end('{}');
      onInitialManifest?.();
      return;
    }
    if (status !== 200) {
      res.statusCode = status;
      res.end('{}');
      return;
    }
    if (req.method === 'POST' && req.url?.includes('/review-submissions/')) {
      if (submissionError) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: { code: submissionError } }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        try {
          const input = reviewSubmission(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          const prior = submitted.get(input.id);
          const receipt = prior ?? {
            schemaVersion: 1,
            id: randomUUID(),
            requestId: input.id,
            payloadHash: contentHash(input),
            audience: input.audience,
            clientId: input.clientId,
            kind: input.kind,
            status: 'submitted',
            evidence: 'client-reported',
            receivedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
          };
          submitted.set(input.id, receipt);
          res.statusCode = prior ? 200 : 201;
          res.end(JSON.stringify(receipt));
        } catch {
          res.statusCode = 400;
          res.end('{}');
        }
      });
      return;
    }
    if (req.url === '/base/api/v1/client-repositories/repo') {
      expect(req.method).toBe('GET');
      expect(req.headers['content-length']).toBeUndefined();
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          serverId: 'server',
          tenantId: 'tenant',
          repositoryId: 'repo',
          instanceId: 'github',
          webBaseUrl: 'https://github.example',
          owner: 'team',
          name: 'reviewer',
        }),
      );
      return;
    }
    if (req.url === '/base/api/v1/client-auth/me') {
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          serverId: 'server',
          tenantId: 'tenant',
          userId: wrongIdentity ? 'other' : 'alice',
          displayName: 'Fixture',
          repositoryIds: ['repo'],
          scopes: ['knowledge:read'],
          clientId: identityClientId,
          keyId,
          expiresAt: new Date(Date.now() + 7200_000).toISOString(),
        }),
      );
      return;
    }
    if (req.url?.includes('/manifest?clientContractVersion=2')) {
      res.end(JSON.stringify(published.signed));
      return;
    }
    const part = /\/bundles\/(policy|collective|personal)\?snapshotId=snapshot$/.exec(
      req.url ?? '',
    )?.[1];
    if (part) {
      res.end(published.bytes[part]);
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('fixture');
  origin = `https://127.0.0.1:${address.port}/base/`;
  config = {
    serverUrl: origin,
    serverId: 'server',
    tenantId: 'tenant',
    repositoryId: 'repo',
    trustedKeys: [
      { id: 'key', pem: signing.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    ],
    ca: fs.readFileSync(cert, 'utf8'),
  };
  configFile = path.join(root, 'connection.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
}, 20_000);
afterAll(async () => {
  if (server)
    await new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
const invoke = (profile: string, args: string[], worker = review) =>
  executeCli([...args, '--cwd', repo, '--profile', profile, '--data-dir', data], {
    keys,
    credentials,
    readStdin: async () => secret,
    prepareExecutor: async () => ({ descriptor, review: worker }),
  });
const connect = async (profile: string, file = configFile) => {
  const result = await invoke(profile, [
    'central',
    'connect',
    '--mode',
    'centralized',
    '--input',
    file,
    '--api-key-stdin',
  ]);
  expect(result.exitCode, JSON.stringify(result.value)).toBe(0);
  return (result.value as { id: string }).id;
};
const args = (command: string, id: string) => [
  command,
  '--mode',
  'centralized',
  '--connection',
  id,
];
const test = (name: string, fn: () => Promise<void>) => it(name, fn, 30000);
describe.sequential('explicit connected CLI over HTTPS', () => {
  test('binds a matching remote and rejects mismatches and later remote changes before model execution', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    const profile = 'remote-binding';
    let id: string | undefined;
    git(
      'remote',
      'add',
      'origin',
      'https://user:PRIVATE_REMOTE_TOKEN@github.example/fork/reviewer.git',
    );
    try {
      const before = secrets.size;
      const rejected = await invoke(profile, [
        'central',
        'connect',
        '--mode',
        'centralized',
        '--input',
        configFile,
        '--api-key-stdin',
      ]);
      expect(rejected.exitCode).toBe(2);
      expect(JSON.stringify(rejected)).not.toContain('PRIVATE_REMOTE_TOKEN');
      expect(secrets.size).toBe(before);
      git('remote', 'set-url', 'origin', 'git@github.example:team/reviewer.git');
      id = await connect(profile);
      const status = await invoke(profile, [
        'central',
        'status',
        '--mode',
        'centralized',
        '--connection',
        id,
      ]);
      expect(status.value).toMatchObject({
        repositoryBinding: { identity: { repositoryId: 'repo', owner: 'team', name: 'reviewer' } },
      });
      expect((await invoke(profile, args('context', id))).exitCode).toBe(0);
      git('remote', 'set-url', 'origin', 'git@another.example:team/reviewer.git');
      const beforeModels = models;
      const result = await invoke(profile, [...args('review', id), '--offline']);
      expect(result.exitCode).toBe(2);
      expect(models).toBe(beforeModels);
      expect(JSON.stringify(result)).toContain('repository-mismatch');
    } finally {
      if (id)
        expect(
          (
            await invoke(profile, [
              'central',
              'disconnect',
              '--mode',
              'centralized',
              '--connection',
              id,
            ])
          ).exitCode,
        ).toBe(0);
      git('remote', 'remove', 'origin');
    }
  });
  test('executes an explicitly registered CD connection in the service while ordinary CLI access remains denied', async () => {
    const profileId = 'cd-service',
      identity = discoverLocalIdentity(repo, profileId);
    const connections = await CentralConnections.open({
      dataDirectory: data,
      keys,
      credentials,
      scope: {
        kind: 'repository',
        profileId,
        repositoryKey: identity.repositoryKey,
        worktreeKey: identity.worktreeKey,
      },
    });
    const controller = new AbortController();
    let running: ReturnType<typeof executeCli> | undefined;
    const common = ['--cwd', repo, '--profile', profileId, '--data-dir', data];
    const location = { profileId, dataDirectory: data };
    const wait = async <T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> => {
      const deadline = Date.now() + 20000;
      for (;;) {
        const value = await read();
        if (ready(value)) return value;
        if (Date.now() > deadline) throw Error('CD service did not settle');
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    };
    try {
      identityClientId = 'commit-defender';
      const connection = await connections.connect(config, secret, 'commit-defender');
      expect((await invoke(profileId, args('context', connection.id))).exitCode).toBe(2);
      running = executeCli(['service', 'run', ...common], {
        keys,
        credentials,
        signal: controller.signal,
        prepareExecutor: async () => ({ descriptor, review }),
      });
      await wait(
        () => invoke(profileId, ['service', 'status']),
        (result) => result.exitCode === 0,
      );
      await callLocalService(location, {
        action: 'register',
        root: repo,
        triggers: ['save'],
        options: {
          mode: 'centralized',
          connectionId: connection.id,
          centralClientId: 'commit-defender',
          model: 'gpt-6-astra',
          reasoningEffort: 'xhigh',
          excludePatterns: [],
          allowPaths: ['**'],
          durationMs: 120000,
          sourceBytes: 1048576,
          toolCalls: 100,
        },
      });
      const before = models;
      const queued = await invoke(profileId, ['enqueue', '--trigger', 'save']);
      expect(queued.exitCode, JSON.stringify(queued.value)).toBe(0);
      const id = (queued.value as { receipt: { id: string } }).receipt.id;
      const terminal = await wait(
        () => invoke(profileId, ['service', 'job', '--id', id]),
        (result) =>
          ['finished', 'interrupted', 'cancelled'].includes(
            (result.value as { state: string }).state,
          ),
      );
      expect(terminal.value).toMatchObject({ state: 'finished', result: { status: 'completed' } });
      expect(models).toBe(before + 1);
      expect((await invoke(profileId, args('context', connection.id))).exitCode).toBe(2);
    } finally {
      controller.abort();
      await running;
      connections.close();
      identityClientId = 'gcr-cli';
    }
  });
  test('reconciles saved central completion only while the original connection remains authorized', async () => {
    for (const revoke of [false, true]) {
      const profile = `central-recovery-${revoke}`,
        id = await connect(profile);
      const failedWrite = vi
        .spyOn(ReviewRequests.prototype, 'finish')
        .mockRejectedValueOnce(Error('request journal fixture'));
      let original;
      try {
        original = await invoke(profile, args('review', id));
      } finally {
        failedWrite.mockRestore();
      }
      expect(original.exitCode).toBe(2);
      expect(original.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'request-completion-unconfirmed' }),
        ]),
      );
      const pending = (await invoke(profile, ['requests'])).value as Array<{
        key: string;
        generation: number;
        state: string;
      }>;
      expect(pending).toHaveLength(1);
      const request = pending[0]!;
      expect(request.state).toBe('interrupted');
      const before = models;
      try {
        if (revoke) {
          status = 403;
          expect(
            (await invoke(profile, ['central', 'sync', ...args('unused', id).slice(1)])).exitCode,
          ).toBe(2);
        }
        const result = await invoke(profile, [
          'requests',
          'reconcile',
          '--key',
          request.key,
          '--generation',
          String(request.generation),
          ...args('unused', id).slice(1),
        ]);
        expect(result.exitCode, JSON.stringify(result)).toBe(revoke ? 2 : 0);
        if (!revoke)
          expect(result.value).toMatchObject({ status: 'reconciled', report: original.value });
        expect(models).toBe(before);
      } finally {
        status = 200;
      }
    }
  });
  test('continues the original central conversation after sync and blocks answers after confirmed revocation', async () => {
    const profile = 'central-chat',
      id = await connect(profile);
    const result = await invoke(profile, args('review', id));
    expect(result.exitCode).toBe(0);
    const runId = (result.value as { runId: string }).runId;
    const converse = vi.fn<LocalReviewChatExecutor['converse']>(async (input) => {
      expect(input.prompt).toContain('CENTRAL_INSTRUCTION');
      await input.source.execute('read_file', { path: 'a.ts' });
      await input.questions.askUser('central-question', {
        question: 'Keep integer cents?',
        options: ['Yes', 'No'],
      });
      throw Error('Question checkpoint');
    });
    const chat = (action: string, body?: unknown) =>
      executeCli(
        [
          'chat',
          action,
          runId,
          ...args('unused', id).slice(1),
          '--cwd',
          repo,
          '--profile',
          profile,
          '--data-dir',
          data,
          ...(body ? ['--input', '-'] : []),
        ],
        {
          keys,
          credentials,
          readStdin: async () => JSON.stringify(body),
          prepareExecutor: async () => ({
            descriptor,
            review,
            conversationCapability: 'checkpoint-tool-v1',
            converse,
          }),
        },
      );
    expect((await chat('read')).exitCode).toBe(0);
    expect(
      (await invoke(profile, ['central', 'sync', ...args('unused', id).slice(1)])).exitCode,
    ).toBe(0);
    const sent = await chat('send', { turnId: 'central-turn', content: 'Explain.' });
    expect(sent.exitCode, JSON.stringify(sent)).toBe(1);
    const saved = sent.value as {
      conversation: { turns: Array<{ questions: Array<{ id: string }> }> };
    };
    const questionId = saved.conversation.turns[0]!.questions[0]!.id;
    status = 403;
    try {
      expect(
        (await invoke(profile, ['central', 'sync', ...args('unused', id).slice(1)])).exitCode,
      ).toBe(2);
      expect(
        (await chat('answer', { turnId: 'central-turn', questionId, content: 'Yes' })).exitCode,
      ).toBe(2);
      expect((await chat('read')).exitCode).toBe(2);
      expect(converse).toHaveBeenCalledTimes(1);
    } finally {
      status = 200;
    }
  });
  test('waits for initial publication and activates only the complete signed cache', async () => {
    initialManifestStatuses = [503];
    let observed!: () => void;
    const initial = new Promise<void>((resolve) => {
      observed = resolve;
    });
    onInitialManifest = observed;
    try {
      const pending = connect('first-publication');
      await initial;
      const list = await invoke('first-publication', ['central', 'list', '--mode', 'centralized']);
      expect(list.value).toEqual([expect.objectContaining({ status: 'pending' })]);
      const id = await pending;
      expect((await invoke('first-publication', args('context', id))).value).toMatchObject({
        status: 'ready',
      });
    } finally {
      initialManifestStatuses = [];
      onInitialManifest = undefined;
    }
  });
  test('cancels initial publication without leaving a usable connection or credential', async () => {
    const before = secrets.size;
    const controller = new AbortController();
    initialManifestStatuses = [503];
    onInitialManifest = () => controller.abort();
    try {
      const result = await executeCli(
        [
          'central',
          'connect',
          '--mode',
          'centralized',
          '--input',
          configFile,
          '--api-key-stdin',
          '--cwd',
          repo,
          '--profile',
          'cancel-publication',
          '--data-dir',
          data,
        ],
        {
          keys,
          credentials,
          readStdin: async () => secret,
          signal: controller.signal,
        },
      );
      expect(result.exitCode).toBe(2);
      expect(result.value).toMatchObject({ status: 'cancelled' });
      expect(secrets.size).toBe(before);
      const list = await invoke('cancel-publication', ['central', 'list', '--mode', 'centralized']);
      expect(list.value).toEqual([expect.objectContaining({ status: 'disconnected' })]);
    } finally {
      initialManifestStatuses = [];
      onInitialManifest = undefined;
    }
  });
  test('bounds the initial publication claim to sixty seconds and removes its credential on timeout', async () => {
    const before = secrets.size;
    initialManifestStatuses = [503];
    let observed!: () => void;
    const initial = new Promise<void>((resolve) => {
      observed = resolve;
    });
    onInitialManifest = observed;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = invoke('publication-timeout', [
        'central',
        'connect',
        '--mode',
        'centralized',
        '--input',
        configFile,
        '--api-key-stdin',
      ]);
      await initial;
      await vi.advanceTimersByTimeAsync(60000);
      const result = await pending;
      expect(result.exitCode).toBe(2);
      expect(result.value).toMatchObject({ error: { code: 'timeout' } });
      expect(secrets.size).toBe(before);
      const list = await invoke('publication-timeout', [
        'central',
        'list',
        '--mode',
        'centralized',
      ]);
      expect(list.value).toEqual([expect.objectContaining({ status: 'disconnected' })]);
    } finally {
      vi.useRealTimers();
      initialManifestStatuses = [];
      onInitialManifest = undefined;
    }
  });
  test('connects, synchronizes and executes a central review through real source/base tools', async () => {
    const id = await connect('review');
    const before = models;
    const context = await invoke('review', args('context', id));
    expect(context.exitCode).toBe(0);
    expect(context.value).toMatchObject({
      status: 'ready',
      client: { mode: 'centralized', audience },
    });
    expect(models).toBe(before);
    const result = await invoke('review', args('review', id));
    expect(result.exitCode).toBe(0);
    expect(result.value).toMatchObject({
      status: 'completed',
      identity: { client: { mode: 'centralized', audience } },
    });
    expect((result.value as { evidence: unknown[] }).evidence).toHaveLength(2);
    expect(models).toBe(before + 1);
    expect(JSON.stringify(result)).not.toContain(secret);
    const runId = (result.value as { runId: string }).runId;
    expect(
      (await invoke('review', ['result', runId, ...args('unused', id).slice(1)])).exitCode,
    ).toBe(0);
    expect((await invoke('review', ['result', runId])).exitCode).toBe(2);
  });
  test('does not auto-select a connection or contact central from standalone', async () => {
    await connect('isolation');
    const before = calls;
    expect((await invoke('isolation', ['context'])).exitCode).toBe(0);
    expect((await invoke('isolation', ['review', '--mode', 'centralized'])).exitCode).toBe(2);
    expect(calls).toBe(before);
    const rejected = await invoke('isolation', [
      'central',
      'connect',
      '--input',
      configFile,
      '--api-key',
      secret,
    ]);
    expect(rejected.exitCode).toBe(2);
    expect(JSON.stringify(rejected)).not.toContain(secret);
  });
  test('keeps tokens out of local encrypted records, status and connection listings', async () => {
    const id = await connect('storage');
    const outputs = [
      await invoke('storage', ['central', 'list', '--mode', 'centralized']),
      await invoke('storage', ['central', 'status', ...args('unused', id).slice(1)]),
    ];
    expect(JSON.stringify(outputs)).not.toContain(secret);
    expect(JSON.stringify(outputs)).not.toContain('BEGIN PUBLIC KEY');
    const walk = (directory: string): string[] =>
      fs
        .readdirSync(directory, { withFileTypes: true })
        .flatMap((e) =>
          e.isDirectory() ? walk(path.join(directory, e.name)) : [path.join(directory, e.name)],
        );
    for (const file of walk(data))
      expect(fs.readFileSync(file).includes(Buffer.from(secret))).toBe(false);
    expect([...secrets.values()].filter((v) => v === secret).length).toBeGreaterThan(0);
  });
  test('refuses a mismatched signed audience without retaining a usable connection or token', async () => {
    const before = secrets.size;
    wrongIdentity = true;
    try {
      const result = await invoke('mismatch', [
        'central',
        'connect',
        '--mode',
        'centralized',
        '--input',
        configFile,
        '--api-key-stdin',
      ]);
      expect(result.exitCode).toBe(2);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(secrets.size).toBe(before);
    } finally {
      wrongIdentity = false;
    }
  });
  test('refuses untrusted TLS and invalid signature pins', async () => {
    for (const [name, override] of [
      ['tls', { ca: null }],
      [
        'signature',
        {
          trustedKeys: [
            {
              id: 'key',
              pem: generateKeyPairSync('ed25519')
                .publicKey.export({ type: 'spki', format: 'pem' })
                .toString(),
            },
          ],
        },
      ],
    ] as const) {
      const file = path.join(root, `${name}.json`);
      fs.writeFileSync(file, JSON.stringify({ ...config, ...override }));
      const before = secrets.size;
      const result = await invoke(name, [
        'central',
        'connect',
        '--mode',
        'centralized',
        '--input',
        file,
        '--api-key-stdin',
      ]);
      expect(result.exitCode).toBe(2);
      expect(secrets.size).toBe(before);
    }
  });
  test('supports explicit offline review after a server outage without making network requests', async () => {
    const id = await connect('offline');
    status = 503;
    try {
      expect(
        (await invoke('offline', ['central', 'sync', ...args('unused', id).slice(1)])).exitCode,
      ).toBe(2);
      const before = calls;
      const result = await invoke('offline', [...args('review', id), '--offline']);
      expect(result.exitCode, JSON.stringify(result.value)).toBe(0);
      expect(calls).toBe(before);
    } finally {
      status = 200;
    }
  });
  test('blocks offline use after a confirmed server revocation', async () => {
    const id = await connect('revoked');
    status = 403;
    try {
      expect(
        (await invoke('revoked', ['central', 'sync', ...args('unused', id).slice(1)])).exitCode,
      ).toBe(2);
      const before = models;
      expect(
        (
          await invoke('revoked', [
            ...args('review', id),
            '--offline',
            '--offline-behavior',
            'cache-only',
          ])
        ).exitCode,
      ).toBe(2);
      expect(models).toBe(before);
    } finally {
      status = 200;
    }
  });
  test('disconnects only its profile and rejects the old context after reconnecting the same audience', async () => {
    const id = await connect('lifecycle');
    let begin!: () => void;
    const started = new Promise<void>((r) => {
      begin = r;
    });
    let release!: () => void;
    const pending = invoke('lifecycle', args('review', id), async () => {
      begin();
      await new Promise<void>((r) => {
        release = r;
      });
      return { model: descriptor.model, raw: '{}' };
    });
    await Promise.race([
      started,
      pending.then((result) => {
        throw Error(JSON.stringify(result));
      }),
    ]);
    expect(
      (await invoke('lifecycle', ['central', 'disconnect', ...args('unused', id).slice(1)]))
        .exitCode,
    ).toBe(0);
    expect(await connect('lifecycle')).toBe(id);
    const result = await pending;
    expect(result.value).toMatchObject({ status: 'cancelled' });
    release();
    expect((await invoke('lifecycle', args('context', id))).exitCode).toBe(0);
  });
  test('rejects an expired API key before any offline model invocation', async () => {
    const id = await connect('expiry');
    const before = models;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 7200_001);
    try {
      expect(
        (
          await invoke('expiry', [
            ...args('review', id),
            '--offline',
            '--offline-behavior',
            'cache-only',
          ])
        ).exitCode,
      ).toBe(2);
      expect(models).toBe(before);
    } finally {
      vi.restoreAllMocks();
    }
  });
  test('uses cached central knowledge during outage and stores explicit local fallback separately', async () => {
    const id = await connect('automatic-fallback');
    status = 503;
    try {
      await invoke('automatic-fallback', ['central', 'sync', ...args('unused', id).slice(1)]);
      const cached = await invoke('automatic-fallback', args('review', id));
      expect(cached.exitCode, JSON.stringify(cached.value)).toBe(0);
      expect(cached.value).toMatchObject({
        identity: {
          client: {
            mode: 'centralized',
            execution: {
              configuredMode: 'centralized',
              effectiveMode: 'centralized',
              knowledgeSource: 'central-cache',
              fallbackReason: 'unavailable',
            },
          },
        },
      });
      const fallback = await invoke(
        'automatic-fallback',
        [...args('review', id), '--offline-behavior', 'standalone'],
        localReview,
      );
      expect(fallback.exitCode, JSON.stringify(fallback.value)).toBe(0);
      const report = fallback.value as import('@gcr/client-contract').ClientReviewReport;
      expect(report.identity.client).toMatchObject({
        mode: 'standalone',
        execution: {
          configuredMode: 'centralized',
          effectiveMode: 'standalone',
          knowledgeSource: 'local',
          fallbackReason: 'unavailable',
          connectionId: id,
        },
      });
      expect(report.identity.context.centralSnapshot).toBeUndefined();
      expect(report.identity.context.entries.every((entry) => entry.origin !== 'central')).toBe(
        true,
      );
      expect((await invoke('automatic-fallback', ['result', report.runId])).value).toEqual(report);
      expect(
        (
          await invoke('automatic-fallback', [
            'result',
            report.runId,
            ...args('unused', id).slice(1),
          ])
        ).value,
      ).toEqual(report);
      expect(
        (
          await invoke('automatic-fallback', [
            'chat',
            'read',
            report.runId,
            ...args('unused', id).slice(1),
          ])
        ).value,
      ).toMatchObject({ review: report, conversation: { turns: [] } });
      expect(
        (await invoke('automatic-fallback', ['history', ...args('unused', id).slice(1)])).value,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runId: report.runId,
            execution: report.identity.client.execution,
          }),
        ]),
      );
      expect((await invoke('other-profile', ['result', report.runId])).exitCode).toBe(2);
      const before = models;
      expect(
        (await invoke('automatic-fallback', [...args('review', id), '--offline-behavior', 'pause']))
          .exitCode,
      ).toBe(2);
      expect(models).toBe(before);
    } finally {
      status = 200;
    }
  });
  test('default confirmed fallback after revocation uses only local knowledge and retains readable local history', async () => {
    const id = await connect('revoked-fallback');
    status = 403;
    try {
      await invoke('revoked-fallback', ['central', 'sync', ...args('unused', id).slice(1)]);
      const fallback = await invoke('revoked-fallback', args('review', id), localReview);
      expect(fallback.exitCode, JSON.stringify(fallback.value)).toBe(0);
      const report = fallback.value as import('@gcr/client-contract').ClientReviewReport;
      expect(report.identity.client.execution).toMatchObject({
        effectiveMode: 'standalone',
        knowledgeSource: 'local',
        fallbackReason: 'authentication-required',
      });
      expect(report.identity.context.centralSnapshot).toBeUndefined();
      expect(
        (
          await invoke('revoked-fallback', [
            'chat',
            'read',
            report.runId,
            ...args('unused', id).slice(1),
          ])
        ).value,
      ).toMatchObject({ review: report, conversation: { turns: [] } });
      expect(
        (await invoke('revoked-fallback', ['result', report.runId, ...args('unused', id).slice(1)]))
          .value,
      ).toEqual(report);
    } finally {
      status = 200;
    }
  });
  test('first snapshot failure returns the confirmed connection for local fallback without retaining its key', async () => {
    const before = secrets.size;
    initialManifestStatuses = [403];
    try {
      const connected = await invoke('initial-fallback', [
        'central',
        'connect',
        '--mode',
        'centralized',
        '--input',
        configFile,
        '--api-key-stdin',
      ]);
      expect(connected.exitCode).toBe(2);
      expect(secrets.size).toBe(before);
      const id = (connected.value as { connectionId: string }).connectionId;
      expect(id).toMatch(/^[a-f0-9]{64}$/);
      const fallback = await invoke('initial-fallback', args('review', id), localReview);
      expect(fallback.exitCode, JSON.stringify(fallback.value)).toBe(0);
      expect(fallback.value).toMatchObject({
        identity: {
          client: {
            mode: 'standalone',
            execution: {
              connectionId: id,
              configuredMode: 'centralized',
              knowledgeSource: 'local',
            },
          },
        },
      });
    } finally {
      initialManifestStatuses = [];
    }
  });
  test('fences concurrent connection registrations without overwriting an active key', async () => {
    const before = secrets.size;
    const request = [
      'central',
      'connect',
      '--mode',
      'centralized',
      '--input',
      configFile,
      '--api-key-stdin',
    ];
    const results = await Promise.all([
      invoke('concurrent', request),
      invoke('concurrent', request),
    ]);
    expect(results.map((r) => r.exitCode).sort()).toEqual([0, 2]);
    expect(secrets.size).toBe(before + 1);
  });
});

it.skipIf(
  (process.env.GCR_CENTRAL_OS_SMOKE !== '1' && !accountModelSmoke) || process.platform !== 'darwin',
)(
  'bundled CLI uses macOS Keychain across independent processes',
  async () => {
    if (accountModelSmoke) expect(process.env.GCR_CODEX_EXECUTABLE).toBeTruthy();
    const profile = 'gcr-os-' + randomUUID();
    const directory = path.join(root, 'os-data');
    let id: string | undefined;
    const run = (args: string[], input = '') =>
      new Promise<{ code: number | null; value: Record<string, unknown> }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            path.resolve(process.env.GCR_CENTRAL_CLI_ENTRY ?? 'apps/cli/dist/main.js'),
            ...args,
            '--cwd',
            repo,
            '--profile',
            profile,
            '--data-dir',
            directory,
          ],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        );
        const chunks: Buffer[] = [];
        child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        child.stderr.resume();
        const timer = setTimeout(
          () => {
            child.kill('SIGKILL');
            reject(Error('CLI smoke timeout'));
          },
          args[0] === 'review' ? 360000 : 60000,
        );
        child.once('error', () => {
          clearTimeout(timer);
          reject(Error('CLI smoke launch failed'));
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          try {
            resolve({ code, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch {
            reject(Error('CLI smoke response invalid'));
          }
        });
        child.stdin.end(input);
      });
    try {
      const connected = await run(
        ['central', 'connect', '--mode', 'centralized', '--input', configFile, '--api-key-stdin'],
        secret + '\n',
      );
      expect(connected.code, JSON.stringify(connected.value)).toBe(0);
      id = String(connected.value.id);
      const context = await run(['context', '--mode', 'centralized', '--connection', id]);
      expect(context.code, JSON.stringify(context.value)).toBe(0);
      expect(context.value).toMatchObject({
        status: 'ready',
        client: { mode: 'centralized', audience },
      });
      const sync = await run(['central', 'sync', '--mode', 'centralized', '--connection', id]);
      expect(sync.code).toBe(0);
      if (accountModelSmoke) {
        const reviewed = await run([
          'review',
          '--mode',
          'centralized',
          '--connection',
          id,
          '--executor-path',
          process.env.GCR_CODEX_EXECUTABLE!,
          '--timeout-ms',
          '240000',
        ]);
        // Persist only the public structured report over synthetic source, never CLI/account logs.
        expect(JSON.stringify(reviewed)).not.toContain(secret);
        if (process.env.GCR_CENTRAL_MODEL_EVIDENCE)
          fs.writeFileSync(
            process.env.GCR_CENTRAL_MODEL_EVIDENCE,
            JSON.stringify(
              {
                syntheticData: true,
                actualAccountModel: true,
                model: 'gpt-6-astra',
                reasoningEffort: 'xhigh',
                policyWitness,
                ...reviewed,
              },
              null,
              2,
            ) + '\n',
          );
        // Completed findings requiring follow-up use exit 1; exit 2 means incomplete.
        expect(reviewed.code, JSON.stringify(reviewed.value)).toBe(1);
        expect(reviewed.value).toMatchObject({
          status: 'completed',
          identity: { client: { mode: 'centralized', audience } },
        });
        const findings = reviewed.value.findings as unknown[];
        expect(findings.length).toBeGreaterThan(0);
        expect(JSON.stringify(findings)).toContain(policyWitness);
        expect((reviewed.value.evidence as unknown[]).length).toBeGreaterThanOrEqual(2);
        const history = await run([
          'result',
          String(reviewed.value.runId),
          '--mode',
          'centralized',
          '--connection',
          id,
        ]);
        expect(history.code).toBe(1);
        expect(history.value).toEqual(reviewed.value);
      }
      const disconnected = await run([
        'central',
        'disconnect',
        '--mode',
        'centralized',
        '--connection',
        id,
      ]);
      expect(disconnected.code).toBe(0);
      expect(disconnected.value.credentialCleanupPending).toBe(false);
      expect(
        (await run(['context', '--mode', 'centralized', '--connection', id, '--offline'])).code,
      ).toBe(2);
    } finally {
      if (id) {
        const client = discoverLocalIdentity(repo, profile);
        const records = await LocalRecordStore.open({
          scope: {
            kind: 'repository',
            profileId: profile,
            repositoryKey: client.repositoryKey,
            worktreeKey: client.worktreeKey,
          },
          dataDirectory: path.join(directory, 'central-connections'),
        });
        try {
          const row = await records.read('settings', id);
          if (row && !row.deleted)
            await new PlatformCentralCredentialStore().remove(
              (row.value as { credentialReference: string }).credentialReference,
            );
        } finally {
          records.close();
        }
      }
      const references: Array<{ profileId: string; id: string }> = [];
      const walk = (folder: string) => {
        if (!fs.existsSync(folder)) return;
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
          const file = path.join(folder, entry.name);
          if (entry.isDirectory()) walk(file);
          else if (entry.name === 'key-ref.json')
            references.push(JSON.parse(fs.readFileSync(file, 'utf8')));
        }
      };
      walk(directory);
      const store = new PlatformLocalKeyStore();
      for (const reference of references) {
        expect(reference.profileId).toBe(profile);
        await store.remove(`${reference.profileId}.${reference.id}`);
      }
    }
  },
  420000,
);

it('rejects submission and remote-model commands without uploading or calling a model', async () => {
  const before = models,
    uploaded = submitted.size;
  for (const command of ['submit-review', 'feedback', 'remote-review']) {
    const result = await executeCli([command, 'send', 'old-request', '--cwd', repo], {
      keys,
      credentials,
    });
    expect(result.exitCode).toBe(2);
  }
  expect(models).toBe(before);
  expect(submitted.size).toBe(uploaded);
});
