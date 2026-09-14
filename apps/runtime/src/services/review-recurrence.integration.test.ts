import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { FilesystemArtifactStore } from '@gcr/artifact-store';
import { analyzeSnapshot, modelReviewFromText } from '@gcr/analysis-engine';
import type { ReviewReport } from '@gcr/review-contract';
import type { GitHubReader, GitHubReviewPublisher } from '@gcr/github';
import Fastify from 'fastify';
import { createServer } from '../../../web/src/review-criteria-test-server.js';
import { chromium } from 'playwright';
import { loadConfig, type AppConfig } from '../config.js';
import { EventHub } from '../events/index.js';
import { AuthorizationService } from './authorization.js';
import { registerAnalysisRoutes } from '../routes/analyses.js';
import { loadReviewRecurrence } from './review-recurrence.js';
import { enqueueReviewPublication, publishReviewToGitHub } from './review-publication.js';

const url = process.env.GCR_TEST_DATABASE_URL;
describe.skipIf(!url).sequential('public review recurrence and managed publication', () => {
  const schema = 'gcr_recurrence_' + randomUUID().replaceAll('-', '');
  let root: Database,
    db: Database,
    store: FilesystemArtifactStore,
    dir: string,
    config: AppConfig,
    repo: string,
    pr: string,
    user: string;
  let previous: ReviewReport, current: ReviewReport, previousLocator: string;
  const persist = async (report: ReviewReport) => {
    const locator = `analyses/${report.analysisRevisionId}/report.v1.json`,
      a = await store.commitText(locator, JSON.stringify(report));
    const artifact = (
      await db.query(
        "insert into artifacts(scope_type,scope_id,artifact_type,version,checksum,byte_size,locator) values('analysis',$1,'report',1,$2,$3,$4) returning id",
        [report.analysisRevisionId, a.checksum, a.byteSize, locator],
      )
    ).rows[0].id;
    await db.query(
      'insert into reports(analysis_run_id,schema_version,grade,summary,has_critical_findings,coverage,impact,artifact_id) values($1,1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)',
      [
        report.analysisRevisionId,
        report.grade,
        report.summary,
        report.hasCriticalFindings,
        JSON.stringify(report.coverage),
        JSON.stringify(report.impact),
        artifact,
      ],
    );
    await db.query("update analysis_runs set state='completed' where id=$1", [
      report.analysisRevisionId,
    ]);
    return locator;
  };
  const create = async (
    head: string,
    line: number,
    extra = false,
    owner: string | null = null,
    pullRequestId = pr,
  ) => {
    const request = (
      await db.query(
        'insert into snapshot_requests(pull_request_id,base_sha,head_sha) values($1,$2,$3) on conflict(pull_request_id,base_sha,head_sha) do update set head_sha=excluded.head_sha returning id',
        [pullRequestId, 'a'.repeat(40), head],
      )
    ).rows[0].id;
    const snapshot = (
      await db.query(
        "insert into snapshots(request_id,version,merge_base_sha,resolution,policy_version) select $1,coalesce(max(version),0)+1,$2,'exact','owned' from snapshots where request_id=$1 returning id",
        [request, 'a'.repeat(40)],
      )
    ).rows[0].id;
    const file = (
      await db.query(
        "insert into snapshot_files(snapshot_id,path,status) values($1,'cache.ts','modified') returning id",
        [snapshot],
      )
    ).rows[0].id;
    const id = (
      await db.query(
        "insert into analysis_runs(snapshot_id,analysis_key,state,memory_owner_user_id) values($1,$2,'queued',$3) returning id",
        [snapshot, randomUUID(), owner],
      )
    ).rows[0].id;
    const patch = `@@ -0,0 +${line},2 @@\n+cache[key];\n+return cached;\n`;
    return (
      await analyzeSnapshot({
        analysisId: id,
        snapshotId: snapshot,
        baseSha: 'a'.repeat(40),
        headSha: head,
        patch,
        files: [
          {
            id: file,
            path: 'cache.ts',
            previousPath: null,
            status: 'modified',
            additions: 2,
            deletions: 0,
            patch,
          },
        ],
        fixtureMode: false,
        model: {
          profile: 'owned-synthetic',
          review: async () =>
            modelReviewFromText(
              JSON.stringify({
                summary: 'Owned review',
                grade: 'adequate',
                file_comments: [
                  {
                    file: 'cache.ts',
                    line,
                    end_line: line,
                    category: 'correctness',
                    priority: 'P2',
                    comment: owner
                      ? 'PRIVATE_CONTEXT_MUST_NOT_LEAK'
                      : 'Cache key needs tenant scope.',
                  },
                  ...(extra
                    ? [
                        {
                          file: 'cache.ts',
                          line: line + 1,
                          end_line: line + 1,
                          category: 'correctness',
                          priority: 'P2',
                          comment:
                            '<script>window.untrustedExecuted=true</script> Previous observation needs review.',
                        },
                      ]
                    : []),
                ],
              }),
              ['cache.ts'],
            ),
        },
      })
    ).report;
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
    dir = await mkdtemp(path.join(tmpdir(), 'gcr-recurrence-'));
    store = new FilesystemArtifactStore(dir);
    config = loadConfig({
      DATABASE_URL: local.toString(),
      AUTH_MODE: 'development',
      GITHUB_MODE: 'disabled',
      ARTIFACT_ROOT: dir,
    });
    const tenant = (
      await db.query(
        "insert into tenants(slug,display_name) values('recurrence','Owned') returning id",
      )
    ).rows[0].id;
    const instance = (
      await db.query(
        "insert into github_instances(name,api_base_url,web_base_url) values('owned','https://example.invalid/api','https://example.invalid') returning id",
      )
    ).rows[0].id;
    user = (
      await db.query(
        "insert into users(oidc_subject,display_name,role) values('owned','Owned','administrator') returning id",
      )
    ).rows[0].id;
    repo = (
      await db.query(
        "insert into repositories(tenant_id,instance_id,github_id,installation_id,owner,name,polling_enabled,review_publishing_enabled) values($1,$2,1,'1','owned','recurrence',false,true) returning id",
        [tenant, instance],
      )
    ).rows[0].id;
    pr = (
      await db.query(
        "insert into pull_requests(repository_id,github_id,number,title,state,author_login,html_url,base_ref,base_sha,head_ref,head_sha,github_updated_at) values($1,1,1,'Owned','open','owned','https://example.invalid/pr/1','main',$2,'branch',$3,clock_timestamp()) returning id",
        [repo, 'a'.repeat(40), 'c'.repeat(40)],
      )
    ).rows[0].id;
    previous = await create('b'.repeat(40), 1, true);
    previous.recurrence = (await loadReviewRecurrence(db, store, previous))!;
    previousLocator = await persist(previous);
    const personal = await create('b'.repeat(40), 2, false, user);
    await persist(personal);
    current = await create('c'.repeat(40), 30);
    current.recurrence = (await loadReviewRecurrence(db, store, current))!;
    await persist(current);
  }, 30000);
  afterAll(async () => {
    await db?.end();
    if (root) {
      await root.query(`drop schema if exists ${schema} cascade`);
      await root.end();
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it('compares persisted public reports across SHAs and line movement, excluding private history', () => {
    expect(previous.recurrence!.status).toBe('no-baseline');
    expect(current.recurrence!.baseline!.analysisId).toBe(previous.analysisRevisionId);
    expect(current.recurrence!.items[0]!.status).toBe('observed-again');
    expect(current.recurrence!.unconfirmedPrevious).toHaveLength(1);
    expect(JSON.stringify(current.recurrence)).not.toContain('PRIVATE_CONTEXT');
    expect(current.findings).toHaveLength(1);
  });
  it('does not compare another PR or private analysis, or publish a private result', async () => {
    const another = (
      await db.query(
        "insert into pull_requests(repository_id,github_id,number,title,state,author_login,html_url,base_ref,base_sha,head_ref,head_sha,github_updated_at) values($1,2,2,'Other owned PR','open','owned','https://example.invalid/pr/2','main',$2,'branch',$3,clock_timestamp()) returning id",
        [repo, 'a'.repeat(40), 'c'.repeat(40)],
      )
    ).rows[0].id;
    const foreign = await create('c'.repeat(40), 30, false, null, another);
    expect((await loadReviewRecurrence(db, store, foreign))!.status).toBe('no-baseline');
    const personal = await create('c'.repeat(40), 30, false, user);
    expect(await loadReviewRecurrence(db, store, personal)).toBeUndefined();
    expect(await enqueueReviewPublication(db, personal.analysisRevisionId, pr, true)).toBe(false);
  });
  it('fails closed on corrupt or unavailable baseline artifacts without falling through to another report', async () => {
    const corrupt = await loadReviewRecurrence(
      db,
      { readText: async () => '{"untrusted":true}' },
      current,
    );
    expect(corrupt!.status).toBe('unavailable');
    await db.query("update artifacts set state='unavailable' where locator=$1", [previousLocator]);
    try {
      expect((await loadReviewRecurrence(db, store, current))!.status).toBe('unavailable');
    } finally {
      await db.query("update artifacts set state='available' where locator=$1", [previousLocator]);
    }
  });
  it('updates one managed comment, preserves published state on retry and refuses an observed stale SHA', async () => {
    const calls: unknown[] = [];
    const publisher = {
      upsertPullRequestComment: vi.fn(async (...args: unknown[]) => {
        calls.push(args);
        return {
          commentId: 42,
          commentUrl: 'https://example.invalid/comment/42',
          outcome: 'updated' as const,
        };
      }),
    } as unknown as GitHubReader & GitHubReviewPublisher;
    const id = current.analysisRevisionId;
    await enqueueReviewPublication(db, id, pr, true);
    await publishReviewToGitHub(
      db,
      publisher,
      config,
      { id: randomUUID(), payload: { analysisId: id, pullRequestId: pr } },
      store,
    );
    expect(JSON.stringify(calls)).toContain('이전 리뷰와 비교');
    expect(JSON.stringify(calls)).not.toContain('<script>');
    await enqueueReviewPublication(db, id, pr, true);
    await publishReviewToGitHub(
      db,
      publisher,
      config,
      { id: randomUUID(), payload: { analysisId: id, pullRequestId: pr } },
      store,
    );
    expect(calls).toHaveLength(1);
    expect(
      (
        await db.query('select state from github_review_publications where pull_request_id=$1', [
          pr,
        ])
      ).rows[0].state,
    ).toBe('published');
    expect(await enqueueReviewPublication(db, previous.analysisRevisionId, pr, true)).toBe(false);
    await publishReviewToGitHub(
      db,
      publisher,
      config,
      { id: randomUUID(), payload: { analysisId: previous.analysisRevisionId, pullRequestId: pr } },
      store,
    );
    expect(calls).toHaveLength(1);
    expect(
      (
        await db.query('select state from github_review_publications where pull_request_id=$1', [
          pr,
        ])
      ).rows[0].state,
    ).toBe('published');
  });
  it('updates the same managed comment for a newer same-SHA run, including sub-millisecond ordering', async () => {
    const retry = await create('c'.repeat(40), 31);
    await db.query(
      "update analysis_runs set created_at='2030-01-01T00:00:00.123001Z' where id=$1",
      [current.analysisRevisionId],
    );
    await db.query(
      "update analysis_runs set created_at='2030-01-01T00:00:00.123002Z' where id=$1",
      [retry.analysisRevisionId],
    );
    retry.recurrence = (await loadReviewRecurrence(db, store, retry))!;
    expect(retry.recurrence.items[0]!.status).toBe('same-head');
    await persist(retry);
    const upsertPullRequestComment = vi.fn(async () => ({
      commentId: 42,
      commentUrl: 'https://example.invalid/comment/42',
      outcome: 'updated' as const,
    }));
    const publisher = { upsertPullRequestComment } as unknown as GitHubReader &
      GitHubReviewPublisher;
    await enqueueReviewPublication(db, retry.analysisRevisionId, pr, true);
    await publishReviewToGitHub(
      db,
      publisher,
      config,
      { id: randomUUID(), payload: { analysisId: retry.analysisRevisionId, pullRequestId: pr } },
      store,
    );
    expect(upsertPullRequestComment).toHaveBeenCalledOnce();
    expect(upsertPullRequestComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ existingCommentId: 42 }),
    );
    await enqueueReviewPublication(db, current.analysisRevisionId, pr, true);
    await publishReviewToGitHub(
      db,
      publisher,
      config,
      { id: randomUUID(), payload: { analysisId: current.analysisRevisionId, pullRequestId: pr } },
      store,
    );
    expect(upsertPullRequestComment).toHaveBeenCalledOnce();
    expect(
      (
        await db.query(
          'select target_analysis_run_id,state from github_review_publications where pull_request_id=$1',
          [pr],
        )
      ).rows[0],
    ).toMatchObject({ target_analysis_run_id: retry.analysisRevisionId, state: 'published' });
  });
  it('serves and renders stored comparison over the real authorized API without executing source titles', async () => {
    const app = Fastify();
    let enabled = true;
    app.addHook('onRequest', async (request) => {
      if (enabled)
        request.user = {
          id: user,
          subject: 'owned',
          displayName: 'Owned',
          role: 'administrator',
          enabled: true,
          tenantIds: [],
          tenants: [],
          groups: [],
        };
    });
    await registerAnalysisRoutes(
      app,
      db,
      new EventHub(db),
      store,
      config,
      new AuthorizationService(config),
    );
    let vite: Awaited<ReturnType<typeof createServer>> | undefined,
      browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      const response = await app.inject(`/api/v1/analyses/${current.analysisRevisionId}`);
      expect(response.statusCode).toBe(200);
      expect(response.json().recurrence).toEqual(current.recurrence);
      enabled = false;
      expect((await app.inject(`/api/v1/analyses/${current.analysisRevisionId}`)).statusCode).toBe(
        401,
      );
      enabled = true;
      await app.listen({ host: '127.0.0.1', port: 0 });
      const api = app.server.address();
      if (!api || typeof api === 'string') throw Error('Owned API required');
      vite = await createServer({
        root: path.resolve('apps/web'),
        server: { host: '127.0.0.1', port: 0, proxy: { '/api': `http://127.0.0.1:${api.port}` } },
        plugins: [
          {
            name: 'owned-recurrence-proof',
            configureServer(server) {
              server.middlewares.use('/__recurrence', async (_request, response) => {
                response.setHeader('content-type', 'text/html');
                response.end(
                  await server.transformIndexHtml(
                    '/__recurrence',
                    `<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="root"></main><script type="module">import React from 'react';import {createRoot} from 'react-dom/client';import {ReviewRecurrence} from '/src/ReviewRecurrence.tsx';import '/src/styles.css';const report=await fetch('/api/v1/analyses/${current.analysisRevisionId}').then(r=>r.json());createRoot(document.getElementById('root')).render(React.createElement(ReviewRecurrence,{value:report.recurrence}));</script></body></html>`,
                  ),
                );
              });
            },
          },
        ],
      });
      await vite.listen();
      const address = vite.httpServer!.address();
      if (!address || typeof address === 'string') throw Error('Owned browser required');
      browser = await chromium.launch({ channel: 'chrome', headless: true });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/__recurrence`);
      await page.getByText('이전 리뷰와 비교 · 재확인 1개', { exact: true }).click();
      await page.getByText('다른 SHA에서 재관측: 1개', { exact: true }).waitFor();
      await page.getByText('재확인하지 못한 이전 지적 · 1개', { exact: true }).click();
      expect(
        await page.evaluate(() =>
          Boolean((window as unknown as Record<string, unknown>).untrustedExecuted),
        ),
      ).toBe(false);
      for (const width of [1360, 420]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        if (process.env.GCR_RECURRENCE_PROOF_DIR) {
          await import('node:fs/promises').then((fs) =>
            fs.mkdir(process.env.GCR_RECURRENCE_PROOF_DIR!, { recursive: true }),
          );
          await page.screenshot({
            path: path.join(process.env.GCR_RECURRENCE_PROOF_DIR, `recurrence-${width}.png`),
            fullPage: true,
          });
        }
      }
    } finally {
      await browser?.close();
      await vite?.close();
      await app.close();
    }
  }, 30_000);
});
