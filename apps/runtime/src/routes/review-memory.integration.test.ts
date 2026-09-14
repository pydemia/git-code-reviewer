import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import {
  reviewMemorySchema,
  githubPrMemorySourceListSchema,
  githubPrMessageHistorySchema,
} from '@gcr/contracts';
import { listCriterionSources, resolveCriterionSources } from '../services/review-criteria.js';
import { ZodError } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthUser } from '../auth/index.js';
import { loadConfig } from '../config.js';
import { AuthorizationService } from '../services/authorization.js';
import { persistPullRequestMessages } from '../services/repositories.js';
import { registerReviewMemoryRoutes } from './review-memory.js';

const databaseUrl = process.env.GCR_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl).sequential('review memory workflow', () => {
  const schema = `gcr_memory_test_${randomUUID().replaceAll('-', '')}`;
  const actors = new Map<string, AuthUser>();
  let root: Database;
  let database: Database;
  let app: FastifyInstance;
  let tenantId: string;
  let repositoryId: string;
  let analysisId: string;
  let sourceId: string;
  let firstMemoryId: string;
  let secondMemoryId: string;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw Error('Use an isolated local test PostgreSQL');
    }
    root = createDatabase(url.toString());
    await root.query(`create schema ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    database = createDatabase(url.toString());
    await runMigrations(database, path.resolve('packages/db/migrations'));

    tenantId = (
      await database.query(
        `insert into tenants(slug, display_name) values ('memory-test', 'Memory test') returning id`,
      )
    ).rows[0].id;
    for (const [key, role] of [
      ['first', 'reviewer'],
      ['second', 'reviewer'],
      ['admin', 'administrator'],
    ] as const) {
      const id = (
        await database.query(
          `insert into users(oidc_subject, display_name, role)
           values ($1,$2,$3) returning id`,
          [`synthetic:${key}`, key, role],
        )
      ).rows[0].id;
      actors.set(key, {
        id,
        subject: `synthetic:${key}`,
        displayName: key,
        role,
        enabled: true,
        groups: [],
        tenantIds: [tenantId],
        tenants: [{ id: tenantId, slug: 'memory-test', displayName: 'Memory test' }],
      });
    }
    const instanceId = (
      await database.query(
        `insert into github_instances(name, api_base_url, web_base_url)
         values ('memory', 'https://github.example/api/v3/', 'https://github.example/') returning id`,
      )
    ).rows[0].id;
    repositoryId = (
      await database.query(
        `insert into repositories(
           tenant_id, instance_id, github_id, installation_id, owner, name)
         values ($1,$2,1,'1','platform','memory') returning id`,
        [tenantId, instanceId],
      )
    ).rows[0].id;
    for (const actor of actors.values()) {
      await database.query(
        `insert into repository_grants(repository_id, subject_or_group, role)
         values ($1,$2,'reviewer')`,
        [repositoryId, actor.subject],
      );
    }
    const pullRequestId = (
      await database.query(
        `insert into pull_requests(
           repository_id, github_id, number, title, state, draft, author_login, html_url,
           base_ref, base_sha, head_ref, head_sha, github_updated_at)
         values ($1,7,7,'Memory','open',false,'author','https://github.example/pull/7',
           'main',$2,'feature',$3,clock_timestamp()) returning id`,
        [repositoryId, 'a'.repeat(40), 'b'.repeat(40)],
      )
    ).rows[0].id;
    const requestId = (
      await database.query(
        `insert into snapshot_requests(pull_request_id, base_sha, head_sha, state)
         values ($1,$2,$3,'materialized') returning id`,
        [pullRequestId, 'a'.repeat(40), 'b'.repeat(40)],
      )
    ).rows[0].id;
    const snapshotId = (
      await database.query(
        `insert into snapshots(request_id, version, resolution, policy_version)
         values ($1,1,'exact','test') returning id`,
        [requestId],
      )
    ).rows[0].id;
    analysisId = (
      await database.query(
        `insert into analysis_runs(snapshot_id, analysis_key, state)
         values ($1,$2,'completed') returning id`,
        [snapshotId, `memory:${randomUUID()}`],
      )
    ).rows[0].id;
    await persistPullRequestMessages(database, repositoryId, 7, [githubMessage('초기 내용')]);
    sourceId = (
      await database.query(`select id from github_pr_messages where pull_request_id = $1`, [
        pullRequestId,
      ])
    ).rows[0].id;

    const config = loadConfig({ DATABASE_URL: url.toString(), AUTH_MODE: 'development' });
    app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.user = actors.get(String(request.headers['x-test-actor'])) ?? null;
    });
    app.setErrorHandler((error, _request, reply) =>
      reply.code(error instanceof ZodError ? 400 : 500).send({ error: error.message }),
    );
    await registerReviewMemoryRoutes(app, database, new AuthorizationService(config));
  });

  afterAll(async () => {
    await app?.close();
    await database?.end();
    if (root) {
      await root.query(`drop schema if exists ${schema} cascade`);
      await root.end();
    }
  });

  it('collects and lets each user organize GitHub PR messages', async () => {
    const route = `/api/v1/repositories/${repositoryId}/pulls/7/review-memory-sources`;
    const initial = await app.inject({ url: route, headers: actor('first') });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json().items).toMatchObject([
      { id: sourceId, authorLogin: 'reviewer', state: 'available' },
    ]);
    const ignored = await app.inject({
      method: 'PATCH',
      url: `${route}/${sourceId}`,
      headers: actor('first'),
      payload: { state: 'ignored' },
    });
    expect(ignored.statusCode, ignored.body).toBe(200);
    expect(ignored.json().state).toBe('ignored');

    await persistPullRequestMessages(database, repositoryId, 7, [
      githubMessage('재시도 키는 유지해야 합니다.'),
    ]);
    const versions = await database.query(
      `select count(*)::int as count from github_pr_message_versions where message_id = $1`,
      [sourceId],
    );
    expect(versions.rows[0].count).toBe(2);
    const refreshed = await app.inject({ url: route, headers: actor('first') });
    expect(refreshed.json().items[0]).toMatchObject({
      id: sourceId,
      body: '재시도 키는 유지해야 합니다.',
      state: 'ignored',
    });
  });

  it('keeps personal candidates private and aggregates two users into a collective candidate', async () => {
    firstMemoryId = await createAndActivate('first');
    const otherReview = await app.inject({
      method: 'POST',
      url: `/api/v1/review-memories/${firstMemoryId}/review`,
      headers: actor('second'),
      payload: { action: 'retire' },
    });
    expect(otherReview.statusCode).toBe(404);

    expect(
      (
        await database.query(
          `select count(*)::int as count from review_memories where scope = 'collective'`,
        )
      ).rows[0].count,
    ).toBe(0);
    secondMemoryId = await createAndActivate('second');
    expect(secondMemoryId).not.toBe(firstMemoryId);

    const collective = await app.inject({
      url: `/api/v1/admin/review-memories?repositoryId=${repositoryId}&scope=collective&state=candidate`,
      headers: actor('admin'),
    });
    expect(collective.statusCode, collective.body).toBe(200);
    expect(collective.json().items).toHaveLength(1);
    expect(collective.json().items[0]).toMatchObject({
      scope: 'collective',
      contributorCount: 2,
      conflictCount: 0,
    });

    const activated = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/review-memories/${collective.json().items[0].id}/review`,
      headers: actor('admin'),
      payload: { action: 'activate', note: '두 명의 독립 검토 확인' },
    });
    expect(activated.statusCode, activated.body).toBe(200);
    expect(reviewMemorySchema.parse(activated.json().memory).state).toBe('active');

    for (const [user, expectedId] of [
      ['first', firstMemoryId],
      ['second', secondMemoryId],
    ]) {
      const listed = await app.inject({
        url: `/api/v1/analyses/${analysisId}/review-memories`,
        headers: actor(user),
      });
      expect(listed.statusCode, listed.body).toBe(200);
      expect(listed.json().personal.map((memory: { id: string }) => memory.id)).toEqual([
        expectedId,
      ]);
    }
  });

  it('preserves state-only observations, rejects late responses and exposes authorized history', async () => {
    const provenance = {
      provider: 'github-rest' as const,
      reviewState: 'CHANGES_REQUESTED',
      reviewGithubId: '81',
      originalCommitSha: null,
      originalLine: null,
      startLine: null,
      originalStartLine: null,
      startSide: null,
      subjectType: null,
      diffHunk: null,
      threadResolved: null,
      threadOutdated: null,
    };
    const message = {
      ...githubMessage('  Same source text\n'),
      githubId: 81,
      kind: 'review' as const,
      provenance,
    };
    const at = (second: number) => new Date(`2026-09-15T00:00:${String(second).padStart(2, '0')}Z`);
    await persistPullRequestMessages(database, repositoryId, 7, [message], at(1));
    const row = (
      await database.query('select id,observation_hash from github_pr_messages where github_id=81')
    ).rows[0];
    const firstHash = row.observation_hash;
    const outbox = async () =>
      (await database.query('select count(*)::int as n from review_knowledge_outbox')).rows[0].n;
    const before = await outbox();
    await persistPullRequestMessages(database, repositoryId, 7, [message], at(2));
    expect(await outbox()).toBe(before);
    const approved = { ...message, provenance: { ...provenance, reviewState: 'APPROVED' } };
    await persistPullRequestMessages(database, repositoryId, 7, [approved], at(4));
    expect(await outbox()).toBeGreaterThan(before);
    await expect(
      resolveCriterionSources(
        database,
        repositoryId,
        [
          {
            kind: 'github-pr-message',
            id: row.id,
            contentHash: (
              await database.query('select content_hash from github_pr_messages where id=$1', [
                row.id,
              ])
            ).rows[0].content_hash,
            observationHash: firstHash,
          },
        ],
        false,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const after = await outbox();
    await persistPullRequestMessages(database, repositoryId, 7, [message], at(3));
    expect(await outbox()).toBe(after);
    const latest = (
      await database.query(
        'select body,provenance,observation_hash from github_pr_messages where id=$1',
        [row.id],
      )
    ).rows[0];
    expect(latest.body).toBe(message.body);
    expect(latest.provenance.reviewState).toBe('APPROVED');
    expect(latest.observation_hash).not.toBe(firstHash);
    expect(
      (await listCriterionSources(database, repositoryId)).find((s) => s.id === row.id),
    ).toMatchObject({
      observationHash: latest.observation_hash,
      discussion: { reviewState: 'APPROVED', threadResolved: null },
    });
    const base = `/api/v1/repositories/${repositoryId}/pulls/7/review-memory-sources`;
    const listed = await app.inject({ url: base, headers: actor('first') });
    expect(
      githubPrMemorySourceListSchema.parse(listed.json()).items.find((s) => s.id === row.id),
    ).toMatchObject({
      provenance: { reviewState: 'APPROVED' },
      observationHash: latest.observation_hash,
    });
    const historyUrl = `${base}/${row.id}/history`;
    const response = await app.inject({ url: historyUrl, headers: actor('first') });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const history = githubPrMessageHistorySchema.parse(response.json());
    expect(history.items.map((item) => item.snapshot.provenance?.reviewState)).toEqual([
      'APPROVED',
      'CHANGES_REQUESTED',
    ]);
    expect(history.items[0]!.snapshot.body).toBe(message.body);
    expect(
      (
        await database.query(
          'select count(*)::int as n from github_pr_message_versions where message_id=$1',
          [row.id],
        )
      ).rows[0].n,
    ).toBe(1);
    // Returning to an earlier state is another event, not a duplicate snapshot to discard.
    await persistPullRequestMessages(database, repositoryId, 7, [message], at(5));
    expect(
      (await app.inject({ url: historyUrl, headers: actor('first') })).json().items,
    ).toHaveLength(3);
    expect((await app.inject({ url: historyUrl })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: historyUrl.replace('/pulls/7/', '/pulls/8/'),
          headers: actor('first'),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: historyUrl.replace(repositoryId, randomUUID()),
          headers: actor('first'),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: historyUrl + '?cursor=9223372036854775808',
          headers: actor('first'),
        })
      ).statusCode,
    ).toBe(400);
    const next = (
      await app.inject({
        url: historyUrl + '?cursor=' + history.items[0]!.id,
        headers: actor('first'),
      })
    ).json();
    expect(next.items).toHaveLength(1);
    await expect(
      database.query(
        'update github_pr_message_observations set observation_hash=$2 where message_id=$1',
        [row.id, 'a'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.query('delete from github_pr_message_observations where message_id=$1', [row.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await database.query('delete from github_pr_messages where id=$1', [row.id]);
    expect(
      (
        await database.query(
          'select count(*)::int as n from github_pr_message_observations where message_id=$1',
          [row.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it('does not restore an older edited body from a later-started but stale provider response', async () => {
    const fresh = { ...githubMessage('new'), githubId: 82, updatedAt: '2026-09-14T02:00:00Z' };
    await persistPullRequestMessages(
      database,
      repositoryId,
      7,
      [fresh],
      new Date('2026-09-15T01:00:00Z'),
    );
    await persistPullRequestMessages(
      database,
      repositoryId,
      7,
      [{ ...fresh, body: 'old', updatedAt: '2026-09-14T01:00:00Z' }],
      new Date('2026-09-15T01:00:01Z'),
    );
    expect(
      (await database.query('select body from github_pr_messages where github_id=82')).rows[0].body,
    ).toBe('new');
    // Absence from a list is not evidence of deletion.
    await persistPullRequestMessages(database, repositoryId, 7, []);
    expect(
      (await database.query('select body from github_pr_messages where github_id=82')).rows[0].body,
    ).toBe('new');
  });

  async function createAndActivate(user: string): Promise<string> {
    const candidate = await app.inject({
      method: 'POST',
      url: `/api/v1/analyses/${analysisId}/review-memory-candidates`,
      headers: actor(user),
      payload: {
        kind: 'decision',
        summary: '재시도 요청 키 유지',
        detail: 'GitHub PR 논의에서 같은 요청 키를 유지하기로 결정했습니다.',
        recommendation: '재시도마다 idempotency key를 재사용합니다.',
        categories: ['correctness'],
        filePaths: [],
        symbols: [],
        confidence: 0.9,
        importance: 5,
        sourceGithubPrMessageId: sourceId,
      },
    });
    expect(candidate.statusCode, candidate.body).toBe(201);
    const memory = reviewMemorySchema.parse(candidate.json().memory);
    const reviewed = await app.inject({
      method: 'POST',
      url: `/api/v1/review-memories/${memory.id}/review`,
      headers: actor(user),
      payload: { action: 'activate' },
    });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    expect(reviewMemorySchema.parse(reviewed.json().memory).state).toBe('active');
    return memory.id;
  }

  function actor(name: string) {
    return { 'x-test-actor': name };
  }

  function githubMessage(body: string) {
    return {
      githubId: 71,
      kind: 'issue-comment' as const,
      author: 'reviewer',
      authorType: 'User',
      body,
      path: null,
      line: null,
      side: null,
      commitSha: null,
      inReplyToGithubId: null,
      url: 'https://github.example/pull/7#issuecomment-71',
      createdAt: '2026-09-08T01:00:00Z',
      updatedAt: '2026-09-08T01:05:00Z',
    };
  }
});
