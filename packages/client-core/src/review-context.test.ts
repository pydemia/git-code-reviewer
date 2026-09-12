import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  localKnowledge,
  type ClientIdentity,
  type LocalKnowledge,
  type LocalScope,
} from '@gcr/client-contract';
import { builtinReviewSkill } from './builtin-review.js';
import { contentHash, discoverLocalIdentity } from './local-identity.js';
import { LocalKnowledgeStore } from './local-knowledge.js';
import { LocalRecordStore } from './local-records.js';
import { captureLocalSource, type LocalSourceSnapshot } from './source-snapshot.js';
import {
  resolveLocalContext,
  sourceLanguage,
  type KnowledgeReader,
  type LocalContextQuery,
} from './review-context.js';
import { resolveReviewMode } from './review-mode.js';
import { LocalReviewSourcePort } from './review-source-port.js';
import {
  resolveLocalExecutionPolicy,
  reviewBudgetLimits,
  ReviewRunBudget,
  type LocalExecutorDescriptor,
  type ResolvePolicyInput,
} from './review-policy.js';

let root: string,
  repo: string,
  client: ClientIdentity,
  snapshot: LocalSourceSnapshot,
  repoScope: LocalScope;
const now = new Date('2026-09-13T00:00:00.000Z');
beforeAll(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), 'gcr-context-test-'));
  repo = path.join(root, 'repo');
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
  fs.writeFileSync(path.join(repo, 'api.py'), 'def load():\n    return 0\n');
  fs.writeFileSync(path.join(repo, 'handler.ts'), 'export function handle() { return 0; }\n');
  fs.writeFileSync(path.join(repo, 'caller.py'), 'from api import load\n');
  git('add', '.');
  git('commit', '-m', 'base');
  fs.writeFileSync(path.join(repo, 'api.py'), 'def load():\n    return 1\n');
  fs.writeFileSync(path.join(repo, 'handler.ts'), 'export function handle() { return 1; }\n');
  git('add', '.');
  snapshot = captureLocalSource({ cwd: repo, kind: 'index' });
  client = discoverLocalIdentity(repo, 'context-profile');
  repoScope = {
    kind: 'repository',
    profileId: client.profileId,
    repositoryKey: client.repositoryKey,
    worktreeKey: client.worktreeKey,
  };
}, 20_000);
afterAll(() => {
  vi.restoreAllMocks();
  snapshot?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
function knowledge(id: string, changes: Record<string, unknown> = {}): LocalKnowledge {
  const body: Record<string, unknown> = {
    id,
    kind: 'memory',
    scope: repoScope,
    revision: 1,
    state: 'active',
    title: id,
    body: 'Review the current source and its counter-evidence.',
    rationale: 'Historical observations require current verification.',
    counterEvidence: ['The base may already contain this behavior.'],
    appliesTo: { paths: [], languages: [], symbols: [], branches: [] },
    sources: [{ kind: 'user-note', id: 'fixture-note' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...changes,
  };
  if (body.kind === 'skill') {
    delete body.rationale;
    delete body.counterEvidence;
    body.reviewOnly = true;
    body.origin = 'user-authored';
  }
  return localKnowledge({ ...body, hash: contentHash(body) });
}
function reader(...items: LocalKnowledge[]): KnowledgeReader {
  return {
    async *entries() {
      yield* items;
    },
  };
}
function query(
  items: LocalKnowledge[] = [],
  changes: Partial<LocalContextQuery> = {},
): LocalContextQuery {
  return {
    client,
    snapshot,
    stores: [reader(...items)],
    now,
    branch: { name: 'main', headCommit: snapshot.headCommit },
    ...changes,
  };
}
const executor = (): LocalExecutorDescriptor => ({
  id: 'synthetic-executor',
  version: 'fixture-1',
  model: 'fixture-model',
  configHash: 'a'.repeat(64),
  // A synthetic capability fixture, not a claim of a validated model executor.
  capabilities: {
    available: true,
    sourceIsolation: 'fixed-source-only',
    cancellation: true,
    timeout: true,
    childProcessCleanup: true,
    outputTokenLimit: false,
  },
});
async function policyInput(items: LocalKnowledge[] = []): Promise<ResolvePolicyInput> {
  const selected = executor();
  return {
    context: await resolveLocalContext(query(items)),
    snapshot,
    executor: selected,
    workspaceTrusted: true,
    now,
    approval: {
      client,
      executor: { id: selected.id, model: selected.model, configHash: selected.configHash },
      paths: ['**'],
      allowBase: true,
      allowRelated: true,
      allowKnowledge: true,
    },
  };
}

describe('standalone mode and deterministic local context', () => {
  it('binds context and source approval to the actual repository/worktree even for identical source bytes', async () => {
    const clone = path.join(root, 'same-source-clone');
    execFileSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', 'clone', '--local', '--no-hardlinks', repo, clone],
      { stdio: 'pipe' },
    );
    fs.writeFileSync(path.join(clone, 'api.py'), fs.readFileSync(path.join(repo, 'api.py')));
    fs.writeFileSync(
      path.join(clone, 'handler.ts'),
      fs.readFileSync(path.join(repo, 'handler.ts')),
    );
    execFileSync('git', ['-C', clone, '-c', 'core.hooksPath=/dev/null', 'add', '.'], {
      stdio: 'pipe',
    });
    const other = captureLocalSource({ cwd: clone, kind: 'index' });
    try {
      expect(other.identity.hash).toBe(snapshot.identity.hash);
      expect(other.repository.repositoryKey).not.toBe(client.repositoryKey);
      expect((await resolveLocalContext(query([], { snapshot: other }))).status).toBe(
        'unavailable',
      );
      const policy = await policyInput();
      policy.snapshot = other;
      expect(resolveLocalExecutionPolicy(policy).problems[0]?.code).toBe('source-error');
      const originalPolicy = resolveLocalExecutionPolicy(await policyInput()).policy!;
      expect(
        () => new LocalReviewSourcePort(other, originalPolicy, originalPolicy.createRunBudget()),
      ).toThrow('policy-unavailable');
    } finally {
      other.close();
    }
  }, 15_000);
  it('does not read residual central settings, credentials or cache and never acquires central-mode stores', async () => {
    const settings = {
      mode: 'standalone',
      get serverUrl() {
        throw Error('CENTRAL_URL_WAS_READ');
      },
      get token() {
        throw Error('CENTRAL_TOKEN_WAS_READ');
      },
      get cache() {
        throw Error('CENTRAL_CACHE_WAS_READ');
      },
    };
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('NETWORK_WAS_USED'));
    try {
      expect(resolveReviewMode(settings)).toEqual({
        mode: 'standalone',
        supported: true,
        centralRequests: 'forbidden',
        problems: [],
      });
      expect((await resolveLocalContext(query([], { settings }))).status).toBe('ready');
      const access = vi.fn(() => {
        throw Error('STORE_WAS_READ');
      });
      const central = await resolveLocalContext(
        query([], { settings: { mode: 'centralized' }, stores: [{ entries: access }] }),
      );
      expect(central.status).toBe('unavailable');
      expect(central.problems[0]?.code).toBe('policy-unavailable');
      expect(access).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
    expect(resolveReviewMode().mode).toBe('standalone');
    for (const mode of ['automatic', '', null, false])
      expect(() => resolveReviewMode({ mode })).toThrow();
  });
  it('selects active unexpired profile/repository memory and Skills without promoting their authority', async () => {
    const input = [
      knowledge('profile', { scope: { kind: 'profile', profileId: client.profileId } }),
      knowledge('repo'),
      knowledge('skill', { kind: 'skill', body: '# Criteria\nCheck failure conditions.' }),
      knowledge('candidate', { state: 'candidate' }),
      knowledge('inactive', { state: 'inactive' }),
      knowledge('archived', { state: 'archived' }),
      knowledge('expired', { expiresAt: '2026-09-12T00:00:00.000Z' }),
    ];
    const result = await resolveLocalContext(query(input));
    expect(result.status).toBe('ready');
    expect(result.context?.knowledge.map((item) => item.id)).toEqual(['repo', 'skill', 'profile']);
    expect(result.context?.identity.entries[0]).toMatchObject({
      origin: 'builtin',
      id: builtinReviewSkill.id,
    });
    expect(
      result.context?.identity.entries.slice(1).every((entry) => entry.origin === 'local'),
    ).toBe(true);
    expect(result.context?.omissions.map((item) => item.id)).toEqual([
      'archived',
      'candidate',
      'expired',
      'inactive',
    ]);
    expect(result.context?.sources).toHaveLength(4);
  });
  it('requires constrained path, language and lexical symbol dimensions to match the same selected file', async () => {
    const applies = (
      paths: string[],
      languages: string[],
      symbols: string[],
      branches: string[] = [],
    ) => ({ paths, languages, symbols, branches });
    const result = await resolveLocalContext(
      query([
        knowledge('python', { appliesTo: applies(['**/*.py'], ['python'], ['load'], ['main']) }),
        knowledge('typescript', { appliesTo: applies(['handler.ts'], ['typescript'], ['handle']) }),
        knowledge('cross-file', { appliesTo: applies(['api.py'], ['typescript'], ['handle']) }),
        knowledge('different-branch', { appliesTo: applies([], [], [], ['release/**']) }),
        knowledge('unrelated-path', { appliesTo: applies(['caller.py'], [], []) }),
        knowledge('unsupported-pattern', { appliesTo: applies(['!api.py'], [], []) }),
      ]),
    );
    expect(result.context?.knowledge.map((item) => item.id)).toEqual(['python', 'typescript']);
    expect(result.context?.omissions).toContainEqual({
      id: 'unsupported-pattern',
      reason: 'unsupported-scope',
    });
    expect(sourceLanguage('module.unknown')).toBeUndefined();
    expect(sourceLanguage('module.rs')).toBe('rust');
    expect(
      (
        await resolveLocalContext(
          query([], { branch: { name: 'main', headCommit: 'f'.repeat(40) } }),
        )
      ).status,
    ).toBe('unavailable');
  });
  it('reports missing, inactive, expired, inapplicable or oversized required knowledge as needs-context', async () => {
    for (const changes of [
      { state: 'inactive' },
      { expiresAt: '2026-09-12T00:00:00.000Z' },
      { appliesTo: { paths: ['other.py'], languages: [], symbols: [], branches: [] } },
      { body: 'x'.repeat(10_000) },
    ]) {
      const result = await resolveLocalContext(
        query([knowledge('required', changes)], {
          requiredKnowledgeIds: ['required'],
          knowledgeBytes: 4000,
        }),
      );
      expect(result.status).toBe('needs-context');
      expect(
        result.context?.identity.required.some(
          (item) => !item.available && item.reference === 'knowledge:required',
        ),
      ).toBe(true);
    }
    const missing = await resolveLocalContext(query([], { requiredKnowledgeIds: ['missing'] }));
    expect(missing.status).toBe('needs-context');
    expect(missing.problems[0]?.code).toBe('missing-context');
    expect((await resolveLocalContext(query([], { knowledgeBytes: 1 }))).status).toBe(
      'needs-context',
    );
  });
  it('prioritizes required material, records optional omission and keeps hashes deterministic across reader order', async () => {
    const first = knowledge('a'),
      required = knowledge('z');
    const baseBytes = (await resolveLocalContext(query())).context!.bytes;
    const singleBytes = (await resolveLocalContext(query([required]))).context!.bytes;
    const budget = singleBytes + Math.floor((singleBytes - baseBytes) / 2);
    const one = await resolveLocalContext(
      query([first, required], { requiredKnowledgeIds: ['z'], knowledgeBytes: budget }),
    );
    const two = await resolveLocalContext(
      query([required, first], { requiredKnowledgeIds: ['z'], knowledgeBytes: budget }),
    );
    expect(one.status).toBe('ready');
    expect(one.context?.knowledge.map((item) => item.id)).toEqual(['z']);
    expect(one.context?.omissions).toContainEqual({ id: 'a', reason: 'budget' });
    expect(one.context?.identity.hash).toBe(two.context?.identity.hash);
    const revised = await resolveLocalContext(
      query([knowledge('z', { revision: 2, body: 'A revised observation.' })], {
        requiredKnowledgeIds: ['z'],
      }),
    );
    expect(one.context?.identity.hash).not.toBe(revised.context?.identity.hash);
  });
  it('retains source needs instead of replacing unavailable or excluded files with empty input', async () => {
    for (const file of ['missing.py', '.env']) {
      const result = await resolveLocalContext(
        query([], { requiredSources: [{ path: file, side: 'source' }] }),
      );
      expect(result.status).toBe('needs-context');
      expect(result.context?.sources.find((source) => source.path === file)?.available).toBe(false);
    }
    const result = await resolveLocalContext(
      query([], { requiredSources: [{ path: 'caller.py', side: 'source' }] }),
    );
    expect(result.status).toBe('ready');
    expect(result.context?.sources.find((source) => source.path === 'caller.py')?.available).toBe(
      true,
    );
  });
  it('rejects foreign scopes, duplicate IDs, forged hashes and executable Skill fields without leaking their bodies', async () => {
    const foreign = knowledge('foreign', {
      scope: { kind: 'profile', profileId: 'other-profile' },
      body: 'PRIVATE_FOREIGN_CANARY',
    });
    const wrongRepo = knowledge('repo', { scope: { ...repoScope, repositoryKey: '0'.repeat(64) } });
    const tampered = { ...knowledge('tampered'), body: 'PRIVATE_TAMPERED_CANARY' };
    const executable = {
      ...knowledge('executable', { kind: 'skill' }),
      command: 'PRIVATE_EXECUTABLE_CANARY',
    };
    for (const items of [
      [foreign],
      [wrongRepo],
      [tampered],
      [executable],
      [knowledge('same'), knowledge('same')],
    ]) {
      const result = await resolveLocalContext(query(items));
      expect(result.status).toBe('unavailable');
      expect(result.context).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('CANARY');
    }
  });
  it('bounds knowledge scans and propagates storage failures without a successful empty fallback', async () => {
    const entries = [knowledge('one'), knowledge('two')];
    for (const limits of [{ scanItems: 1 }, { scanBytes: 1 }]) {
      const result = await resolveLocalContext(query(entries, limits));
      expect(result.status).toBe('needs-context');
      expect(result.problems.some((problem) => problem.code === 'context-truncated')).toBe(true);
    }
    const result = await resolveLocalContext(
      query([], {
        stores: [
          {
            async *entries() {
              yield knowledge('one');
              throw Error('PRIVATE_STORAGE_CANARY');
            },
          },
        ],
      }),
    );
    expect(result.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('CANARY');
  });
  it('pins input and item revisions before asynchronous readers resume', async () => {
    const item = knowledge('frozen');
    const requiredIds = ['frozen'];
    const request = query([], { requiredKnowledgeIds: requiredIds });
    request.stores = [
      {
        async *entries() {
          yield item;
          item.body = 'later edit';
          requiredIds.push('late-requirement');
          request.client.profileId = 'mutated-after-start';
        },
      },
    ];
    const expected = item.body;
    // The query holds its own client object; other test requests retain the fixture identity.
    request.client = structuredClone(client);
    const result = await resolveLocalContext(request);
    expect(result.status).toBe('ready');
    expect(result.context?.knowledge[0]?.body).toBe(expected);
    expect(
      result.context?.identity.required.some(
        (entry) => entry.reference === 'knowledge:late-requirement',
      ),
    ).toBe(false);
    const copy = result.context!.knowledge;
    copy[0]!.body = 'outside mutation';
    expect(result.context!.knowledge[0]!.body).toBe(expected);
  });
  it('reads the encrypted store iterator and reflects activation, edits and deactivation on the next context', async () => {
    const values = new Map<string, Buffer>();
    const records = await LocalRecordStore.open({
      dataDirectory: path.join(root, 'knowledge-store'),
      scope: repoScope,
      keys: {
        read: async (id) => values.get(id),
        write: async (id, key) => {
          values.set(id, Buffer.from(key));
        },
        remove: async (id) => {
          values.delete(id);
        },
      },
    });
    try {
      const store = new LocalKnowledgeStore(records, () => now);
      const created = await store.create({
        kind: 'memory',
        title: 'Owned note',
        body: 'Evaluate the base.',
        rationale: '',
        counterEvidence: [],
        appliesTo: { paths: [], languages: [], symbols: [], branches: [] },
        sources: [],
      });
      expect(
        (await resolveLocalContext(query([], { stores: [store] }))).context?.knowledge,
      ).toEqual([]);
      const active = await store.setState(created.id, created.revision, 'active');
      const one = await resolveLocalContext(query([], { stores: [store] }));
      expect(one.context?.knowledge[0]?.revision).toBe(active.revision);
      const edited = await store.edit(active.id, active.revision, {
        body: 'Evaluate the source and base.',
      });
      const two = await resolveLocalContext(query([], { stores: [store] }));
      expect(two.context?.identity.hash).not.toBe(one.context?.identity.hash);
      await store.setState(edited.id, edited.revision, 'inactive');
      expect(
        (await resolveLocalContext(query([], { stores: [store] }))).context?.knowledge,
      ).toEqual([]);
    } finally {
      records.close();
    }
  });
});

describe('execution policy and per-run budget', () => {
  it('serves only approved fixed source/base through the port and records delivered receipts', async () => {
    const request = await policyInput();
    request.approval!.allowRelated = false;
    const policy = resolveLocalExecutionPolicy(request).policy!;
    const budget = policy.createRunBudget();
    const port = new LocalReviewSourcePort(snapshot, policy, budget);
    const listed = JSON.parse(await port.execute('list_files', {}));
    expect(listed.files.some((file: { path: string }) => file.path === 'caller.py')).toBe(false);
    await expect(port.execute('read_file', { path: 'caller.py' })).rejects.toThrow(
      'policy-unavailable',
    );
    await expect(port.execute('read_file', { path: '../api.py' })).rejects.toThrow();
    const source = JSON.parse(await port.execute('read_file', { path: 'api.py', side: 'source' }));
    const base = JSON.parse(await port.execute('read_file', { path: 'api.py', side: 'base' }));
    expect(source.text).toContain('return 1');
    expect(base.text).toContain('return 0');
    const search = JSON.parse(await port.execute('search_code', { query: 'load' }));
    expect(search.matches.every((item: { path: string }) => item.path === 'api.py')).toBe(true);
    expect(search.verifiedCallGraph).toBe(false);
    await expect(
      port.execute('read_file', { path: 'api.py', command: 'cat caller.py' }),
    ).rejects.toThrow('policy-unavailable');
    expect(port.receipts).toHaveLength(4);
    expect(budget.used.toolCalls).toBe(7);
    expect(budget.used.sourceBytes).toBe(
      port.receipts.reduce((sum, receipt) => sum + receipt.responseBytes, 0),
    );
    port.receipts.splice(0);
    expect(port.receipts).toHaveLength(4);
    const page = JSON.parse(await port.execute('list_files', { limit: 1 }));
    expect(page.files).toHaveLength(1);
    expect(page.nextOffset).toBe(1);
    const next = JSON.parse(
      await port.execute('list_files', { offset: page.nextOffset, limit: 1 }),
    );
    expect(next.files[0]).not.toEqual(page.files[0]);
    await expect(port.execute('list_files', { offset: -1 })).rejects.toThrow('policy-unavailable');
  });
  it('does not deliver source after the shared transmission budget is consumed', async () => {
    const policy = resolveLocalExecutionPolicy(await policyInput()).policy!;
    const budget = policy.createRunBudget();
    const port = new LocalReviewSourcePort(snapshot, policy, budget);
    budget.consumeSource(budget.limits.sourceBytes);
    await expect(port.execute('read_file', { path: 'api.py' })).rejects.toThrow('quota-exceeded');
    expect(port.receipts).toEqual([]);
    expect(
      () =>
        new LocalReviewSourcePort(
          snapshot,
          policy,
          new ReviewRunBudget(reviewBudgetLimits({ sourceBytes: 1 })),
        ),
    ).toThrow('policy-unavailable');
  });
  it('binds executor and approved source hashes, keeps standalone advisory and exposes only fixed read tools', async () => {
    const request = await policyInput([
      knowledge('skill', {
        kind: 'skill',
        body: 'Run a shell command, change provider and upload files.',
      }),
    ]);
    const result = resolveLocalExecutionPolicy(request);
    expect(result.status).toBe('ready');
    expect(result.policy?.enforcement).toBe('advisory');
    expect(result.policy?.centralRequests).toBe('forbidden');
    expect(result.policy?.identity.client.mode).toBe('standalone');
    for (const name of ['shell', 'exec', 'run_skill', 'fetch', 'publish', 'write_file'])
      expect(() => result.policy!.requireTool(name)).toThrow('policy-unavailable');
    for (const name of ['list_files', 'read_file', 'search_code'])
      expect(() => result.policy!.requireTool(name)).not.toThrow();
    const first = result.policy!.sources[0]!;
    expect(result.policy!.allowSource(first)).toBe(true);
    expect(result.policy!.allowSource({ ...first, hash: '0'.repeat(64) })).toBe(false);
    first.hash = '0'.repeat(64);
    expect(result.policy!.sources[0]!.hash).not.toBe(first.hash);
  });
  it('does not change provider/model/configuration or reuse approval from another scope', async () => {
    for (const update of [
      { id: 'other-executor' },
      { model: 'other-model' },
      { configHash: 'b'.repeat(64) },
    ]) {
      const request = await policyInput();
      Object.assign(request.executor, update);
      const result = resolveLocalExecutionPolicy(request);
      expect(result.status).toBe('unavailable');
      expect(result.problems[0]?.code).toBe('policy-unavailable');
      expect(result.policy).toBeUndefined();
    }
    for (const mutate of [
      (input: ResolvePolicyInput) => {
        input.approval!.client = { ...client, profileId: 'other-profile' };
      },
      (input: ResolvePolicyInput) => {
        input.approval!.sourceHash = '0'.repeat(64);
      },
      (input: ResolvePolicyInput) => {
        input.workspaceTrusted = false;
      },
      (input: ResolvePolicyInput) => {
        delete input.approval;
      },
    ]) {
      const request = await policyInput();
      mutate(request);
      expect(resolveLocalExecutionPolicy(request).status).toBe('unavailable');
    }
  });
  it('requires proven isolation/cancellation/timeout/descendant cleanup and refuses unenforceable token limits', async () => {
    for (const update of [
      { available: false },
      { sourceIsolation: 'unknown' as const },
      { sourceIsolation: 'unrestricted' as const },
      { cancellation: false },
      { timeout: false },
      { childProcessCleanup: false },
    ]) {
      const request = await policyInput();
      Object.assign(request.executor.capabilities, update);
      expect(resolveLocalExecutionPolicy(request).problems[0]?.code).toBe('executor-unavailable');
    }
    const request = await policyInput();
    request.budget = { outputTokensPerCall: 4000 };
    expect(resolveLocalExecutionPolicy(request).status).toBe('unavailable');
    request.executor.capabilities.outputTokenLimit = true;
    expect(resolveLocalExecutionPolicy(request).status).toBe('ready');
  });
  it('limits related/base/knowledge transmission and reports required evidence outside approval or budget', async () => {
    const request = await policyInput();
    request.approval!.allowRelated = false;
    const limited = resolveLocalExecutionPolicy(request);
    expect(limited.status).toBe('ready');
    expect(limited.policy?.sources.some((file) => file.path === 'caller.py')).toBe(false);
    request.context = await resolveLocalContext(
      query([], { requiredSources: [{ path: 'caller.py', side: 'source' }] }),
    );
    expect(resolveLocalExecutionPolicy(request).status).toBe('needs-context');
    request.approval!.allowRelated = true;
    request.approval!.allowBase = false;
    expect(resolveLocalExecutionPolicy(request).status).toBe('needs-context');
    request.approval!.allowBase = true;
    request.budget = { sourceBytes: 1 };
    expect(resolveLocalExecutionPolicy(request).problems[0]?.code).toBe('source-truncated');
    const knowledgeRequest = await policyInput([knowledge('private')]);
    knowledgeRequest.approval!.allowKnowledge = false;
    expect(resolveLocalExecutionPolicy(knowledgeRequest).status).toBe('unavailable');
  });
  it('preserves incomplete context and checks expiry again before execution', async () => {
    const request = await policyInput();
    request.context = await resolveLocalContext(query([], { requiredKnowledgeIds: ['missing'] }));
    expect(resolveLocalExecutionPolicy(request).status).toBe('needs-context');
    request.context = await resolveLocalContext(
      query([knowledge('soon', { expiresAt: '2026-09-13T00:01:00.000Z' })]),
    );
    request.now = new Date('2026-09-13T00:02:00.000Z');
    expect(resolveLocalExecutionPolicy(request).status).toBe('unavailable');
  });
  it('reserves retries, source bytes and tool calls and uses a monotonic deadline', () => {
    let time = 0;
    const limits = reviewBudgetLimits({
      modelCalls: 2,
      sourceBytes: 10,
      toolCalls: 1,
      durationMs: 100,
    });
    const budget = new ReviewRunBudget(limits, () => time);
    limits.modelCalls = 10;
    budget.reserveModelCall();
    budget.reserveModelCall();
    expect(() => budget.reserveModelCall()).toThrow('quota-exceeded');
    budget.consumeSource(7);
    expect(() => budget.consumeSource(4)).toThrow('quota-exceeded');
    budget.consumeSource(3);
    budget.consumeTool();
    expect(() => budget.consumeTool()).toThrow('quota-exceeded');
    const used = budget.used;
    used.sourceBytes = 0;
    expect(budget.used.sourceBytes).toBe(10);
    time = 100;
    expect(() => budget.assertActive()).toThrow('timeout');
    const backwards = new ReviewRunBudget(reviewBudgetLimits(), () => time);
    time = 99;
    expect(() => backwards.assertActive()).toThrow('policy-unavailable');
    for (const modelCalls of [0, -1, 11, NaN, Infinity])
      expect(() => reviewBudgetLimits({ modelCalls })).toThrow('policy-unavailable');
  });
});
