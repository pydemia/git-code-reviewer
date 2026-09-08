import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { reviewMemorySchema } from '@gcr/contracts';
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
