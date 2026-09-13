import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, runMigrations, type Database, type DatabaseClient } from '@gcr/db';
import { FilesystemArtifactStore } from '@gcr/artifact-store';
import {
  centralKnowledgeBundle,
  centralMemoryContent,
  encodeKnowledgeBundle,
  canonicalKnowledgeJson,
} from '@gcr/client-contract';
import { criterionCreateSchema, criterionEvaluationCreateSchema } from '@gcr/contracts';
import {
  createCriterion,
  lockCriterion,
  evaluateCriterion,
  actOnCriterion,
} from './review-criteria.js';
import {
  approveKnowledgeMemory,
  knowledgeMemoryApprovalFingerprint,
} from './knowledge-projection.js';
import { claimKnowledgePublication, publishKnowledge } from './knowledge-publication.js';
import { reviewMemoryColumns, type ReviewMemoryRecord } from './review-memory.js';

const url = process.env.GCR_TEST_DATABASE_URL;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const content = () =>
  centralMemoryContent({
    summary: 'Approved public memory',
    detail: 'Safe curated explanation',
    recommendation: 'Check tenant key',
    categories: [],
    appliesTo: {
      languages: ['Python'],
      filePaths: ['cache.py'],
      symbols: [],
      contracts: [],
      branches: [],
    },
    counterEvidence: ['Tenant-specific cache instance'],
    expiresAt: null,
  });
const candidate = (severity = 'P2') =>
  criterionCreateSchema.parse({
    document: {
      title: 'Tenant key',
      topicKey: 'tenant.key',
      requirement: 'Include tenant in shared cache keys.',
      rationale: 'Separate tenant values.',
      counterEvidence: ['Caller selects separate instance.'],
      reviewSteps: ['Read cache key and caller.'],
      appliesTo: { filePaths: ['cache.py'] },
      severity,
    },
    decision: {
      outcome: 'design-decision',
      reasoning: 'Explicit synthetic decision.',
      sources: [{ kind: 'manual', content: 'RAW_SOURCE_MUST_NOT_BE_IN_BUNDLE' }],
    },
  });

describe.skipIf(!url).sequential('immutable knowledge publication', () => {
  const schema = 'gcr_publication_' + randomUUID().replaceAll('-', '');
  let root: Database,
    db: Database,
    store: FilesystemArtifactStore,
    directory: string,
    tenant: string,
    instance: string,
    admin: string,
    alice: string,
    bob: string;
  const txn = async <T>(fn: (c: DatabaseClient) => Promise<T>) => {
    const c = await db.connect();
    try {
      await c.query('begin');
      const result = await fn(c);
      await c.query('commit');
      return result;
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  };
  beforeAll(async () => {
    const local = new URL(url!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(local.hostname))
      throw Error('Owned local database required');
    root = createDatabase(local.toString());
    await root.query(`create schema ${schema}`);
    local.searchParams.set('options', `-c search_path=${schema}`);
    db = createDatabase(local.toString());
    await runMigrations(db, path.resolve('packages/db/migrations'));
    directory = await mkdtemp(path.join(os.tmpdir(), 'gcr-publication-'));
    store = new FilesystemArtifactStore(directory);
    tenant = (
      await db.query(
        "insert into tenants(slug,display_name) values('publication','Publication') returning id",
      )
    ).rows[0].id;
    instance = (
      await db.query(
        "insert into github_instances(name,api_base_url,web_base_url) values('publication','https://example.invalid/api/','https://example.invalid/') returning id",
      )
    ).rows[0].id;
    for (const name of ['admin', 'alice', 'bob']) {
      const id = (
        await db.query(
          'insert into users(oidc_subject,display_name,role) values($1,$1,$2) returning id',
          [name, name === 'admin' ? 'administrator' : 'reviewer'],
        )
      ).rows[0].id;
      await db.query('insert into tenant_memberships(tenant_id,user_id) values($1,$2)', [
        tenant,
        id,
      ]);
      if (name === 'admin') admin = id;
      else if (name === 'alice') alice = id;
      else bob = id;
    }
  }, 30000);
  afterAll(async () => {
    await db?.end();
    if (root) {
      await root.query(`drop schema ${schema} cascade`);
      await root.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const repo = async () => {
    const suffix = randomUUID();
    const id = (
      await db.query(
        "insert into repositories(tenant_id,instance_id,github_id,installation_id,owner,name,polling_enabled) values($1,$2,$3,'synthetic','owned',$4,false) returning id",
        [tenant, instance, String(Math.floor(Math.random() * 1e12)), suffix],
      )
    ).rows[0].id;
    for (const subject of ['alice', 'bob'])
      await db.query(
        "insert into repository_grants(repository_id,subject_or_group,role) values($1,$2,'reviewer')",
        [id, subject],
      );
    return id;
  };
  const activate = async (repository: string, input = candidate()) =>
    txn(async (c) => {
      const id = await createCriterion(c, repository, admin, input);
      let version = 1;
      await evaluateCriterion(
        c,
        await lockCriterion(c, repository, id, version),
        admin,
        criterionEvaluationCreateSchema.parse({
          expectedVersion: version,
          cases: ['defect', 'fixed', 'normal', 'counter-evidence'].map((kind) => ({
            kind,
            name: kind,
            source: 'synthetic',
            observed: kind === 'defect' ? 'finding' : 'clear',
            evidence: 'Explicit fixture observation',
          })),
          note: 'Synthetic manual fixture',
        }),
      );
      version++;
      for (const action of ['evaluate', 'shadow', 'activate'] as const) {
        await actOnCriterion(c, await lockCriterion(c, repository, id, version), admin, {
          expectedVersion: version,
          action,
          note: 'Synthetic review',
        });
        version++;
      }
      return id;
    });
  const scope = async (repository: string, part = 'policy', owner: string | null = null) => {
    const id = (
      await db.query('select request_review_knowledge($1,$2,$3,$4) as id', [
        repository,
        part,
        owner,
        'test-request',
      ])
    ).rows[0].id;
    await db.query("update review_knowledge_scopes set retry_after='infinity' where id<>$1", [id]);
    return id;
  };
  const read = async (id: string) => {
    const row = (
      await db.query(
        `select s.*,a.locator,r.content_hash from review_knowledge_scopes s join review_knowledge_releases r on r.id=s.current_release_id join artifacts a on a.id=r.artifact_id where s.id=$1`,
        [id],
      )
    ).rows[0];
    const bytes = await store.readText(row.locator);
    expect(hash(bytes)).toBe(row.content_hash);
    return { row, bytes, bundle: centralKnowledgeBundle(JSON.parse(bytes)) };
  };
  const publish = async (repository: string, part = 'policy', owner: string | null = null) => {
    const id = await scope(repository, part, owner);
    const claim = await claimKnowledgePublication(db);
    expect(claim?.id).toBe(id);
    expect(await publishKnowledge(db, store, claim!)).not.toBe('failed');
    return read(id);
  };
  const memory = async (
    repository: string,
    owner: string | null,
    kind = 'decision',
    detail = 'PRIVATE_SOURCE_DETAIL',
  ) => {
    const id = randomUUID();
    await db.query(
      `insert into review_memories(id,tenant_id,repository_id,scope,owner_user_id,kind,state,summary,detail,search_text,aggregation_key,source_kind,source_anchor,content_hash,reviewed_by,reviewed_at)
    values($1,$2,$3,$4,$5,$6,'active','Original memory',$7,'source',$8,'manual',$9::jsonb,$8,$10,clock_timestamp())`,
      [
        id,
        tenant,
        repository,
        owner ? 'personal' : 'collective',
        owner,
        kind,
        detail,
        hash(id),
        JSON.stringify({ raw: 'PRIVATE_ANCHOR', author: 'PRIVATE_CONTRIBUTOR' }),
        owner ?? admin,
      ],
    );
    return id;
  };
  const approve = async (repository: string, id: string, user: string, body = content()) =>
    txn(async (c) => {
      const m = (
        await c.query<ReviewMemoryRecord>(
          `select ${reviewMemoryColumns} from review_memories where id=$1`,
          [id],
        )
      ).rows[0]!;
      return approveKnowledgeMemory(
        c,
        repository,
        user,
        id,
        (await knowledgeMemoryApprovalFingerprint(c, m))!,
        body,
      );
    });

  it('writes outbox changes in the source transaction and publishes full Skills with only approved criteria', async () => {
    const repository = await repo();
    const approved = await activate(repository);
    await txn((c) =>
      createCriterion(c, repository, admin, { ...candidate(), origin: 'model-candidate' }),
    );
    const before = (await db.query('select count(*)::int as n from review_knowledge_outbox'))
      .rows[0].n;
    const c = await db.connect();
    try {
      await c.query('begin');
      await createCriterion(c, repository, admin, candidate());
      await c.query('rollback');
    } finally {
      c.release();
    }
    expect(
      (await db.query('select count(*)::int as n from review_knowledge_outbox')).rows[0].n,
    ).toBe(before);
    const result = await publish(repository);
    expect(result.bundle.component).toBe('policy');
    if (result.bundle.component !== 'policy') throw Error('policy required');
    expect(result.bundle.criteria.map((x) => x.id)).toEqual([approved]);
    const { contentHash, ...item } = result.bundle.criteria[0]!;
    expect(hash(canonicalKnowledgeJson(item))).toBe(contentHash);
    expect(
      result.bundle.skills.skills.every((x) => x.markdown.length > 0 && x.instructions.length > 0),
    ).toBe(true);
    expect(result.bytes).not.toContain('RAW_SOURCE_MUST_NOT_BE_IN_BUNDLE');
    expect(result.bytes).not.toContain('PRIVATE_CONTRIBUTOR');
    expect(
      (
        await db.query(
          'select count(*)::int as n from review_knowledge_outbox where scope_id=$1 and processed_at is null',
          [result.row.id],
        )
      ).rows[0].n,
    ).toBe(0);
    await expect(
      db.query('update review_knowledge_releases set content_hash=$2 where id=$1', [
        result.row.current_release_id,
        'f'.repeat(64),
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('republishes v1 scopes on upgrade and prevents an old worker acknowledging them', async () => {
    const repository = await repo();
    const result = await publish(repository);
    const c = await db.connect();
    try {
      await c.query('begin');
      // Recreate the pre-upgrade catalog for this owned test scope. Roll back all DDL below.
      await c.query('drop trigger review_knowledge_v2_publication on review_knowledge_scopes');
      await c.query('drop function require_review_knowledge_v2()');
      await c.query(
        'update artifacts set version=1 where id=(select artifact_id from review_knowledge_releases where id=$1)',
        [result.row.current_release_id],
      );
      await c.query(
        await readFile('packages/db/migrations/0042_knowledge_precedence_contract.sql', 'utf8'),
      );
      const scope = (
        await c.query('select * from review_knowledge_scopes where id=$1', [result.row.id])
      ).rows[0];
      expect(Number(scope.requested_revision)).toBeGreaterThan(Number(scope.published_revision));
      expect(scope.current_release_id).toBe(result.row.current_release_id);
      expect(
        (
          await c.query(
            'select reason from review_knowledge_outbox where scope_id=$1 order by revision desc limit 1',
            [scope.id],
          )
        ).rows[0].reason,
      ).toBe('contract.v2');
      await c.query('savepoint old_worker');
      await expect(
        c.query(
          'update review_knowledge_scopes set published_revision=requested_revision where id=$1',
          [scope.id],
        ),
      ).rejects.toThrow('requires a v2 worker');
      await c.query('rollback to savepoint old_worker');
      expect(
        (
          await c.query('select count(*)::int as n from review_knowledge_releases where id=$1', [
            result.row.current_release_id,
          ])
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
  it('approves grouping identity with projection content and requires reapproval after a grouping change', async () => {
    const repository = await repo();
    const id = await memory(repository, alice);
    await approve(repository, id, alice);
    const initial = await publish(repository, 'personal', alice);
    if (initial.bundle.component !== 'personal') throw Error('fixture');
    expect(initial.bundle.schemaVersion).toBe(2);
    expect(initial.bundle.memories[0]!.aggregationKey).toBe(hash(id));
    const { contentHash, ...published } = initial.bundle.memories[0]!;
    expect(hash(canonicalKnowledgeJson(published))).toBe(contentHash);
    await db.query('update review_memories set aggregation_key=$2 where id=$1', [
      id,
      hash('changed-group'),
    ]);
    const stale = await publish(repository, 'personal', alice);
    expect(stale.bundle.component === 'personal' && stale.bundle.memories).toEqual([]);
    await approve(repository, id, alice);
    const approved = await publish(repository, 'personal', alice);
    expect(
      approved.bundle.component === 'personal' && approved.bundle.memories[0]!.aggregationKey,
    ).toBe(hash('changed-group'));
  });
  it('requires separate memory projection approval and never mixes personal scopes', async () => {
    const repository = await repo();
    const a = await memory(repository, alice);
    const b = await memory(repository, bob);
    const shared = await memory(repository, null);
    await expect(approve(repository, a, admin)).rejects.toMatchObject({ statusCode: 404 });
    const empty = await publish(repository, 'personal', alice);
    expect(empty.bundle.component === 'personal' && empty.bundle.memories).toEqual([]);
    await approve(repository, a, alice, { ...content(), summary: 'Alice private approved' });
    await approve(repository, b, bob, { ...content(), summary: 'Bob private approved' });
    await expect(approve(repository, shared, alice)).rejects.toMatchObject({ statusCode: 404 });
    await approve(repository, shared, admin);
    const own = await publish(repository, 'personal', alice);
    const other = await publish(repository, 'personal', bob);
    const publicBundle = await publish(repository, 'collective');
    expect(own.bytes).toContain('Alice private approved');
    expect(own.bytes).not.toContain('Bob private approved');
    expect(other.bytes).not.toContain('Alice private approved');
    expect(publicBundle.bytes).not.toContain('private approved');
    expect(publicBundle.bytes).not.toContain('PRIVATE_SOURCE_DETAIL');
    expect(publicBundle.bytes).not.toContain('PRIVATE_ANCHOR');
    expect(own.bundle.component === 'personal' && own.bundle.memories[0]!.sources[0]!.id).toBe(a);
    expect(own.row.id).not.toBe(other.row.id);
    expect(own.row.locator).not.toBe(other.row.locator);
    await db.query(
      "update review_memories set detail='Edited without updating legacy hash' where id=$1",
      [a],
    );
    const changed = await publish(repository, 'personal', alice);
    expect(changed.bundle.component === 'personal' && changed.bundle.memories).toEqual([]);
    expect(changed.row.last_excluded_items).toHaveLength(1);
    expect(await store.readText(own.row.locator)).toBe(own.bytes);
  });
  it('retains the old pointer on partial storage failure and reuses an orphan safely on retry', async () => {
    const repository = await repo();
    const prior = await publish(repository);
    await activate(repository);
    const id = await scope(repository);
    const claimed = (await claimKnowledgePublication(db))!;
    const failing = {
      commitText: store.commitText.bind(store),
      inspect: async () => ({ exists: false, checksum: null, byteSize: null, modifiedAt: null }),
    };
    expect(await publishKnowledge(db, failing, claimed)).toBe('failed');
    expect((await read(id)).row.current_release_id).toBe(prior.row.current_release_id);
    const orphans = (await store.list()).filter(
      (x) =>
        x.locator.startsWith('review-knowledge/' + id + '/') && x.locator !== prior.row.locator,
    );
    expect(orphans).toHaveLength(1);
    const recovered = await publish(repository);
    expect(recovered.row.release_sequence).toBe(prior.row.release_sequence + 1);
    expect(recovered.row.locator).toBe(orphans[0]!.locator);
    const same = await publish(repository);
    expect(same.row.current_release_id).toBe(recovered.row.current_release_id);
    expect(same.bytes).toBe(recovered.bytes);
  });
  it('fences expired and stale publishers and claims pending work only once', async () => {
    const repository = await repo();
    const id = await scope(repository);
    const claims = await Promise.all([
      claimKnowledgePublication(db),
      claimKnowledgePublication(db),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const old = claims.find(Boolean)!;
    await db.query(
      "update review_knowledge_scopes set claim_until=clock_timestamp()-interval '1 second' where id=$1",
      [id],
    );
    const replacement = (await claimKnowledgePublication(db))!;
    expect(replacement.claim_token).not.toBe(old.claim_token);
    expect(await publishKnowledge(db, store, old)).toBe('superseded');
    expect(await publishKnowledge(db, store, replacement)).toBe('published');
    await scope(repository);
    const stale = (await claimKnowledgePublication(db))!;
    await activate(repository);
    expect(await publishKnowledge(db, store, stale)).toBe('superseded');
    const retry = await claimKnowledgePublication(db);
    expect(retry?.id).toBe(id);
    expect(await publishKnowledge(db, store, retry!)).toBe('published');
  });
  it('withdraws retired criteria and rejects high-risk records without a current independent owner', async () => {
    const repository = await repo();
    const rule = await activate(repository);
    const original = await publish(repository);
    await txn(async (c) => {
      const version = (await c.query('select version from review_rules where id=$1', [rule]))
        .rows[0].version;
      await actOnCriterion(c, await lockCriterion(c, repository, rule, version), admin, {
        expectedVersion: version,
        action: 'retire',
        note: 'Withdraw synthetic rule',
      });
    });
    const retired = await publish(repository);
    expect(retired.bundle.component === 'policy' && retired.bundle.criteria).toEqual([]);
    expect(retired.row.release_sequence).toBe(original.row.release_sequence + 1);
    await txn(async (c) => {
      const id = await createCriterion(c, repository, admin, candidate('P1'));
      await evaluateCriterion(
        c,
        await lockCriterion(c, repository, id, 1),
        admin,
        criterionEvaluationCreateSchema.parse({
          expectedVersion: 1,
          note: 'Synthetic cases',
          cases: ['defect', 'fixed', 'normal', 'counter-evidence'].map((kind) => ({
            kind,
            name: kind,
            source: 'fixture',
            observed: kind === 'defect' ? 'finding' : 'clear',
            evidence: 'fixture',
          })),
        }),
      );
      await c.query("update review_rules set state='active' where id=$1", [id]);
    });
    const invalid = await publish(repository);
    expect(invalid.bundle.component === 'policy' && invalid.bundle.criteria).toEqual([]);
    expect(invalid.row.last_excluded_items).toHaveLength(1);
  });
  it('coordinates artifact publication with retention and removes registry references on repository deletion', async () => {
    const repository = await repo();
    const id = await scope(repository);
    const claim = (await claimKnowledgePublication(db))!;
    const guard = await db.connect();
    await guard.query('select pg_advisory_lock(746278433)');
    let writing = false;
    const storeWithSignal = {
      commitText: async (...args: Parameters<FilesystemArtifactStore['commitText']>) => {
        writing = true;
        return store.commitText(...args);
      },
      inspect: store.inspect.bind(store),
    };
    const pending = publishKnowledge(db, storeWithSignal, claim);
    try {
      await expect
        .poll(
          async () =>
            Number(
              (
                await db.query(
                  "select count(*) as n from pg_locks where locktype='advisory' and objid=746278433 and not granted",
                )
              ).rows[0].n,
            ),
          { timeout: 5000 },
        )
        .toBeGreaterThan(0);
      expect(writing).toBe(false);
    } finally {
      await guard.query('select pg_advisory_unlock(746278433)');
      guard.release();
    }
    expect(await pending).toBe('published');
    const published = await read(id);
    await db.query('delete from repositories where id=$1', [repository]);
    expect(
      (
        await db.query(
          "select id from artifacts where scope_type='review-knowledge' and scope_id=$1",
          [id],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (await db.query('select id from review_knowledge_releases where scope_id=$1', [id])).rowCount,
    ).toBe(0);
    expect((await store.inspect(published.row.locator)).exists).toBe(true); // Retention grace owns physical orphan removal.
  });
  it('withdraws criteria when a memory source changes content or becomes personal', async () => {
    const repository = await repo();
    const source = await memory(repository, null);
    const m = (
      await db.query<ReviewMemoryRecord>(
        `select ${reviewMemoryColumns} from review_memories where id=$1`,
        [source],
      )
    ).rows[0]!;
    const input = candidate();
    input.decision.sources = [{ kind: 'memory', id: source, contentHash: m.contentHash }];
    await activate(repository, input);
    const initial = await publish(repository);
    expect(initial.bundle.component === 'policy' && initial.bundle.criteria.length).toBe(1);
    await db.query(
      "update review_memories set detail='Changed raw source without updating legacy hash' where id=$1",
      [source],
    );
    const changed = await publish(repository);
    expect(changed.bundle.component === 'policy' && changed.bundle.criteria).toEqual([]);
    await activate(repository, input);
    const renewed = await publish(repository);
    expect(renewed.bundle.component === 'policy' && renewed.bundle.criteria.length).toBe(1);
    await db.query("update review_memories set scope='personal',owner_user_id=$2 where id=$1", [
      source,
      alice,
    ]);
    const privateSource = await publish(repository);
    expect(privateSource.bundle.component === 'policy' && privateSource.bundle.criteria).toEqual(
      [],
    );
    expect(privateSource.bytes).not.toContain('Changed raw source');
    expect(await store.readText(initial.row.locator)).toBe(initial.bytes);
  });
  it('leaves the published pointer unchanged when a real projected component exceeds the byte limit', async () => {
    const repository = await repo();
    const prior = await publish(repository, 'collective');
    for (let i = 0; i < 180; i++) {
      const id = await memory(repository, null);
      await approve(repository, id, admin, { ...content(), detail: '한'.repeat(4000) });
    }
    const id = await scope(repository, 'collective');
    const claim = (await claimKnowledgePublication(db))!;
    let writes = 0;
    const guarded = {
      commitText: async (...args: Parameters<FilesystemArtifactStore['commitText']>) => {
        writes++;
        return store.commitText(...args);
      },
      inspect: store.inspect.bind(store),
    };
    expect(await publishKnowledge(db, guarded, claim)).toBe('failed');
    expect(writes).toBe(0);
    const after = await read(id);
    expect(after.row.current_release_id).toBe(prior.row.current_release_id);
    expect(after.row.last_error).toBe('PUBLICATION_INVALID');
    expect(after.row.requested_revision).not.toBe(after.row.published_revision);
  }, 30000);
  it('invalidates a personal projection when its PR source changes or is ignored', async () => {
    const repository = await repo();
    const pr = (
      await db.query(
        "insert into pull_requests(repository_id,github_id,number,title,state,author_login,html_url,base_ref,base_sha,head_ref,head_sha,github_updated_at) values($1,1,1,'Synthetic','open','fixture','https://example.invalid/pr/1','main',$2,'feature',$3,clock_timestamp()) returning id",
        [repository, 'a'.repeat(40), 'b'.repeat(40)],
      )
    ).rows[0].id;
    const source = (
      await db.query(
        "insert into github_pr_messages(tenant_id,repository_id,pull_request_id,github_id,kind,author_login,body,content_hash,html_url,github_created_at,github_updated_at) values($1,$2,$3,1,'issue-comment','fixture','Original PR source',$4,'https://example.invalid/comment/1',clock_timestamp(),clock_timestamp()) returning id",
        [tenant, repository, pr, 'c'.repeat(64)],
      )
    ).rows[0].id;
    const id = await memory(repository, alice);
    await db.query(
      "update review_memories set source_kind='github-pr-message',source_github_pr_message_id=$2,source_github_pr_message_content_hash=$3 where id=$1",
      [id, source, 'c'.repeat(64)],
    );
    await approve(repository, id, alice);
    const initial = await publish(repository, 'personal', alice);
    expect(initial.bundle.component === 'personal' && initial.bundle.memories.length).toBe(1);
    await db.query("update github_pr_messages set body='Changed PR source' where id=$1", [source]);
    const changed = await publish(repository, 'personal', alice);
    expect(changed.bundle.component === 'personal' && changed.bundle.memories).toEqual([]);
    await approve(repository, id, alice);
    const approved = await publish(repository, 'personal', alice);
    expect(approved.bundle.component === 'personal' && approved.bundle.memories.length).toBe(1);
    await db.query(
      "insert into github_pr_message_user_states(message_id,user_id,state) values($1,$2,'ignored')",
      [source, alice],
    );
    const ignored = await publish(repository, 'personal', alice);
    expect(ignored.bundle.component === 'personal' && ignored.bundle.memories).toEqual([]);
    expect(ignored.bytes).not.toContain('Changed PR source');
    await expect(approve(repository, id, alice)).rejects.toMatchObject({ statusCode: 409 });
  });
  it('rejects oversize UTF-8 bundles without truncation and keeps canonical bytes stable', () => {
    const base = {
      schemaVersion: 1,
      tenantId: tenant,
      repositoryId: randomUUID(),
      component: 'personal',
      ownerUserId: alice,
    };
    const item = {
      id: randomUUID(),
      revision: 1,
      contentHash: 'a'.repeat(64),
      sourceRevision: 1,
      sourceContentHash: 'b'.repeat(64),
      kind: 'open-question',
      content: { ...content(), detail: '한'.repeat(4000) },
      sources: [{ kind: 'memory', id: randomUUID(), contentHash: 'b'.repeat(64) }],
      sourceBaseSha: null,
      sourceHeadSha: null,
      supersedesId: null,
    };
    expect(() =>
      encodeKnowledgeBundle({
        ...base,
        memories: Array.from({ length: 200 }, () => ({ ...item, id: randomUUID() })),
      }),
    ).toThrow('byte limit');
    expect(canonicalKnowledgeJson({ b: [2, '한'], a: 1 })).toBe(
      canonicalKnowledgeJson({ a: 1, b: [2, '한'] }),
    );
    expect(() => encodeKnowledgeBundle({ ...base, memories: [], rawSource: 'private' })).toThrow();
  });
});
