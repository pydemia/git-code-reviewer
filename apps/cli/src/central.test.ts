import { createServer, type Server } from 'node:https';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  canonicalKnowledgeJson,
  encodeKnowledgeBundle,
  KNOWLEDGE_SIGNATURE_CONTEXT,
  type CentralKnowledgeBundle,
  type KnowledgeManifestPayload,
} from '@gcr/client-contract';
import {
  contentHash,
  LocalRecordStore,
  PlatformLocalKeyStore,
  PlatformCentralCredentialStore,
  discoverLocalIdentity,
  type CentralCredentialStore,
  type LocalKeyStore,
  type LocalReviewExecutor,
} from '@gcr/client-core';
import { executeCli } from './cli.js';

let root: string, repo: string, data: string, configFile: string, server: Server, origin: string;
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
let config: Record<string, unknown>;
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
const review: LocalReviewExecutor['review'] = async (request) => {
  models++;
  expect(request.prompt).toContain('CENTRAL_INSTRUCTION');
  const reads = [];
  for (const side of ['source', 'base'])
    reads.push(JSON.parse(await request.source.execute('read_file', { path: 'a.ts', side })));
  return {
    model: descriptor.model,
    raw: JSON.stringify({
      summary: 'Read central policy and fixed source/base',
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
          instructions: 'CENTRAL_INSTRUCTION: inspect current code and base',
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
    refreshAfter: new Date(now + 240_000).toISOString(),
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
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const value = 0;\n');
  git('add', '.');
  git('commit', '-m', 'base');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const value = 1;\n');
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
    if (status !== 200) {
      res.statusCode = status;
      res.end('{}');
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
          clientId: 'gcr-cli',
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
      expect((await invoke('revoked', [...args('review', id), '--offline'])).exitCode).toBe(2);
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
      expect((await invoke('expiry', [...args('review', id), '--offline'])).exitCode).toBe(2);
      expect(models).toBe(before);
    } finally {
      vi.restoreAllMocks();
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

it.skipIf(process.env.GCR_CENTRAL_OS_SMOKE !== '1' || process.platform !== 'darwin')(
  'bundled CLI uses macOS Keychain across independent processes',
  async () => {
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
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(Error('CLI smoke timeout'));
        }, 60000);
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
  120000,
);
