import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { FilesystemArtifactStore } from '@gcr/artifact-store';
import { type ReportObservation, reviewObservationsSchema } from '@gcr/contracts';
import Fastify from 'fastify';
import { chromium } from 'playwright';
import { createServer } from '../../../web/src/review-criteria-test-server.js';
import { loadConfig } from '../config.js';
import { AuthorizationService } from './authorization.js';
import { readReviewObservations } from './review-observations.js';
import { registerReviewObservationsRoutes } from '../routes/review-observations.js';
import { registerKnowledgeRoutes } from '../routes/review-knowledge.js';
import { registerWorklistRoutes } from '../routes/worklist.js';
const url = process.env.GCR_TEST_DATABASE_URL;
const observation = (n: number): ReportObservation => ({
  schemaVersion: 1,
  reviewStatus: 'model',
  durationMs: 1000,
  findings: { P0: 0, P1: 0, P2: n, P3: 0 },
  criteria: { violation: 1, satisfied: 0, uncertain: 1, notReported: 0, unavailable: 1 },
  recurrence: { status: 'compared', repeated: 1, unconfirmedPrevious: 2 },
});
describe.skipIf(!url).sequential('central observations with explicit gaps', () => {
  const schema = 'gcr_observations_' + randomUUID().replaceAll('-', '');
  let root: Database,
    db: Database,
    dir: string,
    repo: string,
    otherRepo: string,
    pr: string,
    pr2: string,
    user: string,
    tenant: string,
    legacy: string,
    latest: string,
    failed: string;
  let config: ReturnType<typeof loadConfig>;
  const createRun = async (
    pull: string,
    o: ReportObservation | null | undefined,
    owner: string | null = null,
    state = 'completed',
    age = 0,
  ) => {
    const sr = (
      await db.query(
        'insert into snapshot_requests(pull_request_id,base_sha,head_sha) values($1,$2,$3) on conflict(pull_request_id,base_sha,head_sha) do update set head_sha=excluded.head_sha returning id',
        [pull, 'a'.repeat(40), 'b'.repeat(40)],
      )
    ).rows[0].id;
    const snapshot = (
      await db.query(
        "insert into snapshots(request_id,version,merge_base_sha,resolution,policy_version) select $1,coalesce(max(version),0)+1,$2,'exact','owned' from snapshots where request_id=$1 returning id",
        [sr, 'a'.repeat(40)],
      )
    ).rows[0].id;
    const id = (
      await db.query(
        "insert into analysis_runs(snapshot_id,analysis_key,state,memory_owner_user_id,created_at) values($1,$2,$3,$4,clock_timestamp()-($5*interval '1 day')) returning id",
        [snapshot, randomUUID(), state, owner, age],
      )
    ).rows[0].id;
    if (o !== undefined) {
      const columns = o === null ? '' : ',observation',
        values = o === null ? '' : ',$2::jsonb';
      await db.query(
        `insert into reports(analysis_run_id,schema_version,grade,summary,has_critical_findings,coverage,impact${columns}) values($1,1,'adequate','Owned',false,'{}','{}'${values})`,
        o === null ? [id] : [id, JSON.stringify(o)],
      );
    }
    return id;
  };
  const createPr = async (repository: string, num: number) =>
    (
      await db.query(
        "insert into pull_requests(repository_id,github_id,number,title,state,author_login,html_url,base_ref,base_sha,head_ref,head_sha,github_updated_at) values($1,$2::bigint,$2::integer,'Owned','open','owned','https://example.invalid/pr','main',$3,'branch',$4,clock_timestamp()) returning id",
        [repository, num, 'a'.repeat(40), 'b'.repeat(40)],
      )
    ).rows[0].id as string;
  beforeAll(async () => {
    const local = new URL(url!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(local.hostname))
      throw Error('Local fixture required');
    root = createDatabase(local.toString());
    await root.query(`create schema ${schema}`);
    local.searchParams.set('options', `-c search_path=${schema}`);
    db = createDatabase(local.toString());
    dir = await mkdtemp(path.join(tmpdir(), 'gcr-observations-'));
    const old = path.join(dir, 'migrations');
    await mkdir(old);
    for (const name of (await readdir('packages/db/migrations')).filter(
      (n) => n.endsWith('.sql') && n < '0051',
    ))
      await copyFile(path.join('packages/db/migrations', name), path.join(old, name));
    await runMigrations(db, old);
    config = loadConfig({
      DATABASE_URL: local.toString(),
      AUTH_MODE: 'development',
      GITHUB_MODE: 'disabled',
      ARTIFACT_ROOT: path.join(dir, 'artifacts'),
    });
    tenant = (
      await db.query(
        "insert into tenants(slug,display_name) values('observations','Owned') returning id",
      )
    ).rows[0].id;
    const instance = (
      await db.query(
        "insert into github_instances(name,api_base_url,web_base_url) values('Owned','https://example.invalid/api','https://example.invalid') returning id",
      )
    ).rows[0].id;
    user = (
      await db.query(
        "insert into users(oidc_subject,display_name,role) values('owned','Owned','reviewer') returning id",
      )
    ).rows[0].id;
    await db.query('insert into tenant_memberships(tenant_id,user_id) values($1,$2)', [
      tenant,
      user,
    ]);
    for (const name of ['observations', 'other']) {
      const id = (
        await db.query(
          "insert into repositories(tenant_id,instance_id,github_id,installation_id,owner,name,polling_enabled) values($1,$2,$3,'1','owned',$4,false) returning id",
          [tenant, instance, name === 'observations' ? 1 : 2, name],
        )
      ).rows[0].id;
      if (name === 'observations') repo = id;
      else otherRepo = id;
    }
    await db.query(
      "insert into repository_grants(repository_id,subject_or_group,role) values($1,'owned','reviewer')",
      [repo],
    );
    pr = await createPr(repo, 1);
    legacy = await createRun(pr, null, null, 'completed', 2);
    const before = (
      await db.query('select version,checksum from schema_migrations order by version')
    ).rows;
    await runMigrations(db, path.resolve('packages/db/migrations'));
    expect(before).toHaveLength(50);
    expect(
      (await db.query('select version,checksum from schema_migrations order by version limit 50'))
        .rows,
    ).toEqual(before);
    expect(
      (await db.query('select observation from reports where analysis_run_id=$1', [legacy])).rows[0]
        .observation,
    ).toBeNull();
    latest = await createRun(pr, observation(2));
    await createRun(pr, observation(999), user);
    pr2 = await createPr(repo, 2);
    await createRun(pr2, observation(4));
    failed = await createRun(pr2, undefined, null, 'failed');
    const legacyPr = await createPr(repo, 3);
    await createRun(legacyPr, null);
    await createRun(await createPr(otherRepo, 4), observation(999));
    await createRun(await createPr(repo, 5), observation(999), null, 'completed', 91);
    await db.query("insert into model_account_capacity(quota_key) values('owned-private-key')");
    for (const [id, state, bytes] of [
      [legacy, 'completed', 10],
      [latest, 'completed', 20],
      [latest, 'interrupted', 30],
      [failed, 'reserved', 40],
    ] as const)
      await db.query(
        'insert into model_request_ledger(quota_key,run_key,state,input_bytes) values($1,$2,$3,$4)',
        ['owned-private-key', 'analysis:' + id, state, bytes],
      );
    await db.query("select request_review_knowledge($1,'policy',null,'owned')", [repo]);
    await db.query("select request_review_knowledge($1,'personal',$2,'owned')", [repo, user]);
  }, 30000);
  afterAll(async () => {
    await db?.end();
    if (root) {
      await root.query(`drop schema if exists ${schema} cascade`);
      await root.end();
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it('separates latest PR outcomes, retries, personal runs and missing observations', async () => {
    const result = await readReviewObservations(db, repo, 30);
    expect(result.window.includedRuns).toBe(5);
    expect(result.pulls.included).toBe(3);
    expect(result.pulls.states).toEqual({ completed: 2, failed: 1 });
    expect(result.pulls.recordedReports).toBe(1);
    expect(result.pulls.unrecordedReports).toBe(1);
    expect(result.pulls.findings.P2).toBe(2);
    expect(result.effort.totalReportedDurationMs).toBe(2000);
    expect(result.effort.ledgerAttempts).toBe(4);
    expect(result.effort.runsWithLedger).toBe(3);
    expect(result.effort.inputBytes).toBe(100);
    expect(result.effort.billedCost).toBeNull();
    expect(result.quality.falsePositiveRate).toBeNull();
    expect(result.local).toEqual({ execution: 'unknown', applied: 'unknown' });
    expect(result.publication.map((p) => p.component)).toEqual(['collective', 'policy']);
    expect(JSON.stringify(result)).not.toMatch(/owned-private-key|analysis:/);
  });
  it('excludes fixture findings and durations while preserving their explicit count', async () => {
    const pull = await createPr(repo, 6);
    await createRun(pull, { ...observation(999), reviewStatus: 'fixture' });
    try {
      const result = await readReviewObservations(db, repo, 30);
      expect(result.pulls.fixtureReports).toBe(1);
      expect(result.pulls.findings.P2).toBe(2);
      expect(result.effort.fixtureDurations).toBe(1);
      expect(result.effort.totalReportedDurationMs).toBe(2000);
    } finally {
      await db.query('delete from pull_requests where id=$1', [pull]);
    }
  });
  it('treats malformed observations as unrecorded and checks the last observed head', async () => {
    await db.query("update reports set observation='{}' where analysis_run_id=$1", [latest]);
    await db.query('update pull_requests set head_sha=$2 where id=$1', [pr, 'c'.repeat(40)]);
    try {
      const result = await readReviewObservations(db, repo, 7);
      expect(result.pulls.unrecordedReports).toBe(2);
      expect(result.pulls.latestAtOtherHead).toBe(1);
      expect(result.pulls.findings.P2).toBe(0);
    } finally {
      await db.query('update reports set observation=$2::jsonb where analysis_run_id=$1', [
        latest,
        JSON.stringify(observation(2)),
      ]);
      await db.query('update pull_requests set head_sha=$2 where id=$1', [pr, 'b'.repeat(40)]);
    }
  });
  it('bounds the run sample without presenting truncated data as a repository total', async () => {
    const snapshot = (await db.query('select snapshot_id from analysis_runs where id=$1', [latest]))
      .rows[0].snapshot_id;
    await db.query(
      "insert into analysis_runs(snapshot_id,analysis_key,state) select $1,'owned-cap:'||n,'queued' from generate_series(1,2001) n",
      [snapshot],
    );
    try {
      const result = await readReviewObservations(db, repo, 30);
      expect(result.window.truncated).toBe(true);
      expect(result.window.includedRuns).toBe(2000);
      expect(result.pulls.included).toBe(1);
      expect(result.effort.runsWithoutLedger).toBe(2000);
    } finally {
      await db.query("delete from analysis_runs where analysis_key like 'owned-cap:%'");
    }
  });
  const app = () => {
    const server = Fastify();
    let enabled = true;
    server.addHook('onRequest', async (request) => {
      if (enabled)
        request.user = {
          id: user,
          subject: 'owned',
          displayName: 'Owned',
          role: 'reviewer',
          enabled: true,
          tenantIds: [tenant],
          tenants: [{ id: tenant, slug: 'observations', displayName: 'Owned' }],
          groups: [],
        };
    });
    server.setErrorHandler((e, _r, reply) =>
      reply
        .code((e as { statusCode?: number }).statusCode ?? 400)
        .send({ error: { message: 'Owned error' } }),
    );
    return {
      server,
      setEnabled: (value: boolean) => {
        enabled = value;
      },
    };
  };
  it('authorizes metrics, records eligible GET errors, and does not count denied requests', async () => {
    const { server, setEnabled } = app();
    const auth = new AuthorizationService(config);
    await registerReviewObservationsRoutes(server, db, auth);
    await registerKnowledgeRoutes(
      server,
      db,
      auth,
      new FilesystemArtifactStore(config.ARTIFACT_ROOT),
    );
    const route = `/api/v1/repositories/${repo}/review-observations`;
    try {
      expect((await server.inject(route + '?days=31')).statusCode).toBe(400);
      expect(
        (await server.inject(`/api/v1/repositories/${otherRepo}/review-observations`)).statusCode,
      ).toBe(404);
      const result = await server.inject(route);
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('private, no-store');
      reviewObservationsSchema.parse(result.json());
      expect(
        (
          await server.inject(
            `/api/v1/repositories/${repo}/review-knowledge/manifest?clientContractVersion=3`,
          )
        ).statusCode,
      ).toBe(503);
      setEnabled(false);
      expect((await server.inject(route)).statusCode).toBe(401);
      expect(
        (
          await server.inject(
            `/api/v1/repositories/${repo}/review-knowledge/manifest?clientContractVersion=3`,
          )
        ).statusCode,
      ).toBe(401);
      await server.close();
      const observed = await readReviewObservations(db, repo, 30);
      expect(observed.downloads.responses).toMatchObject([
        { route: 'manifest', status: 503, count: 1 },
      ]);
      expect(observed.downloads.since).not.toBeNull();
    } finally {
      await server.close();
    }
  });
  it('shows the full page with real API, repository switching and observation gaps at desktop/mobile sizes', async () => {
    await db.query(
      "insert into repository_grants(repository_id,subject_or_group,role) values($1,'owned','reviewer')",
      [otherRepo],
    );
    const { server } = app();
    const auth = new AuthorizationService(config);
    await registerReviewObservationsRoutes(server, db, auth);
    await registerWorklistRoutes(server, db, auth, config);
    let vite: Awaited<ReturnType<typeof createServer>> | undefined,
      browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await server.listen({ host: '127.0.0.1', port: 0 });
      const api = server.server.address();
      if (!api || typeof api === 'string') throw Error('Owned API required');
      vite = await createServer({
        root: path.resolve('apps/web'),
        server: { host: '127.0.0.1', port: 0, proxy: { '/api': `http://127.0.0.1:${api.port}` } },
        plugins: [
          {
            name: 'owned-observations',
            configureServer(s) {
              s.middlewares.use('/__observations', async (_req, res) => {
                res.setHeader('content-type', 'text/html');
                res.end(
                  await s.transformIndexHtml(
                    '/__observations',
                    `<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import React from 'react';import {createRoot} from 'react-dom/client';import {ReviewObservationsPage} from '/src/ReviewObservationsPage.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(ReviewObservationsPage));</script></body></html>`,
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
      page.setDefaultTimeout(8000);
      page.on('pageerror', (error) => console.error('Browser error:', error.message));
      await page.goto(`http://127.0.0.1:${address.port}/__observations`);
      await page
        .getByText('실제 오탐률과 사고 감소율은 확인되지 않았습니다.')
        .waitFor()
        .catch(async (error) => {
          console.error(await page.locator('body').innerText());
          throw error;
        });
      await page.getByRole('combobox', { name: '조회 기간', exact: true }).selectOption('7');
      await page.getByText('실제 오탐률과 사고 감소율은 확인되지 않았습니다.').waitFor();
      await page
        .getByRole('combobox', { name: '조회 저장소', exact: true })
        .selectOption(otherRepo);
      await page.getByText(/P2·P3 지적 999개/).waitFor();
      await page.getByRole('combobox', { name: '조회 저장소', exact: true }).selectOption(repo);
      await page.getByText(/P2·P3 지적 2개/).waitFor();
      await page.getByRole('button', { name: '새로고침' }).click();
      await page.getByText('실제 오탐률과 사고 감소율은 확인되지 않았습니다.').waitFor();
      for (const width of [1360, 420]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.locator('main').evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        const end = await page.getByText(/로컬 실행 여부: 알 수 없음/).boundingBox();
        expect(end && end.y >= 0 && end.y + end.height <= 900).toBeTruthy();
        if (process.env.GCR_OBSERVATIONS_PROOF_DIR) {
          await page.screenshot({
            path: path.join(
              process.env.GCR_OBSERVATIONS_PROOF_DIR,
              `observations-${width}-bottom.png`,
            ),
          });
        }
        await page.locator('main').evaluate((el) => {
          el.scrollTop = 0;
        });
        if (process.env.GCR_OBSERVATIONS_PROOF_DIR) {
          await mkdir(process.env.GCR_OBSERVATIONS_PROOF_DIR, { recursive: true });
          await page.screenshot({
            path: path.join(process.env.GCR_OBSERVATIONS_PROOF_DIR, `observations-${width}.png`),
            fullPage: true,
          });
        }
      }
    } finally {
      await browser?.close();
      await vite?.close();
      await server.close();
    }
  }, 30000);
});
