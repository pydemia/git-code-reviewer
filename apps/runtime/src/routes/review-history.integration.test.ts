import { projectKnowledge, type KnowledgeScope } from '../services/knowledge-projection.js';
import { recallReviewMemories } from '../services/review-memory.js';
import { centralKnowledgeBundle } from '@gcr/client-contract';
import { chromium } from 'playwright';
import { createServer } from '../../../web/src/review-criteria-test-server.js';
import { registerAuthentication } from '../auth/index.js';
import { issueClientKey, ClientCredentialError } from '../auth/client-credentials.js';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import type { GitHubReader, PullRequestMessageObservation } from '@gcr/github';
import { GitHubConversationLimitError } from '@gcr/github';
import { loadConfig } from '../config.js';
import { AuthorizationService } from '../services/authorization.js';
import { ensureFixtureRepository, persistPullRequestMessages } from '../services/repositories.js';
import { registerReviewHistoryRoutes } from './review-history.js';
import { claimJob } from '../jobs/worker.js';
import { recoverExpiredJobs } from '../jobs/recovery.js';
import { executeHistoryCollectionJob } from '../services/review-history-collection.js';
import type { AuthUser } from '../auth/index.js';
const databaseUrl = process.env.GCR_TEST_DATABASE_URL;
const message = (body = 'original', id = 101): PullRequestMessageObservation => ({
  githubId: id,
  kind: 'review-comment',
  author: 'reviewer',
  authorType: 'User',
  body,
  path: 'src/test.ts',
  line: 1,
  side: 'RIGHT',
  commitSha: 'b'.repeat(40),
  inReplyToGithubId: id === 102 ? 101 : null,
  url: `https://github.example/pull/7#discussion_r${id}`,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-02T00:00:00Z',
});
describe.skipIf(!databaseUrl).sequential('bounded review history', () => {
  const schema = 'gcr_history_' + randomUUID().replaceAll('-', '');
  let root: Database,
    db: Database,
    repo: string,
    admin: AuthUser,
    reader: AuthUser,
    app: ReturnType<typeof Fastify>;
  const config = () =>
    loadConfig({ DATABASE_URL: databaseUrl!, AUTH_MODE: 'development', GITHUB_MODE: 'disabled' });
  const headers = (who = 'admin') => ({ 'x-test-actor': who });
  const base = () => `/api/v1/repositories/${repo}/review-history`;
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw Error('Owned local database required');
    root = createDatabase(url.toString());
    await root.query(`create schema ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    db = createDatabase(url.toString());
    await runMigrations(db, path.resolve('packages/db/migrations'));
    repo = (await ensureFixtureRepository(db))!;
    const tenant = (await db.query('select tenant_id from repositories where id=$1', [repo]))
      .rows[0].tenant_id;
    for (const role of ['administrator', 'reviewer'] as const) {
      const user = (
        await db.query(
          'insert into users(oidc_subject,display_name,role) values($1,$1,$2) returning id',
          [role, role],
        )
      ).rows[0];
      await db.query('insert into tenant_memberships(tenant_id,user_id) values($1,$2)', [
        tenant,
        user.id,
      ]);
      await db.query(
        "insert into repository_grants(repository_id,subject_or_group,role) values($1,$2,'reviewer')",
        [repo, role],
      );
      const actor: AuthUser = {
        id: user.id,
        subject: role,
        displayName: role,
        role,
        groups: [],
        enabled: true,
        tenantIds: [tenant],
        tenants: [{ id: tenant, slug: 'default', displayName: 'default' }],
      };
      if (role === 'administrator') admin = actor;
      else reader = actor;
    }
    for (const n of [7, 8])
      await db.query(
        `insert into pull_requests(repository_id,github_id,number,title,state,draft,author_login,html_url,base_ref,base_sha,head_ref,head_sha,github_updated_at) values($1,$2::int,$2::int,'History','closed',false,'author','https://github.example/pull/'||$2::text,'main',$3,'feature',$4,clock_timestamp())`,
        [repo, n, 'a'.repeat(40), 'b'.repeat(40)],
      );
    app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.user =
        request.headers['x-test-actor'] === 'admin'
          ? admin
          : request.headers['x-test-actor'] === 'reader'
            ? reader
            : null;
    });
    await registerReviewHistoryRoutes(app, db, new AuthorizationService(config()));
    app.get('/api/v1/me', async (request) => ({ schemaVersion: 1, ...request.user }));
    app.get('/api/v1/repositories', async () => ({
      schemaVersion: 1,
      items: [
        {
          id: repo,
          githubId: '1',
          tenantId: tenant,
          tenantSlug: 'default',
          tenantName: 'Default',
          owner: 'fixture',
          name: 'history',
          webBaseUrl: 'https://github.example',
          lastPolledAt: null,
          nextPollAt: null,
          pollOutcome: null,
          pollError: null,
        },
      ],
      nextCursor: null,
    }));
  });
  afterAll(async () => {
    await app?.close();
    await db?.end();
    if (root) {
      await root.query(`drop schema if exists ${schema} cascade`);
      await root.end();
    }
  });
  it('queues only listed known PRs, deduplicates requests and rejects reader writes', async () => {
    const payload = { requestKey: randomUUID(), pullNumbers: [7, 8] };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: base() + '/collections',
          headers: headers('reader'),
          payload,
        })
      ).statusCode,
    ).toBe(404);
    const a = await app.inject({
      method: 'POST',
      url: base() + '/collections',
      headers: headers(),
      payload,
    });
    expect(a.statusCode, a.body).toBe(202);
    const b = await app.inject({
      method: 'POST',
      url: base() + '/collections',
      headers: headers(),
      payload,
    });
    expect(b.json().id).toBe(a.json().id);
    expect(
      (await db.query("select count(*)::int as n from jobs where type='history.collect'")).rows[0]
        .n,
    ).toBe(2);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: base() + '/collections',
          headers: headers(),
          payload: { ...payload, pullNumbers: [7] },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: base() + '/collections',
          headers: headers(),
          payload: { requestKey: randomUUID(), pullNumbers: [999] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: base() + '/collections',
          headers: headers(),
          payload: {
            requestKey: randomUUID(),
            pullNumbers: Array.from({ length: 21 }, (_, i) => i + 1),
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          url: base() + '/collections/' + a.json().id,
          headers: headers('reader'),
        })
      ).statusCode,
    ).toBe(200);
  });
  it('recovers interrupted collection leases, commits complete source and does not re-read completed PRs', async () => {
    const first = (await claimJob(db, 'history-worker'))!;
    expect(first.type).toBe('history.collect');
    await db.query(
      "update jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [first.id],
    );
    await recoverExpiredJobs(db);
    const job = (await claimJob(db, 'history-worker'))!;
    const fetch = vi.fn(async () => [message(), message('reply', 102)]);
    const github = { listPullRequestMessages: fetch } as unknown as GitHubReader;
    await expect(executeHistoryCollectionJob(db, github, config(), first)).rejects.toThrow(
      'job_lease_lost',
    );
    await executeHistoryCollectionJob(db, github, config(), job);
    await executeHistoryCollectionJob(db, github, config(), job);
    expect(fetch).toHaveBeenCalledTimes(1);
    const result = (
      await db.query(
        'select completed_at,message_count from review_history_collection_items where job_id=$1',
        [job.id],
      )
    ).rows[0];
    expect(result.completed_at).not.toBeNull();
    expect(result.message_count).toBe(2);
    const pull = (
      await db.query('select number from pull_requests where id=$1', [job.payload.pullRequestId])
    ).rows[0].number;
    expect(
      (await db.query('select count(*)::int as n from review_history_coverage')).rows[0].n,
    ).toBe(1);
    await db.query(
      "update jobs set state='completed',lease_owner=null,lease_expires_at=null where id=$1",
      [job.id],
    );
    expect((await db.query('select count(*)::int as n from analysis_runs')).rows[0].n).toBe(0);
    expect([7, 8]).toContain(pull);
  });
  it('retains original and absence observations, rejects late overwrite and restores reappearing source', async () => {
    const t = new Date(Date.now() + 10000);
    await persistPullRequestMessages(db, repo, 7, [message('original', 201)], t, undefined, {
      complete: true,
    });
    await persistPullRequestMessages(db, repo, 7, [], new Date(t.getTime() + 2000), undefined, {
      complete: true,
    });
    let row = (await db.query('select * from github_pr_messages where github_id=201')).rows[0];
    expect(row.body).toBe('original');
    expect(row.upstream_state).toBe('not-returned');
    await persistPullRequestMessages(
      db,
      repo,
      7,
      [message('late', 201)],
      new Date(t.getTime() + 1000),
      undefined,
      { complete: true },
    );
    row = (await db.query('select * from github_pr_messages where github_id=201')).rows[0];
    expect(row.body).toBe('original');
    expect(row.upstream_state).toBe('not-returned');
    await persistPullRequestMessages(
      db,
      repo,
      7,
      [message('edited', 201)],
      new Date(t.getTime() + 3000),
      undefined,
      { complete: true },
    );
    row = (await db.query('select * from github_pr_messages where github_id=201')).rows[0];
    expect(row.body).toBe('edited');
    expect(row.upstream_state).toBe('present');
    const snapshots = (
      await db.query(
        'select snapshot from github_pr_message_observations where message_id=$1 order by id',
        [row.id],
      )
    ).rows;
    expect(snapshots.map((x) => x.snapshot.body)).toEqual(['original', 'original', 'edited']);
    expect(snapshots[1].snapshot.upstreamState).toBe('not-returned');
  });
  it('does not replace complete coverage or mark messages absent on a failed bounded read', async () => {
    const job = (await claimJob(db, 'history-worker'))!;
    const before = (
      await db.query('select * from review_history_coverage order by pull_request_id')
    ).rows;
    await expect(
      executeHistoryCollectionJob(
        db,
        {
          listPullRequestMessages: async () => {
            throw new GitHubConversationLimitError();
          },
        } as unknown as GitHubReader,
        config(),
        job,
      ),
    ).rejects.toMatchObject({ code: 'HISTORY_PAGE_LIMIT' });
    expect(
      (await db.query('select * from review_history_coverage order by pull_request_id')).rows,
    ).toEqual(before);
    expect(
      (
        await db.query('select completed_at from review_history_collection_items where job_id=$1', [
          job.id,
        ])
      ).rows[0].completed_at,
    ).toBeNull();
  });
  it('reads history without an analysis or memory approval and fences pages by revision and repository', async () => {
    const list = await app.inject({ url: base() + '?limit=1', headers: headers('reader') });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().nextCursor).toBeTruthy();
    const next = await app.inject({
      url: base() + '?limit=1&cursor=' + list.json().nextCursor,
      headers: headers('reader'),
    });
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json().items[0].id).not.toBe(list.json().items[0].id);
    const messages = await app.inject({
      url: base() + '/pulls/7/messages?limit=1',
      headers: headers('reader'),
    });
    expect(messages.statusCode, messages.body).toBe(200);
    expect(messages.headers['cache-control']).toBe('private, no-store');
    expect(messages.json().items[0].body).toBeUndefined();
    const row = (await db.query('select id from github_pr_messages where github_id=201')).rows[0];
    const detail = await app.inject({
      url: base() + '/pulls/7/messages/' + row.id,
      headers: headers('reader'),
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().item.body).toBe('edited');
    const history = await app.inject({
      url: base() + '/pulls/7/messages/' + row.id + '/history',
      headers: headers('reader'),
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(
      history
        .json()
        .items.some(
          (x: { snapshot: { upstreamState?: string } }) =>
            x.snapshot.upstreamState === 'not-returned',
        ),
    ).toBe(true);
    expect(
      (
        await app.inject({
          url: base() + '/pulls/8/messages/' + row.id,
          headers: headers('reader'),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: base() + '?localDiff=secret', headers: headers('reader') }))
        .statusCode,
    ).toBe(400);
    await persistPullRequestMessages(
      db,
      repo,
      7,
      [message('new revision', 201)],
      new Date(Date.now() + 3600000),
    );
    const stale = await app.inject({
      url: base() + '?cursor=' + list.json().nextCursor,
      headers: headers('reader'),
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect((await db.query('select count(*)::int as n from review_memories')).rows[0].n).toBe(0);
  });

  it('reads legacy body versions that have no REST observation without inventing thread history', async () => {
    const row = (await db.query('select * from github_pr_messages where github_id=201')).rows[0];
    const body = 'Legacy body before observation collection';
    await db.query(
      `insert into github_pr_message_versions(message_id,content_hash,body,path,github_updated_at,observed_at) values($1,$2,$3,'old/path.py','2026-01-01','2026-01-02')`,
      [row.id, createHash('sha256').update(body).digest('hex'), body],
    );
    const response = await app.inject({
      url: base() + '/pulls/7/messages/' + row.id + '/versions',
      headers: headers('reader'),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items.some((v: { body: string }) => v.body === body)).toBe(true);
    expect(response.json().items.find((v: { body: string }) => v.body === body).path).toBe(
      'old/path.py',
    );
    const observations = await app.inject({
      url: base() + '/pulls/7/messages/' + row.id + '/history',
      headers: headers('reader'),
    });
    expect(observations.body).not.toContain(body);
    expect(
      (
        await app.inject({
          url: base() + '/pulls/8/messages/' + row.id + '/versions',
          headers: headers('reader'),
        })
      ).statusCode,
    ).toBe(404);
    for (let i = 0; i < 12; i++)
      await db.query(
        `insert into github_pr_message_versions(message_id,content_hash,body,github_updated_at) values($1,$2,$3,'2026-01-01')`,
        [
          row.id,
          createHash('sha256')
            .update('body' + i)
            .digest('hex'),
          'body' + i,
        ],
      );
    const first = await app.inject({
      url: base() + '/pulls/7/messages/' + row.id + '/versions',
      headers: headers('reader'),
    });
    expect(first.json().items).toHaveLength(10);
    const second = await app.inject({
      url: base() + '/pulls/7/messages/' + row.id + '/versions?cursor=' + first.json().nextCursor,
      headers: headers('reader'),
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(
      second
        .json()
        .items.some((v: { id: string }) =>
          first.json().items.some((x: { id: string }) => x.id === v.id),
        ),
    ).toBe(false);
  });
  it('accepts real existing reader credentials only on GET routes and revokes access immediately', async () => {
    const serverId = randomUUID(),
      sessionToken = randomUUID(),
      hash = (x: string) => createHash('sha256').update(x).digest('hex');
    await db.query(
      "insert into local_credentials(user_id,username,password_hash) values($1,'history-reader','owned-test-hash')",
      [reader.id],
    );
    await db.query(
      "insert into user_sessions(id_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 hour')",
      [hash(sessionToken), reader.id],
    );
    const key = await issueClientKey(db, {
      user: reader,
      sessionToken,
      serverId,
      authMode: 'local',
      requestId: 'history-reader-test',
      input: {
        name: 'Owned reader',
        clientId: 'commit-defender',
        tenantId: reader.tenantIds[0],
        repositoryIds: [repo],
        scopes: ['knowledge:read'],
        lifetimeDays: 1,
      },
    });
    const cfg = loadConfig({
      DATABASE_URL: databaseUrl!,
      AUTH_MODE: 'local',
      CLIENT_API_KEYS_ENABLED: 'true',
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      KNOWLEDGE_PUBLICATION_ENABLED: 'true',
      KNOWLEDGE_DISTRIBUTION_ENABLED: 'true',
      KNOWLEDGE_SIGNING_KEY_ID: 'fixture',
      KNOWLEDGE_SIGNING_KEY_FILE: '/synthetic-not-read',
      KNOWLEDGE_SERVER_ID: serverId,
      LOCAL_BOOTSTRAP_ADMIN_USERNAME: 'history-bootstrap',
      LOCAL_BOOTSTRAP_ADMIN_PASSWORD: 'Owned-only-password-2026!',
    });
    const authenticated = Fastify();
    authenticated.setErrorHandler((error, _request, reply) =>
      reply
        .code(error instanceof ClientCredentialError ? error.statusCode : 500)
        .send({ error: error.message }),
    );
    try {
      await registerAuthentication(authenticated, cfg, db);
      await registerReviewHistoryRoutes(authenticated, db, new AuthorizationService(cfg));
      const auth = { authorization: `Bearer ${key.token}`, 'x-gcr-server-id': serverId };
      const result = await authenticated.inject({ url: base(), headers: auth });
      expect(result.statusCode, result.body).toBe(200);
      expect(
        (
          await authenticated.inject({
            method: 'POST',
            url: base() + '/collections',
            headers: auth,
            payload: { requestKey: randomUUID(), pullNumbers: [7] },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await authenticated.inject({
            url: '/api/v1/repositories/' + randomUUID() + '/review-history',
            headers: auth,
          })
        ).statusCode,
      ).toBe(403);
      await db.query(
        'delete from repository_grants where repository_id=$1 and subject_or_group=$2',
        [repo, reader.subject],
      );
      const denied = await authenticated.inject({ url: base(), headers: auth });
      expect(denied.statusCode, denied.body).toBe(403);
    } finally {
      await authenticated.close();
      await db.query(
        "insert into repository_grants(repository_id,subject_or_group,role) values($1,$2,'reviewer') on conflict do nothing",
        [repo, reader.subject],
      );
    }
  });
  it('activates public source guidance once, publishes existing contract, excludes changed sources and retains history', async () => {
    const row = (await db.query('select * from github_pr_messages where github_id=201')).rows[0];
    const payload = {
      sourceId: row.id,
      contentHash: row.content_hash,
      observationHash: row.observation_hash,
      content: {
        summary: 'Check schema validation',
        detail: 'Source-based guidance',
        recommendation: 'Inspect request validators',
        categories: ['validation'],
        appliesTo: {
          languages: ['Python'],
          filePaths: ['src/test.ts'],
          symbols: [],
          contracts: ['Request-only validation'],
          branches: [],
        },
        counterEvidence: ['Validation requires database state'],
        expiresAt: null,
      },
    };
    const create = () =>
      app.inject({ method: 'POST', url: base() + '/guidance', headers: headers(), payload });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: base() + '/guidance',
          headers: headers('reader'),
          payload,
        })
      ).statusCode,
    ).toBe(404);
    const created = await create();
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    expect((await create()).json().id).toBe(id);
    expect(created.json().publicationRequested).toBe(false);
    const activation = () =>
      app.inject({
        method: 'POST',
        url: base() + '/guidance/' + id + '/activate',
        headers: headers(),
        payload: { revision: 1 },
      });
    const active = await activation();
    expect(active.statusCode, active.body).toBe(200);
    expect(active.json().publicationRequested).toBe(true);
    expect((await activation()).statusCode).toBe(200);
    expect(
      (
        await db.query(
          "select count(*)::int as n from review_memory_events where memory_id=$1 and action='activated'",
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
    const scope = (
      await db.query<KnowledgeScope>(
        "select * from review_knowledge_scopes where repository_id=$1 and component='collective'",
        [repo],
      )
    ).rows[0];
    const projection = await projectKnowledge(db, scope);
    const bundle = centralKnowledgeBundle(JSON.parse(projection.bytes));
    expect(bundle.component).toBe('collective');
    expect(projection.bytes).toContain('Check schema validation');
    expect(projection.bytes).toContain('Validation requires database state');
    expect(projection.bytes).not.toContain('new revision');
    const read = await app.inject({ url: base() + '/guidance/' + id, headers: headers('reader') });
    expect(read.statusCode).toBe(200);
    expect(read.json().source.id).toBe(row.id);
    const tenant = reader.tenantIds[0];
    expect(
      (
        await recallReviewMemories(db, {
          tenantId: tenant,
          repositoryId: repo,
          filePaths: ['src/test.ts'],
        })
      ).items.some((x) => x.id === id),
    ).toBe(true);
    await persistPullRequestMessages(db, repo, 7, [], new Date(Date.now() + 7200000), undefined, {
      complete: true,
    });
    expect(
      (await app.inject({ url: base() + '/guidance/' + id, headers: headers('reader') })).json()
        .needsReview,
    ).toBe(true);
    expect((await projectKnowledge(db, scope)).bytes).not.toContain('Check schema validation');
    expect(
      (
        await recallReviewMemories(db, {
          tenantId: tenant,
          repositoryId: repo,
          filePaths: ['src/test.ts'],
        })
      ).items.some((x) => x.id === id),
    ).toBe(false);
    expect((await activation()).statusCode).toBe(409);
    expect((await create()).statusCode).toBe(409);
    const retired = await app.inject({
      method: 'POST',
      url: base() + '/guidance/' + id + '/retire',
      headers: headers(),
      payload: { revision: 1 },
    });
    expect(retired.statusCode, retired.body).toBe(200);
    expect(
      (await db.query('select body from github_pr_messages where id=$1', [row.id])).rows[0].body,
    ).toBe('new revision');
    // Existing personal/manual rows are not exposed by this public history guidance API.
    const privateRow = (
      await db.query(
        `insert into review_memories(tenant_id,repository_id,scope,owner_user_id,kind,state,summary,search_text,aggregation_key,content_hash,source_kind) values($1,$2,'personal',$3,'decision','candidate','PRIVATE_HISTORY_SENTINEL','private',$4,$4,'manual') returning id`,
        [tenant, repo, reader.id, 'f'.repeat(64)],
      )
    ).rows[0];
    const list = await app.inject({ url: base() + '/guidance', headers: headers('reader') });
    expect(list.body).not.toContain('PRIVATE_HISTORY_SENTINEL');
    expect(
      (await app.inject({ url: base() + '/guidance/' + privateRow.id, headers: headers() }))
        .statusCode,
    ).toBe(404);
  });
  it('keeps a stale draft inactive without leaving a publication projection', async () => {
    await persistPullRequestMessages(
      db,
      repo,
      8,
      [message('draft source', 301)],
      new Date(Date.now() + 8000000),
      undefined,
      { complete: true },
    );
    const row = (await db.query('select * from github_pr_messages where github_id=301')).rows[0];
    const created = await app.inject({
      method: 'POST',
      url: base() + '/guidance',
      headers: headers(),
      payload: {
        sourceId: row.id,
        contentHash: row.content_hash,
        observationHash: row.observation_hash,
        content: {
          summary: 'Draft',
          detail: '',
          recommendation: 'Check',
          categories: [],
          appliesTo: {
            languages: [],
            filePaths: ['src/test.ts'],
            symbols: [],
            contracts: [],
            branches: [],
          },
          counterEvidence: ['Counterexample'],
          expiresAt: null,
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    await persistPullRequestMessages(
      db,
      repo,
      8,
      [message('edited draft source', 301)],
      new Date(Date.now() + 9000000),
      undefined,
      { complete: true },
    );
    const activation = await app.inject({
      method: 'POST',
      url: base() + '/guidance/' + created.json().id + '/activate',
      headers: headers(),
      payload: { revision: 1 },
    });
    expect(activation.statusCode, activation.body).toBe(409);
    expect(
      (await db.query('select state from review_memories where id=$1', [created.json().id])).rows[0]
        .state,
    ).toBe('candidate');
    expect(
      (
        await db.query('select 1 from review_knowledge_memory_projections where memory_id=$1', [
          created.json().id,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it('opens stored source and activates guidance from the central screen at desktop and mobile widths', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw Error('Owned server');
    const vite = await createServer({
      root: path.resolve('apps/web'),
      server: { host: '127.0.0.1', port: 0, proxy: { '/api': `http://127.0.0.1:${address.port}` } },
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await vite.listen();
      const web = vite.httpServer!.address();
      if (!web || typeof web === 'string') throw Error('Owned web');
      browser = await chromium.launch({ channel: 'chrome', headless: true });
      const context = await browser.newContext({
        viewport: { width: 1360, height: 1000 },
        extraHTTPHeaders: headers(),
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${web.port}/review-history`);
      await page
        .locator('.history-messages article')
        .filter({ hasText: 'edited draft source' })
        .getByRole('button', { name: '원문·변경 이력 보기', exact: true })
        .click();
      await page.getByText('원문을 바탕으로 지침 작성', { exact: true }).click();
      await page.getByLabel('지침 요약', { exact: true }).fill('Browser source guidance');
      await page.getByLabel('검토 지침', { exact: true }).fill('Review the request validator');
      await page
        .getByLabel('적용 조건 · 한 줄에 하나', { exact: true })
        .fill('Request validation only');
      await page
        .getByLabel('반증 지침 · 한 줄에 하나', { exact: true })
        .fill('A database lookup is required');
      await page.getByRole('button', { name: '지침 초안 저장', exact: true }).click();
      await page.getByRole('button', { name: '활성화·발행', exact: true }).click();
      await page.getByText('지침을 활성화하고 발행을 요청했습니다.', { exact: true }).waitFor();
      expect(errors).toEqual([]);
      if (process.env.GCR_HISTORY_SCREENSHOT)
        await page.screenshot({
          path: process.env.GCR_HISTORY_SCREENSHOT.replace('.png', '-desktop.png'),
          fullPage: true,
        });
      await page.setViewportSize({ width: 420, height: 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      if (process.env.GCR_HISTORY_SCREENSHOT)
        await page.screenshot({ path: process.env.GCR_HISTORY_SCREENSHOT, fullPage: true });
      await context.close();
      const readerContext = await browser.newContext({ extraHTTPHeaders: headers('reader') });
      const readerPage = await readerContext.newPage();
      await readerPage.goto(`http://127.0.0.1:${web.port}/review-history`);
      await readerPage
        .locator('.history-messages article')
        .filter({ hasText: 'edited draft source' })
        .getByRole('button', { name: '원문·변경 이력 보기', exact: true })
        .click();
      await readerPage.getByText('Browser source guidance', { exact: true }).waitFor();
      expect(await readerPage.getByText('원문을 바탕으로 지침 작성', { exact: true }).count()).toBe(
        0,
      );
      expect(
        await readerPage.getByRole('button', { name: '지침 비활성화', exact: true }).count(),
      ).toBe(0);
      await readerContext.close();
    } finally {
      await browser?.close();
      await vite.close();
    }
  }, 60000);
});
