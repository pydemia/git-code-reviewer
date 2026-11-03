import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { FilesystemArtifactStore } from '@gcr/artifact-store';
import { canonicalKnowledgeJson } from '@gcr/client-contract';
import { analyzeSnapshot } from '@gcr/analysis-engine';
import { loadConfig, type AppConfig } from '../config.js';
import { EventHub } from '../events/index.js';
import { AuthorizationService } from './authorization.js';
import { registerAnalysisRoutes } from '../routes/analyses.js';
import {
  selectPinnedSharedKnowledge,
  type SharedKnowledgePin,
} from './analysis-shared-knowledge.js';
import * as service from './trusted-ci.js';
import { input, policy, payload, signed, check, run } from '../../test/trusted-ci-fixtures.js';

const url = process.env.GCR_TEST_DATABASE_URL;
const hash = (value: unknown) =>
  createHash('sha256').update(canonicalKnowledgeJson(value)).digest('hex');
describe.skipIf(!url).sequential('persisted CI identity and authorization', () => {
  const schema = 'gcr_ci_' + randomUUID().replaceAll('-', '');
  let root: Database, db: Database, store: FilesystemArtifactStore, dir: string, config: AppConfig;
  let repo: string, tenant: string, pull: string, user: string, analysis: string, locator: string;
  let before: unknown[], legacy: string;
  const create = async (
    owner: string | null = null,
    sourceTrees: unknown = {
      base: input.source.baseTree,
      head: input.source.headTree,
      mergeBase: input.source.mergeBaseTree,
    },
  ) => {
    const request = (
      await db.query(
        'insert into snapshot_requests(pull_request_id,base_sha,head_sha) values($1,$2,$3) on conflict(pull_request_id,base_sha,head_sha) do update set head_sha=excluded.head_sha returning id',
        [pull, input.source.baseCommit, input.source.headCommit],
      )
    ).rows[0].id;
    const snapshot = (
      await db.query(
        "insert into snapshots(request_id,version,merge_base_sha,resolution,policy_version,source_trees) select $1,coalesce(max(version),0)+1,$2,'exact','owned',$3::jsonb from snapshots where request_id=$1 returning id",
        [request, input.source.mergeBaseCommit, JSON.stringify(sourceTrees)],
      )
    ).rows[0].id;
    const common = {
      schemaVersion: 2 as const,
      tenantId: tenant,
      repositoryId: repo,
      ownerUserId: null,
    };
    const bundles = {
      policy: {
        ...common,
        component: 'policy',
        criteria: [],
        skills: {
          schemaVersion: 1,
          hash: hash('skills'),
          skills: Array.from({ length: 4 }, (_, i) => ({
            name: `skill-${i}`,
            title: 'Owned review',
            kind: 'perspective',
            unit: 'file',
            version: 1,
            enabled: true,
            instructions: 'Review the captured source.',
            markdown: '# Owned review',
            contentHash: hash(`skill-${i}`),
          })),
        },
      },
      collective: { ...common, component: 'collective', memories: [] },
    };
    const pin: SharedKnowledgePin = {
      schemaVersion: 1,
      tenantId: tenant,
      repositoryId: repo,
      branch: 'branch',
      status: 'ready',
      reason: '',
      bundles,
      releases: (['policy', 'collective'] as const).map((component) => ({
        component,
        id: randomUUID(),
        sequence: 1,
        hash: hash(bundles[component]),
      })),
    };
    const context = {
      pinHash: hash(pin),
      selectedAt: new Date().toISOString(),
      sources: [],
      selection: selectPinnedSharedKnowledge(pin, [], new Date().toISOString()),
    };
    const id = (
      await db.query(
        "insert into analysis_runs(snapshot_id,analysis_key,state,memory_owner_user_id,shared_knowledge,shared_knowledge_hash) values($1,$2,'queued',$3,$4::jsonb,$5) returning id",
        [snapshot, randomUUID(), owner, JSON.stringify(pin), hash(pin)],
      )
    ).rows[0].id;
    await db.query(
      'insert into analysis_shared_selections(analysis_id,context,context_hash) values($1,$2::jsonb,$3)',
      [id, JSON.stringify(context), hash(context)],
    );
    const report = (
      await analyzeSnapshot({
        analysisId: id,
        snapshotId: snapshot,
        baseSha: input.source.baseCommit,
        headSha: input.source.headCommit,
        files: [],
        patch: '',
        fixtureMode: false,
      })
    ).report;
    report.versions = { review: 'owned-ci-fixture', model: 'owned-ci-test-model' };
    const location = `analyses/${id}/report.v1.json`,
      artifact = await store.commitText(location, JSON.stringify(report));
    const artifactId = (
      await db.query(
        "insert into artifacts(scope_type,scope_id,artifact_type,version,checksum,byte_size,locator) values('analysis',$1,'report',1,$2,$3,$4) returning id",
        [id, artifact.checksum, artifact.byteSize, location],
      )
    ).rows[0].id;
    await db.query(
      'insert into reports(analysis_run_id,schema_version,grade,summary,has_critical_findings,coverage,impact,artifact_id) values($1,1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)',
      [
        id,
        report.grade,
        report.summary,
        report.hasCriticalFindings,
        JSON.stringify(report.coverage),
        JSON.stringify(report.impact),
        artifactId,
      ],
    );
    await db.query("update analysis_runs set state='completed' where id=$1", [id]);
    return { id, location, snapshot };
  };
  beforeAll(async () => {
    const local = new URL(url!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname))
      throw Error('Owned loopback database required');
    root = createDatabase(local.toString());
    await root.query(`create schema ${schema}`);
    local.searchParams.set('options', `-c search_path=${schema}`);
    db = createDatabase(local.toString());
    dir = await mkdtemp(path.join(tmpdir(), 'gcr-ci-'));
    store = new FilesystemArtifactStore(path.join(dir, 'artifacts'));
    const migrations = path.resolve('packages/db/migrations'),
      prior = path.join(dir, 'prior');
    await mkdir(prior);
    for (const file of (await readdir(migrations)).filter((f) => f.endsWith('.sql') && f < '0052'))
      await copyFile(path.join(migrations, file), path.join(prior, file));
    await runMigrations(db, prior);
    before = (await db.query('select * from schema_migrations order by version')).rows;
    expect(before).toHaveLength(51);
    tenant = (
      await db.query(
        "insert into tenants(slug,display_name) values('owned-ci','Owned CI') returning id",
      )
    ).rows[0].id;
    const instance = (
      await db.query(
        "insert into github_instances(name,api_base_url,web_base_url) values('owned-ci',$1,'https://github.example') returning id",
        [input.apiBaseUrl],
      )
    ).rows[0].id;
    user = (
      await db.query(
        "insert into users(oidc_subject,display_name,role) values('owned-ci','Owned CI','administrator') returning id",
      )
    ).rows[0].id;
    repo = (
      await db.query(
        "insert into repositories(tenant_id,instance_id,github_id,installation_id,owner,name,polling_enabled) values($1,$2,42,'1','team','repo',false) returning id",
        [tenant, instance],
      )
    ).rows[0].id;
    pull = (
      await db.query(
        "insert into pull_requests(repository_id,github_id,number,title,state,author_login,html_url,base_ref,base_sha,head_ref,head_sha,github_updated_at) values($1,7,7,'Owned','open','owned','https://github.example/pr/7','main',$2,'branch',$3,clock_timestamp()) returning id",
        [repo, input.source.baseCommit, input.source.headCommit],
      )
    ).rows[0].id;
    const oldRequest = (
      await db.query(
        'insert into snapshot_requests(pull_request_id,base_sha,head_sha) values($1,$2,$3) returning id',
        [pull, input.source.baseCommit, '9'.repeat(40)],
      )
    ).rows[0].id;
    legacy = (
      await db.query(
        "insert into snapshots(request_id,version,resolution,policy_version) values($1,1,'unresolved','owned-legacy') returning id",
        [oldRequest],
      )
    ).rows[0].id;
    await runMigrations(db, migrations);
    config = loadConfig({
      DATABASE_URL: local.toString(),
      AUTH_MODE: 'development',
      GITHUB_MODE: 'disabled',
      TRUSTED_CI_POLICIES: JSON.stringify([policy]),
    });
    const current = await create();
    analysis = current.id;
    locator = current.location;
  }, 30000);
  afterAll(async () => {
    await db?.end();
    if (root) {
      await root.query(`drop schema if exists ${schema} cascade`);
      await root.end();
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it('upgrades 51 to 52 without changing history or inventing legacy source trees', async () => {
    expect(
      (await db.query("select * from schema_migrations where version < '0052' order by version"))
        .rows,
    ).toEqual(before);
    expect((await db.query('select count(*)::int as n from schema_migrations')).rows[0].n).toBe(52);
    expect(
      (await db.query('select source_trees,policy_version from snapshots where id=$1', [legacy]))
        .rows[0],
    ).toEqual({ source_trees: null, policy_version: 'owned-legacy' });
  });
  it('derives expected identity from persisted report and trees, then verifies a matching signed read', async () => {
    const reader = {
      listValidationChecks: vi.fn(async () => []),
      readValidationRun: vi.fn(async () => run()),
      readValidationWorkflowHash: vi.fn(async () => policy.workflowContentHash),
    };
    const empty = await service.readTrustedCiEvidence(db, store, config, analysis, reader);
    expect(empty.status).toBe('no-matching-evidence');
    expect(empty.input).not.toBeNull();
    expect(empty.input!.source.headTree).toBe(input.source.headTree);
    const { sourceHash, ...source } = empty.input!.source;
    expect(sourceHash).toBe(hash(source));
    const p = payload();
    p.input = empty.input!;
    const result = await service.readTrustedCiEvidence(db, store, config, analysis, {
      ...reader,
      listValidationChecks: async () => [check(signed(p))],
    });
    expect(result.status).toBe('verified');
    expect(result.evidence[0]!.checks[0]!.outcome).toBe('failed');
  });
  it('does not query CI for private analyses, legacy trees, missing policy or corrupt artifacts', async () => {
    const reader = {
      listValidationChecks: vi.fn(async () => []),
      readValidationRun: vi.fn(async () => run()),
      readValidationWorkflowHash: vi.fn(async () => policy.workflowContentHash),
    };
    const privateAnalysis = await create(user),
      unknown = await create(null, null);
    for (const id of [privateAnalysis.id, unknown.id])
      expect((await service.readTrustedCiEvidence(db, store, config, id, reader)).status).toBe(
        'input-unavailable',
      );
    expect(
      (
        await service.readTrustedCiEvidence(
          db,
          store,
          { ...config, TRUSTED_CI_POLICIES: [] },
          analysis,
          reader,
        )
      ).status,
    ).toBe('not-configured');
    const original = await store.readText(locator);
    await writeFile(path.join(dir, 'artifacts', locator), original + ' ');
    try {
      expect(
        (await service.readTrustedCiEvidence(db, store, config, analysis, reader)).status,
      ).toBe('input-unavailable');
    } finally {
      await writeFile(path.join(dir, 'artifacts', locator), original);
    }
    expect(reader.listValidationChecks).not.toHaveBeenCalled();
  });
  it('requires authentication, has no submission route, and rechecks revocation after provider I/O', async () => {
    const app = Fastify();
    let authenticated = false;
    app.addHook('onRequest', async (request) => {
      if (authenticated)
        request.user = {
          id: user,
          subject: 'owned-ci',
          displayName: 'Owned',
          role: 'administrator',
          enabled: true,
          groups: [],
          tenantIds: [],
          tenants: [],
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
    const route = `/api/v1/analyses/${analysis}/ci-validation`;
    try {
      expect((await app.inject(route)).statusCode).toBe(401);
      authenticated = true;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: route,
            payload: { localResult: 'must not upload' },
          })
        ).statusCode,
      ).toBe(404);
      const response = await app.inject(route);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const original = service.readTrustedCiEvidence;
      const spy = vi.spyOn(service, 'readTrustedCiEvidence').mockImplementation(async (...args) => {
        const result = await original(...args);
        await db.query('update repositories set enabled=false where id=$1', [repo]);
        return result;
      });
      try {
        const denied = await app.inject(route);
        expect(denied.statusCode, denied.body).toBe(404);
        expect(denied.body).not.toContain('environmentHash');
      } finally {
        spy.mockRestore();
        await db.query('update repositories set enabled=true where id=$1', [repo]);
      }
    } finally {
      await app.close();
    }
  });
});
