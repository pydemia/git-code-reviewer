import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { type PullRequestObservation, type GitHubReader } from '@gcr/github';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { type AuthUser } from '../auth/index.js';
import { AuthorizationService } from '../services/authorization.js';
import { ensureFixtureRepository, pollRepository } from '../services/repositories.js';
import { registerWorklistRoutes } from './worklist.js';

const databaseUrl = process.env.GCR_TEST_DATABASE_URL;
describe
  .skipIf(!databaseUrl)
  .sequential('PR lifecycle synchronization and worklist filters', () => {
    const schema = `gcr_test_${randomUUID().replaceAll('-', '')}`;
    let root: Database;
    let db: Database;
    let app: FastifyInstance;
    let repositoryId: string;
    let admin: AuthUser;
    let pulls: PullRequestObservation[] = [];
    const messages: number[] = [];
    const reader: GitHubReader = {
      listPulls: async () => ({ outcome: 'updated', etag: 'all-pulls', pulls }),
      listPullRequestMessages: async (_target, number) => {
        messages.push(number);
        return [];
      },
    };
    const pull = (
      number: number,
      state: 'open' | 'closed',
      mergedAt: string | null = null,
    ): PullRequestObservation => ({
      githubId: number,
      number,
      title: `Synthetic ${number}`,
      state,
      mergedAt,
      draft: false,
      author: 'synthetic',
      url: `https://github.example/org-name/repo-name/pull/${number}`,
      baseRef: 'main',
      baseSha: 'a'.repeat(40),
      headRef: 'branch',
      headSha: 'b'.repeat(40),
      updatedAt: '2026-09-09T01:00:00Z',
    });
    beforeAll(async () => {
      const url = new URL(databaseUrl!);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new Error('Use a local test database');
      root = createDatabase(url.toString());
      await root.query(`create schema ${schema}`);
      url.searchParams.set('options', `-c search_path=${schema}`);
      db = createDatabase(url.toString());
      await runMigrations(db, path.resolve('packages/db/migrations'));
      repositoryId = (await ensureFixtureRepository(db))!;
      const tenantId = (
        await db.query('select tenant_id from repositories where id=$1', [repositoryId])
      ).rows[0].tenant_id;
      const user = (
        await db.query(
          "insert into users(oidc_subject,display_name,role) values('synthetic-admin','검증 관리자','administrator') returning id",
        )
      ).rows[0];
      admin = {
        id: user.id,
        subject: 'synthetic-admin',
        displayName: '검증 관리자',
        role: 'administrator',
        enabled: true,
        groups: [],
        tenantIds: [tenantId],
        tenants: [],
      };
      const config = loadConfig({
        DATABASE_URL: 'postgresql://localhost/unused',
        AUTH_MODE: 'development',
        GITHUB_MODE: 'fixture',
      });
      app = Fastify();
      app.addHook('onRequest', async (request) => {
        request.user = request.headers['x-denied']
          ? { ...admin, role: 'reviewer', subject: 'not-granted', tenantIds: [] }
          : admin;
      });
      await registerWorklistRoutes(app, db, new AuthorizationService(config), config);
    });
    afterAll(async () => {
      await app?.close();
      await db?.end();
      if (root) {
        await root.query(`drop schema if exists ${schema} cascade`);
        await root.end();
      }
    });

    it('backfills Closed/Merged metadata without scheduling historical reviews', async () => {
      pulls = [pull(1, 'open'), pull(2, 'closed'), pull(3, 'closed', '2026-09-09T00:00:00Z')];
      await pollRepository(db, reader, repositoryId);
      expect(
        (await db.query('select count(*)::int as count from pull_requests')).rows[0].count,
      ).toBe(3);
      expect((await db.query('select count(*)::int as count from jobs')).rows[0].count).toBe(1);
      expect(messages).toEqual([1]);
      const list = await app.inject({
        url: `/api/v1/repositories/${repositoryId}/pulls?state=closed`,
      });
      expect(list.statusCode).toBe(200);
      expect(
        list
          .json()
          .items.map((p: { number: number }) => p.number)
          .sort(),
      ).toEqual([2, 3]);
      expect(list.json().items.find((p: { number: number }) => p.number === 3).mergedAt).toBe(
        '2026-09-09T00:00:00.000Z',
      );
      expect(list.json().counts).toEqual({ open: 1, closed: 2, all: 3 });
      expect(
        (await app.inject({ url: `/api/v1/repositories/${repositoryId}/pulls` })).json().items,
      ).toHaveLength(1);
    });

    it('handles closed, merged and reopened observations without replacing review jobs', async () => {
      const before = (await db.query('select id from jobs order by id')).rows;
      pulls = [
        pull(1, 'closed', '2026-09-09T02:00:00Z'),
        pull(2, 'open'),
        pull(3, 'closed', '2026-09-09T00:00:00Z'),
      ];
      await pollRepository(db, reader, repositoryId);
      const afterReopen = (await db.query('select id from jobs order by id')).rows;
      expect(afterReopen).toHaveLength(before.length + 1);
      expect(afterReopen).toEqual(expect.arrayContaining(before));
      expect(
        (await app.inject({ url: `/api/v1/repositories/${repositoryId}/pulls?state=open` }))
          .json()
          .items.map((p: { number: number }) => p.number),
      ).toEqual([2]);
      pulls = [pull(1, 'open'), pull(2, 'closed'), pull(3, 'closed', '2026-09-09T00:00:00Z')];
      await pollRepository(db, reader, repositoryId);
      const detail = await app.inject({ url: `/api/v1/repositories/${repositoryId}/pulls/1` });
      expect(detail.json()).toMatchObject({ state: 'open', mergedAt: null });
      // 기존 snapshot이 있는 PR은 같은 SHA로 reopen되어도 중복 분석하지 않는다.
      expect((await db.query('select id from jobs order by id')).rows).toEqual(afterReopen);
    });

    it('does not infer closure from absence, 304 or an upstream error', async () => {
      pulls = [];
      await pollRepository(db, reader, repositoryId);
      expect((await db.query('select state from pull_requests where number=1')).rows[0].state).toBe(
        'open',
      );
      await pollRepository(
        db,
        { listPulls: async () => ({ outcome: 'not-modified', etag: 'all-pulls', pulls: [] }) },
        repositoryId,
      );
      await expect(
        pollRepository(
          db,
          {
            listPulls: async () => {
              throw new Error('upstream failed');
            },
          },
          repositoryId,
        ),
      ).rejects.toThrow('upstream failed');
      expect((await db.query('select state from pull_requests where number=1')).rows[0].state).toBe(
        'open',
      );
      expect(
        (
          await db.query('select etag,last_outcome from poll_states where repository_id=$1', [
            repositoryId,
          ])
        ).rows[0],
      ).toEqual({ etag: 'all-pulls', last_outcome: 'failed' });
    });

    it('paginates every filtered row with stable tie ordering and full counts', async () => {
      pulls = Array.from({ length: 205 }, (_, i) =>
        pull(i + 10, 'closed', i % 2 ? '2026-09-09T00:00:00Z' : null),
      );
      await pollRepository(db, reader, repositoryId);
      const seen = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      do {
        const response = await app.inject({
          url: `/api/v1/repositories/${repositoryId}/pulls?state=closed${cursor ? `&cursor=${cursor}` : ''}`,
        });
        expect(response.statusCode, response.body).toBe(200);
        const body = response.json();
        expect(body.counts).toEqual({ open: 1, closed: 207, all: 208 });
        for (const row of body.items) {
          expect(seen.has(row.id)).toBe(false);
          seen.add(row.id);
          expect(row.state).toBe('closed');
        }
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor);
      expect(seen.size).toBe(207);
      expect(pages).toBe(3);
      expect(
        (await app.inject({ url: `/api/v1/repositories/${repositoryId}/pulls?state=all` })).json()
          .counts.all,
      ).toBe(208);
      expect((await db.query('select count(*)::int as count from jobs')).rows[0].count).toBe(2);
    });

    it('validates filter/cursor and protects repository scope for every filter', async () => {
      for (const state of ['open', 'closed', 'all'])
        expect(
          (
            await app.inject({
              url: `/api/v1/repositories/${repositoryId}/pulls?state=${state}`,
              headers: { 'x-denied': 'yes' },
            })
          ).statusCode,
        ).toBe(404);
      // Fastify's production error handler maps Zod errors to 400; this harness checks rejection.
      for (const query of ['state=merged', 'cursor=-1', 'cursor=no', 'cursor=999999999999999999']) {
        const response = await app.inject({
          url: `/api/v1/repositories/${repositoryId}/pulls?${query}`,
        });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(response.json().items).toBeUndefined();
      }
    });
    it('refreshes due conversations on 304 and retries a failed final closed-PR collection', async () => {
      let metadata = true,
        fail = true;
      const seen: number[] = [];
      const isolated: GitHubReader = {
        listPulls: async () =>
          metadata
            ? {
                outcome: 'updated',
                etag: 'new-metadata',
                pulls: [pull(901, 'open'), pull(902, 'open')],
              }
            : { outcome: 'not-modified', etag: 'new-metadata', pulls: [] },
        listPullRequestMessages: async (_target, number) => {
          seen.push(number);
          if (number === 901 && fail) throw Error('transient source failure');
          return [];
        },
      };
      await pollRepository(db, isolated, repositoryId);
      const state = async (number: number) =>
        (
          await db.query(
            'select s.* from pull_request_conversation_sync s join pull_requests p on p.id=s.pull_request_id where p.repository_id=$1 and p.number=$2',
            [repositoryId, number],
          )
        ).rows[0];
      expect((await state(901)).consecutive_failures).toBe(1);
      expect((await state(902)).last_success_at).not.toBeNull();
      expect(
        (await db.query('select etag from poll_states where repository_id=$1', [repositoryId]))
          .rows[0].etag,
      ).toBe('new-metadata');
      const closed: GitHubReader = {
        ...isolated,
        listPulls: async () => ({
          outcome: 'updated',
          etag: 'closed-metadata',
          pulls: [pull(901, 'closed')],
        }),
      };
      await pollRepository(db, closed, repositoryId);
      expect((await state(901)).follow_until).not.toBeNull();
      expect((await state(901)).last_success_at).toBeNull();
      metadata = false;
      fail = false;
      await db.query(
        "update pull_request_conversation_sync set next_attempt_at='-infinity' where pull_request_id in (select id from pull_requests where repository_id=$1 and number in (901,902))",
        [repositoryId],
      );
      const before = seen.length;
      await pollRepository(db, isolated, repositoryId);
      expect(seen.slice(before)).toEqual(expect.arrayContaining([901, 902]));
      expect((await state(901)).last_success_at).not.toBeNull();
      expect((await state(901)).consecutive_failures).toBe(0);
      // Ended monitoring must not become an unbounded historical backfill.
      await db.query(
        "update pull_request_conversation_sync set follow_until=clock_timestamp()-interval '1 second',next_attempt_at='-infinity' where pull_request_id=(select id from pull_requests where repository_id=$1 and number=901)",
        [repositoryId],
      );
      const done = seen.length;
      await pollRepository(db, isolated, repositoryId);
      expect(seen.slice(done)).not.toContain(901);
    });

    it('bounds each batch and rotates pending PRs without scheduling closed historical reviews', async () => {
      const seen: number[] = [];
      const batch: GitHubReader = {
        listPulls: async () => ({
          outcome: 'updated',
          etag: 'batch',
          pulls: Array.from({ length: 23 }, (_, i) => pull(1000 + i, 'open')),
        }),
        listPullRequestMessages: async (_t, n) => {
          seen.push(n);
          return [];
        },
      };
      // Previously due fixtures do not consume this batch's budget.
      await db.query("update pull_request_conversation_sync set next_attempt_at='infinity'");
      await pollRepository(db, batch, repositoryId);
      expect(seen).toHaveLength(10);
      const unchanged: GitHubReader = {
        ...batch,
        listPulls: async () => ({ outcome: 'not-modified', etag: 'batch', pulls: [] }),
      };
      await pollRepository(db, unchanged, repositoryId);
      expect(seen).toHaveLength(20);
      await pollRepository(db, unchanged, repositoryId);
      expect(seen).toHaveLength(23);
      expect(new Set(seen).size).toBe(23);
      expect(
        (
          await db.query(
            'select count(*)::int as n from pull_request_conversation_sync s join pull_requests p on p.id=s.pull_request_id where p.number between 10 and 214',
          )
        ).rows[0].n,
      ).toBe(0);
    });

    it('uses per-PR claims across concurrent pollers and recovers an expired claim', async () => {
      await db.query("update pull_request_conversation_sync set next_attempt_at='infinity'");
      await pollRepository(
        db,
        {
          listPulls: async () => ({
            outcome: 'updated',
            etag: 'lease',
            pulls: [pull(1200, 'open')],
          }),
        },
        repositoryId,
      );
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      let calls = 0;
      const leased: GitHubReader = {
        listPulls: async () => ({ outcome: 'not-modified', etag: 'lease', pulls: [] }),
        listPullRequestMessages: async () => {
          calls++;
          started();
          await held;
          return [];
        },
      };
      const first = pollRepository(db, leased, repositoryId);
      await entered;
      await pollRepository(db, leased, repositoryId);
      expect(calls).toBe(1);
      release();
      await first;
      await db.query(
        "update pull_request_conversation_sync set next_attempt_at='-infinity',claim_token=gen_random_uuid(),claim_until=clock_timestamp()-interval '1 second' where pull_request_id=(select id from pull_requests where repository_id=$1 and number=1200)",
        [repositoryId],
      );
      await pollRepository(db, leased, repositoryId);
      expect(calls).toBe(2);
    });
    it('does not let an expired owner acknowledge success after a newer retry failed', async () => {
      await db.query("update pull_request_conversation_sync set next_attempt_at='infinity'");
      await pollRepository(
        db,
        {
          listPulls: async () => ({
            outcome: 'updated',
            etag: 'obsolete',
            pulls: [pull(1201, 'open')],
          }),
        },
        repositoryId,
      );
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const metadata: GitHubReader['listPulls'] = async () => ({
        outcome: 'not-modified',
        etag: 'obsolete',
        pulls: [],
      });
      const first = pollRepository(
        db,
        {
          listPulls: metadata,
          listPullRequestMessages: async () => {
            entered();
            await held;
            return [];
          },
        },
        repositoryId,
      );
      await started;
      await db.query(
        "update pull_request_conversation_sync set claim_until=clock_timestamp()-interval '1 second' where pull_request_id=(select id from pull_requests where repository_id=$1 and number=1201)",
        [repositoryId],
      );
      await pollRepository(
        db,
        {
          listPulls: metadata,
          listPullRequestMessages: async () => {
            throw Error('new owner failed');
          },
        },
        repositoryId,
      );
      release();
      await first;
      const row = (
        await db.query(
          'select s.* from pull_request_conversation_sync s join pull_requests p on p.id=s.pull_request_id where p.repository_id=$1 and p.number=1201',
          [repositoryId],
        )
      ).rows[0];
      expect(row.last_success_at).toBeNull();
      expect(row.consecutive_failures).toBe(1);
      expect(row.last_error_code).toBe('CONVERSATION_READ_FAILED');
    });
  });
