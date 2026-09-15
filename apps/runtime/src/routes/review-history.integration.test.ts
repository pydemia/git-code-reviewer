import { randomUUID } from 'node:crypto';
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
});
