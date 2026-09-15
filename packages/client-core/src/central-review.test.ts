import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  canonicalKnowledgeJson,
  centralKnowledgeBundle,
  encodeKnowledgeBundle,
  KNOWLEDGE_SIGNATURE_CONTEXT,
  localKnowledge,
  type CentralKnowledgeBundle,
  type KnowledgeManifestPayload,
  type LocalScope,
  type SourceFile,
  type ClientIdentity,
} from '@gcr/client-contract';
import { CentralKnowledgeCache, type KnowledgeTransport } from './central-cache.js';
import { TrustedCentralBinding } from './central-binding.js';
import { selectCentralKnowledge, selectSharedKnowledge } from './central-selection.js';
import { resolveCentralContext, resolveLocalContext } from './review-context.js';
import { resolveLocalExecutionPolicy } from './review-policy.js';
import { runLocalReview, type LocalReviewExecutor } from './review-runner.js';
import { contentHash, discoverLocalIdentity } from './local-identity.js';
import { captureLocalSource, type LocalSourceSnapshot } from './source-snapshot.js';

const pair = generateKeyPairSync('ed25519');
const audience = { serverId: 'server', tenantId: 'tenant', repositoryId: 'repo', userId: 'alice' };
const scopeTerms = () => ({
  languages: [],
  filePaths: [],
  symbols: [],
  contracts: [],
  branches: [],
});
type Memory = Extract<CentralKnowledgeBundle, { component: 'personal' }>['memories'][number];
function memory(id: string, paths: string[] = []): Memory {
  return {
    id,
    aggregationKey: contentHash('judgment'),
    revision: 1,
    contentHash: contentHash(id),
    sourceRevision: 1,
    sourceContentHash: contentHash('original'),
    kind: 'decision',
    content: {
      summary: `${id} recommendation`,
      detail: 'Historical judgment',
      recommendation: `${id} full decision`,
      categories: [],
      appliesTo: { ...scopeTerms(), filePaths: paths },
      counterEvidence: [`${id} counter-evidence`],
      expiresAt: null,
    },
    sources: [{ kind: 'memory', id: 'original', contentHash: contentHash('original') }],
    sourceBaseSha: null,
    sourceHeadSha: null,
    supersedesId: null,
  };
}
function bundles(): Record<'policy' | 'collective' | 'personal', CentralKnowledgeBundle> {
  const common = { schemaVersion: 2 as const, tenantId: 'tenant', repositoryId: 'repo' };
  return {
    policy: {
      ...common,
      component: 'policy',
      ownerUserId: null,
      criteria: [
        {
          id: 'criterion',
          revision: 1,
          contentHash: contentHash('criterion'),
          sourceContentHash: contentHash('criterion-source'),
          document: {
            title: 'Current code',
            topicKey: 'correctness',
            requirement: 'Inspect current code',
            rationale: 'History may be obsolete',
            counterEvidence: ['Already fixed'],
            reviewSteps: ['Read base'],
            appliesTo: scopeTerms(),
            severity: 'P1',
            enforcement: 'advisory',
            reviewAfter: null,
          },
          decision: {
            id: 'decision',
            outcome: 'design-decision',
            sources: [
              {
                kind: 'snapshot-change',
                id: 'central-code-ref',
                contentHash: contentHash('central-code-ref'),
              },
            ],
          },
          exceptions: [],
        },
      ],
      skills: {
        schemaVersion: 1,
        hash: contentHash('skills'),
        skills: Array.from({ length: 4 }, (_, i) => ({
          name: `skill-${i}`,
          title: 'Review',
          kind: 'perspective' as const,
          unit: 'file' as const,
          version: 1,
          enabled: true,
          instructions: 'Read the captured base and current code.',
          markdown: '# Review',
          contentHash: contentHash(`skill-${i}`),
        })),
      },
    },
    collective: {
      ...common,
      component: 'collective',
      ownerUserId: null,
      memories: [memory('collective', ['a.ts'])],
    },
    personal: {
      ...common,
      component: 'personal',
      ownerUserId: 'alice',
      memories: [memory('personal')],
    },
  };
}
const now = () => new Date().toISOString();
const file = (name: string) => ({
  source: {
    path: name,
    side: 'source',
    hash: contentHash(name),
    bytes: 10,
    lineCount: 1,
  } as SourceFile,
  text: 'function load() { return contract; }',
});
const select = (
  b = bundles(),
  options: Partial<Parameters<typeof selectCentralKnowledge>[0]> = {},
) =>
  selectCentralKnowledge({
    bundles: b,
    selected: [file('a.ts'), file('b.ts')],
    branch: 'main',
    now: now(),
    byteLimit: 65_536,
    ...options,
  });
function policyBundle(b: ReturnType<typeof bundles>) {
  if (b.policy.component !== 'policy') throw Error('fixture');
  return b.policy;
}
function memories(b: ReturnType<typeof bundles>, part: 'collective' | 'personal') {
  const v = b[part];
  if (v.component === 'policy') throw Error('fixture');
  return v.memories;
}
function publication(b = bundles(), version = 1, critical = false, authorizationRevision = 1) {
  const parts = ['policy', 'collective', 'personal'] as const;
  const bytes = Object.fromEntries(
    parts.map((p) => [p, Buffer.from(encodeKnowledgeBundle(b[p]))]),
  ) as Record<(typeof parts)[number], Buffer>;
  const timestamp = Date.now();
  const payload: KnowledgeManifestPayload = {
    schemaVersion: 1,
    audience,
    snapshotId: `snapshot-${version}`,
    authorizationRevision,
    components: Object.fromEntries(
      parts.map((p) => [
        p,
        {
          bundleId: `${p}-${version}`,
          releaseSequence: version,
          contentHash: createHash('sha256').update(bytes[p]).digest('hex'),
          sizeBytes: bytes[p].length,
        },
      ]),
    ) as KnowledgeManifestPayload['components'],
    revocations: {
      policyMinimumSequence: critical ? version : 1,
      collectiveMinimumSequence: critical ? version : 1,
      personalMinimumSequence: critical ? version : 1,
    },
    compatibleClientContracts: { minimum: 2, maximum: 2 },
    issuedAt: new Date(timestamp - 1000).toISOString(),
    refreshAfter: new Date(timestamp + 120_000).toISOString(),
    offlineValidUntil: new Date(timestamp + 3600_000).toISOString(),
    signingKeyId: 'key',
  };
  const encoded = canonicalKnowledgeJson(payload);
  const manifest = {
    payload,
    manifestHash: createHash('sha256').update(encoded).digest('hex'),
    signature: sign(
      null,
      Buffer.from(KNOWLEDGE_SIGNATURE_CONTEXT + encoded),
      pair.privateKey,
    ).toString('base64url'),
  };
  const transport: KnowledgeTransport = {
    async manifest() {
      return { status: 200, manifest };
    },
    async bundle(request) {
      return {
        status: 200,
        body: (async function* () {
          yield bytes[request.component];
        })(),
      };
    },
  };
  return { manifest, transport };
}

describe('central scope and deterministic precedence', () => {
  it('retains personal decisions on uncovered files and only evidence on overlapping files', () => {
    const result = select();
    const item = result.items.find((i) => i.id === 'personal')!;
    expect(item.targets.map((t) => t.path)).toEqual(['b.ts']);
    expect(result.precedence.map((p) => p.target.path)).toEqual(['a.ts']);
    const fully = select(bundles(), { selected: [file('a.ts')] });
    const value = JSON.stringify(fully.items.find((i) => i.id === 'personal')!.value);
    expect(value).toContain('personal counter-evidence');
    expect(value).toContain('original');
    expect(value).not.toContain('personal full decision');
    expect(value).not.toContain('personal recommendation');
  });
  it('does not let irrelevant, expired or different judgments shadow personal memory', () => {
    for (const change of ['path', 'expiry', 'group'] as const) {
      const b = bundles();
      const m = memories(b, 'collective')[0]!;
      if (change === 'path') m.content.appliesTo.filePaths = ['missing.py'];
      if (change === 'expiry') m.content.expiresAt = '2020-01-01T00:00:00.000Z';
      if (change === 'group') m.aggregationKey = contentHash('different');
      expect(select(b).precedence).toEqual([]);
      expect(select(b).items.find((i) => i.id === 'personal')!.targets).toHaveLength(2);
    }
  });
  it('matches every constrained dimension on the same file including branch, while retaining semantic contract conditions', () => {
    const b = bundles();
    memories(b, 'collective')[0]!.content.appliesTo = {
      languages: ['python'],
      filePaths: ['a.ts'],
      symbols: ['load'],
      contracts: ['contract'],
      branches: ['main'],
    };
    expect(select(b, { selected: [file('a.ts'), file('b.py')] }).precedence).toEqual([]);
    const m = memories(b, 'collective')[0]!;
    m.content.appliesTo.languages = ['TypeScript'];
    expect(select(b).precedence).toHaveLength(1);
    expect(select(b, { branch: 'feature' }).precedence).toEqual([]);
    m.content.appliesTo.contracts = ['Request-only validation belongs in the schema'];
    expect(select(b).precedence).toHaveLength(1);
    expect(JSON.stringify(select(b).items)).toContain('Request-only validation belongs in the schema');
  });
  it('applies exceptions only to matching files and expires context at time boundaries', () => {
    const b = bundles();
    const current = Date.now();
    const until = new Date(current + 30_000).toISOString();
    policyBundle(b).criteria[0]!.exceptions = [
      {
        id: 'exception',
        appliesTo: { ...scopeTerms(), filePaths: ['a.ts'] },
        reason: 'Approved exception',
        startsAt: new Date(current - 1000).toISOString(),
        expiresAt: until,
      },
    ];
    const result = select(b);
    expect(result.items.find((i) => i.id === 'criterion')!.targets.map((t) => t.path)).toEqual([
      'b.ts',
    ]);
    expect(result.validUntil).toBe(until);
    const future = new Date(current + 5000).toISOString();
    policyBundle(b).criteria[0]!.exceptions[0]!.startsAt = future;
    expect(select(b).validUntil).toBe(future);
    expect(select(b).items.find((i) => i.id === 'criterion')!.targets).toHaveLength(2);
    expect(
      select(b, { now: new Date(current + 31_000).toISOString() }).items.find(
        (i) => i.id === 'criterion',
      )!.targets,
    ).toHaveLength(2);
  });
  it('rejects ambiguous v1 grouping, cross-repository bundles and invalid exception intervals', () => {
    const b = bundles();
    b.personal.schemaVersion = 1;
    delete memories(b, 'personal')[0]!.aggregationKey;
    expect(() => select(b)).toThrow('central-precedence-contract-required');
    b.personal.schemaVersion = 2;
    expect(() => centralKnowledgeBundle(b.personal)).toThrow();
    const other = bundles();
    other.personal.repositoryId = 'other';
    expect(() => select(other)).toThrow('central-scope-mismatch');
    policyBundle(other).criteria[0]!.exceptions = [
      {
        id: 'bad',
        appliesTo: scopeTerms(),
        reason: 'Invalid',
        startsAt: now(),
        expiresAt: '2020-01-01T00:00:00.000Z',
      },
    ];
    expect(() => centralKnowledgeBundle(other.policy)).toThrow();
  });
  it('records missing required policy instead of selecting a successful empty review', () => {
    const result = select(bundles(), { byteLimit: 1 });
    expect(result.items).toHaveLength(0);
    expect(result.required.filter((i) => !i.available)).toHaveLength(5);
    const b = bundles();
    policyBundle(b).criteria[0]!.document.appliesTo.filePaths = ['../bad'];
    expect(select(b).required.some((i) => !i.available)).toBe(true);
  });
});

let root: string, snapshot: LocalSourceSnapshot, scope: LocalScope;
let client: Extract<ClientIdentity, { mode: 'centralized' }>;
const openCaches: CentralKnowledgeCache[] = [];
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcr-central-review-'));
  const repo = path.join(root, 'repo');
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
  snapshot = captureLocalSource({ cwd: repo, kind: 'index' });
  client = { ...discoverLocalIdentity(repo, 'central-review'), mode: 'centralized', audience };
  scope = {
    kind: 'repository',
    profileId: client.profileId,
    repositoryKey: client.repositoryKey,
    worktreeKey: client.worktreeKey,
  };
}, 20_000);
afterEach(() => {
  vi.restoreAllMocks();
  for (const cache of openCaches.splice(0)) cache.close();
});
afterAll(() => {
  snapshot?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
async function setup(b = bundles()) {
  const values = new Map<string, Buffer>();
  const cache = await CentralKnowledgeCache.open({
    scope,
    dataDirectory: fs.mkdtempSync(path.join(root, 'cache-')),
    keys: {
      async read(id) {
        return values.get(id);
      },
      async write(id, value) {
        values.set(id, Buffer.from(value));
      },
      async remove(id) {
        values.delete(id);
      },
    },
    binding: new TrustedCentralBinding({
      serverUrl: 'https://central.test',
      audience,
      trustedKeys: new Map([['key', pair.publicKey]]),
    }),
  });
  openCaches.push(cache);
  await cache.synchronize(publication(b).transport);
  return { cache, query: { client, snapshot, cache, freshness: 'online' as const, stores: [] } };
}
const descriptor = {
  id: 'synthetic',
  version: '1',
  model: 'fixture-model',
  configHash: contentHash('model'),
  capabilities: {
    available: true,
    sourceIsolation: 'fixed-source-only' as const,
    cancellation: true,
    timeout: true,
    childProcessCleanup: true,
    outputTokenLimit: false,
  },
};
async function runFixture(work: LocalReviewExecutor['review']) {
  const f = await setup();
  const result = await resolveCentralContext(f.query);
  if (result.status !== 'ready') throw Error(JSON.stringify(result.problems));
  const policy = resolveLocalExecutionPolicy({
    context: result,
    snapshot,
    executor: descriptor,
    workspaceTrusted: true,
    approval: {
      client,
      executor: descriptor,
      paths: ['**'],
      allowBase: true,
      allowRelated: true,
      allowKnowledge: true,
    },
  });
  if (policy.status !== 'ready') throw Error('policy fixture');
  return {
    ...f,
    context: result.context,
    run: () =>
      runLocalReview({
        snapshot,
        context: result.context,
        policy: policy.policy,
        executor: { descriptor, review: work },
      }),
  };
}
async function answer(request: Parameters<LocalReviewExecutor['review']>[0]) {
  const reads = [];
  for (const side of ['source', 'base'])
    reads.push(JSON.parse(await request.source.execute('read_file', { path: 'a.ts', side })));
  return {
    model: descriptor.model,
    raw: JSON.stringify({
      summary: 'Reviewed',
      files: [
        {
          path: 'a.ts',
          side: 'source',
          complete: true,
          summary: 'Read current and base',
          readIds: reads.map((r) => r.readId),
        },
      ],
      findings: [],
      questions: [],
    }),
  };
}
describe('authorized central snapshot review', () => {
  it('pins central provenance separately from local knowledge and preserves standalone isolation', async () => {
    const f = await setup();
    const central = await resolveCentralContext(f.query);
    expect(central.status).toBe('ready');
    if (central.status !== 'ready') return;
    expect(central.context.identity.centralSnapshot?.audience).toEqual(audience);
    expect(central.context.identity.entries.filter((e) => e.origin === 'central')).toHaveLength(7);
    const local = await resolveLocalContext({
      ...f.query,
      client: {
        mode: 'standalone',
        profileId: client.profileId,
        repositoryKey: client.repositoryKey,
        worktreeKey: client.worktreeKey,
      },
    });
    expect(local.status).toBe('ready');
    expect(local.context!.identity.hash).not.toBe(central.context.identity.hash);
    expect(local.context!.central).toBeNull();
    const changed = central.context.central!;
    changed.items.length = 0;
    expect(central.context.central!.items).toHaveLength(7);
  });
  it('rejects account, profile and worktree mismatches before reading cache', async () => {
    const f = await setup();
    const read = vi.spyOn(f.cache, 'read');
    for (const changes of [
      { profileId: 'other' },
      { worktreeKey: contentHash('other') },
      { audience: { ...audience, userId: 'other' } },
    ])
      expect(
        (await resolveCentralContext({ ...f.query, client: { ...client, ...changes } })).status,
      ).toBe('unavailable');
    expect(read).not.toHaveBeenCalled();
  });
  it('requires knowledge transmission approval and full mandatory context', async () => {
    const f = await setup();
    const context = await resolveCentralContext(f.query);
    const policy = resolveLocalExecutionPolicy({
      context,
      snapshot,
      executor: descriptor,
      workspaceTrusted: true,
      approval: {
        client,
        executor: descriptor,
        paths: ['**'],
        allowBase: true,
        allowRelated: true,
        allowKnowledge: false,
      },
    });
    expect(policy.status).not.toBe('ready');
    expect((await resolveCentralContext({ ...f.query, knowledgeBytes: 1 })).status).toBe(
      'needs-context',
    );
  });
  it('keeps required local data and central instructions within one budget', async () => {
    const f = await setup();
    const body = {
      id: 'local-note',
      kind: 'memory',
      scope,
      revision: 1,
      state: 'active',
      title: 'User note',
      body: 'Check caller contract',
      rationale: 'Caller expectations',
      counterEvidence: ['Already fixed'],
      appliesTo: { paths: [], languages: [], symbols: [], branches: [] },
      sources: [{ kind: 'user-note', id: 'note' }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const note = localKnowledge({ ...body, hash: contentHash(body) });
    const result = await resolveCentralContext({
      ...f.query,
      stores: [
        {
          async *entries() {
            yield note;
          },
        },
      ],
      requiredKnowledgeIds: ['local-note'],
    });
    expect(result.status).toBe('ready');
    expect(result.context!.knowledge).toEqual([note]);
    expect(result.context!.bytes).toBeLessThanOrEqual(65_536);
  });
  it('passes scoped central material to the approved executor with real fixed-source/base reads', async () => {
    const f: Awaited<ReturnType<typeof runFixture>> = await runFixture(async (request) => {
      expect(request.prompt).toContain('centralKnowledge');
      expect(request.prompt).toContain('collective full decision');
      expect(request.prompt).toContain('personal counter-evidence');
      expect(request.prompt).not.toContain('personal full decision');
      return answer(request);
    });
    const result = await f.run();
    expect(result.status).toBe('completed');
    expect(result.evidence).toHaveLength(2);
    expect(result.identity.context.hash).toBe(f.context.identity.hash);
  });
  it('finishes ordinary updates with the pinned prompt and marks results superseded', async () => {
    const f: Awaited<ReturnType<typeof runFixture>> = await runFixture(async (request) => {
      const b = bundles();
      memories(b, 'collective')[0]!.content.recommendation = 'NEW DECISION';
      await f.cache.synchronize(publication(b, 2).transport);
      expect(request.prompt).not.toContain('NEW DECISION');
      return answer(request);
    });
    const result = await f.run();
    expect(result.status).toBe('superseded');
    expect(result.evidence).toHaveLength(2);
    expect(result.identity.context.hash).toBe(f.context.identity.hash);
  });
  it('pauses further source reads while authorization is being synchronized', async () => {
    const f: Awaited<ReturnType<typeof runFixture>> = await runFixture(async (request) => {
      const b = bundles();
      memories(b, 'collective')[0]!.content.recommendation = 'Update';
      const next = publication(b, 2);
      let release!: () => void;
      const pending = new Promise<void>((r) => {
        release = r;
      });
      let entered!: () => void;
      const began = new Promise<void>((r) => {
        entered = r;
      });
      const sync = f.cache.synchronize({
        ...next.transport,
        async manifest() {
          entered();
          await pending;
          return { status: 200, manifest: next.manifest };
        },
      });
      await began;
      let read = false;
      const reading = request.source
        .execute('read_file', { path: 'a.ts', side: 'source' })
        .then((v) => {
          read = true;
          return v;
        });
      await new Promise((r) => setTimeout(r, 120));
      expect(read).toBe(false);
      release();
      await sync;
      await reading;
      return answer(request);
    });
    expect((await f.run()).status).toBe('superseded');
  });
  it.each(['critical', 'authorization', 'denied'] as const)(
    'cancels %s revocation and rejects additional reads and a late model response',
    async (kind) => {
      const f: Awaited<ReturnType<typeof runFixture>> = await runFixture(async (request) => {
        if (kind === 'denied')
          await expect(
            f.cache.synchronize({
              async manifest() {
                return { status: 403 };
              },
              async bundle() {
                throw Error('unexpected');
              },
            }),
          ).rejects.toMatchObject({ code: 'revoked' });
        else
          await f.cache.synchronize(
            publication(bundles(), 2, kind === 'critical', kind === 'authorization' ? 2 : 1)
              .transport,
          );
        await expect(
          request.source.execute('read_file', { path: 'a.ts', side: 'source' }),
        ).rejects.toThrow();
        return { model: descriptor.model, raw: '{"private":"must not surface"}' };
      });
      const result = await f.run();
      expect(result.status).toBe('cancelled');
      expect(result.findings).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('must not surface');
    },
  );
  it('does not admit a model call after the selected context is revoked', async () => {
    const called = vi.fn(answer);
    const f = await runFixture(called);
    await f.cache.disable('revoked');
    const result = await f.run();
    expect(result.status).toBe('cancelled');
    expect(called).not.toHaveBeenCalled();
  });
  it('closes source tools after the final model response', async () => {
    let request: Parameters<LocalReviewExecutor['review']>[0] | undefined;
    const f = await runFixture(async (input) => {
      request = input;
      return answer(input);
    });
    expect((await f.run()).status).toBe('completed');
    await expect(
      request!.source.execute('read_file', { path: 'a.ts', side: 'source' }),
    ).rejects.toThrow('cancelled');
  });
  it('cancels an executor that ignores the abort signal without waiting for its response', async () => {
    let started!: () => void;
    const began = new Promise<void>((r) => {
      started = r;
    });
    let late!: () => void;
    const f: Awaited<ReturnType<typeof runFixture>> = await runFixture(async () => {
      started();
      await new Promise<void>((r) => {
        late = r;
      });
      return { model: descriptor.model, raw: '{}' };
    });
    const running = f.run();
    await began;
    await f.cache.disable('revoked');
    const result = await running;
    expect(result.status).toBe('cancelled');
    late();
  });
});

it('uses identical public applicability and exception rules while never reading a personal projection', () => {
  const all = bundles();
  const selected = [file('a.ts'), file('b.ts')];
  const date = '2030-01-02T00:00:00.000Z';
  const publicOnly = {
    ...all,
    personal: { ...all.personal, component: 'personal' as const, memories: [] },
  };
  const input = { selected, branch: 'feature', now: date, byteLimit: 65536 };
  const expected = selectCentralKnowledge({ ...input, bundles: publicOnly });
  const shared = { policy: all.policy, collective: all.collective };
  Object.defineProperty(shared, 'personal', {
    get: () => {
      throw Error('Personal projection must not be read');
    },
  });
  expect(selectSharedKnowledge({ ...input, bundles: shared })).toEqual(expected);
  expect(expected.items.filter((i) => i.kind === 'policy').map((i) => i.id)).toEqual(['criterion']);
  expect(expected.items.some((i) => i.component === 'personal')).toBe(false);
});
