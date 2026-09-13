import { randomUUID, generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { FilesystemArtifactStore } from '@gcr/artifact-store';
import {
  centralMemoryContent,
  signedKnowledgeManifest,
  centralKnowledgeBundle,
} from '@gcr/client-contract';
import { verifyKnowledgeManifest } from '../../../../packages/client-core/src/knowledge-signature.js';
import {
  KnowledgeSigner,
  bindKnowledgeSigner,
  ensureKnowledgeScopes,
  removeExpiredKnowledgeManifests,
} from '../services/knowledge-manifest.js';
import { claimKnowledgePublication, publishKnowledge } from '../services/knowledge-publication.js';
import { chromium } from 'playwright';
import { createServer } from '../../../web/src/review-criteria-test-server.js';
import { registerReviewCriteriaRoutes } from './review-criteria.js';
import { registerKnowledgeRoutes } from './review-knowledge.js';
import { loadConfig } from '../config.js';
import { AuthorizationService } from '../services/authorization.js';
import { registerAuthentication, type AuthUser } from '../auth/index.js';
const url = process.env.GCR_TEST_DATABASE_URL;
const content = centralMemoryContent({
  summary: 'Curated memory',
  detail: 'Safe approved explanation',
  recommendation: 'Check the key',
  categories: [],
  appliesTo: { languages: [], filePaths: [], symbols: [], contracts: [], branches: [] },
  counterEvidence: [],
  expiresAt: null,
});

describe.skipIf(!url).sequential('signed knowledge distribution HTTP API', () => {
  const schema = 'gcr_distribution_' + randomUUID().replaceAll('-', '');
  const key = generateKeyPairSync('ed25519');
  const serverId = randomUUID();
  const signer = new KnowledgeSigner(serverId, 'fixture-key', key.privateKey, 86400);
  const actors = new Map<string, AuthUser>();
  let root: Database,
    db: Database,
    directory: string,
    store: FilesystemArtifactStore,
    tenant: string,
    repository: string,
    app: ReturnType<typeof Fastify>;
  const headers = (name = 'alice') => ({ 'x-test-actor': name });
  const base = () => `/api/v1/repositories/${repository}/review-knowledge`;
  const getManifest = (name = 'alice', etag?: string) =>
    app.inject({
      url: `${base()}/manifest?clientContractVersion=2`,
      headers: { ...headers(name), ...(etag ? { 'if-none-match': etag } : {}) },
    });
  const manifest = async (name = 'alice') => {
    const result = await getManifest(name);
    expect(result.statusCode, result.body).toBe(200);
    const parsed = signedKnowledgeManifest(result.json());
    return { result, parsed };
  };
  const download = (snapshot: string, bundle: string, name = 'alice') =>
    app.inject({
      url: `${base()}/bundles/${bundle}?snapshotId=${snapshot}`,
      headers: headers(name),
    });
  const drain = async () => {
    for (let i = 0; i < 30; i++) {
      const claim = await claimKnowledgePublication(db);
      if (!claim) return;
      expect(await publishKnowledge(db, store, claim)).not.toBe('failed');
    }
    throw Error('Publication queue did not drain');
  };
  beforeAll(async () => {
    const local = new URL(url!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname))
      throw Error('Owned localhost database required');
    root = createDatabase(local.toString());
    await root.query(`create schema ${schema}`);
    local.searchParams.set('options', `-c search_path=${schema}`);
    db = createDatabase(local.toString());
    await runMigrations(db, path.resolve('packages/db/migrations'));
    directory = await mkdtemp(path.join(os.tmpdir(), 'gcr-distribution-'));
    store = new FilesystemArtifactStore(directory);
    tenant = (
      await db.query(
        "insert into tenants(slug,display_name) values('distribution','Distribution') returning id",
      )
    ).rows[0].id;
    const instance = (
      await db.query(
        "insert into github_instances(name,api_base_url,web_base_url) values('distribution','https://example.invalid/api/','https://example.invalid/') returning id",
      )
    ).rows[0].id;
    repository = (
      await db.query(
        "insert into repositories(tenant_id,instance_id,github_id,installation_id,owner,name,polling_enabled) values($1,$2,'1','1','synthetic','distribution',false) returning id",
        [tenant, instance],
      )
    ).rows[0].id;
    for (const name of ['admin', 'alice', 'bob', 'outsider']) {
      const role = name === 'admin' ? 'administrator' : 'reviewer';
      const id = (
        await db.query(
          'insert into users(oidc_subject,display_name,role) values($1,$1,$2) returning id',
          [name, role],
        )
      ).rows[0].id;
      actors.set(name, {
        id,
        subject: name,
        displayName: name,
        role,
        enabled: true,
        groups: [],
        tenantIds: name === 'outsider' ? [] : [tenant],
        tenants: [],
      });
      if (name !== 'outsider') {
        await db.query('insert into tenant_memberships(tenant_id,user_id) values($1,$2)', [
          tenant,
          id,
        ]);
        await db.query(
          "insert into repository_grants(repository_id,subject_or_group,role) values($1,$2,'reviewer')",
          [repository, name],
        );
      }
    }
    await bindKnowledgeSigner(db, signer);
    app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.user = actors.get(String(request.headers['x-test-actor'])) ?? null;
    });
    app.get('/api/v1/me', async (request) => ({ schemaVersion: 1, ...request.user }));
    app.get('/api/v1/repositories', async () => ({
      schemaVersion: 1,
      nextCursor: null,
      items: [
        {
          id: repository,
          tenantId: tenant,
          instanceId: instance,
          owner: 'synthetic',
          name: 'distribution',
          githubId: '1',
          tenantSlug: 'distribution',
          tenantName: 'Distribution',
          webBaseUrl: 'https://example.invalid/',
          lastPolledAt: null,
          nextPollAt: null,
          pollOutcome: null,
          pollError: null,
        },
      ],
    }));
    await registerReviewCriteriaRoutes(
      app,
      db,
      new AuthorizationService(loadConfig({ DATABASE_URL: local.toString() })),
    );
    await registerKnowledgeRoutes(
      app,
      db,
      new AuthorizationService(loadConfig({ DATABASE_URL: local.toString() })),
      store,
      signer,
    );
  }, 30000);
  afterAll(async () => {
    await app?.close();
    await db?.end();
    if (root) {
      await root.query(`drop schema ${schema} cascade`);
      await root.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it('requires authentication, explicit supported contract and complete publication before signing', async () => {
    expect(
      (await app.inject({ url: `${base()}/manifest?clientContractVersion=2` })).statusCode,
    ).toBe(401);
    expect((await getManifest('outsider')).statusCode).toBe(404);
    expect((await app.inject({ url: `${base()}/manifest`, headers: headers() })).statusCode).toBe(
      400,
    );
    for (const version of [1, 3])
      expect(
        (
          await app.inject({
            url: `${base()}/manifest?clientContractVersion=${version}`,
            headers: headers(),
          })
        ).statusCode,
      ).toBe(426);
    expect((await getManifest()).statusCode).toBe(503);
    await drain();
    const { parsed } = await manifest();
    expect(parsed.payload.components.personal.releaseSequence).toBe(1);
  });
  it('signs scoped manifests, caches fresh recipes and downloads verifiable immutable components', async () => {
    const { result, parsed } = await manifest();
    expect(
      verifyKnowledgeManifest(parsed, {
        audience: {
          serverId,
          tenantId: tenant,
          repositoryId: repository,
          userId: actors.get('alice')!.id,
        },
        trustedKeys: new Map([['fixture-key', key.publicKey]]),
        now: Date.now(),
        mode: 'online',
      }),
    ).toEqual(parsed);
    expect(result.headers['cache-control']).toBe('private, no-store');
    const cached = await getManifest('alice', String(result.headers.etag));
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe('');
    for (const part of ['policy', 'collective', 'personal'] as const) {
      const component = parsed.payload.components[part];
      const response = await download(parsed.payload.snapshotId, component.bundleId);
      expect(response.statusCode, response.body).toBe(200);
      expect(createHash('sha256').update(response.body).digest('hex')).toBe(component.contentHash);
      expect(Buffer.byteLength(response.body)).toBe(component.sizeBytes);
      expect(centralKnowledgeBundle(response.json())).toMatchObject({
        component: part,
        ownerUserId: part === 'personal' ? actors.get('alice')!.id : null,
      });
    }
  });
  it('keeps a cached manifest through no-op identity membership and grant refresh', async () => {
    const before = (await manifest()).parsed;
    await db.query(
      'insert into tenant_memberships(tenant_id,user_id) values($1,$2) on conflict(tenant_id,user_id) do nothing',
      [tenant, actors.get('alice')!.id],
    );
    await db.query(
      "insert into repository_grants(repository_id,subject_or_group,role) values($1,'alice','reviewer') on conflict do nothing",
      [repository],
    );
    await db.query('update repository_grants set role=role where repository_id=$1', [repository]);
    await db.query('update tenant_memberships set enabled=enabled where user_id=$1', [
      actors.get('alice')!.id,
    ]);
    expect((await getManifest('alice', `"${before.manifestHash}"`)).statusCode).toBe(304);
  });
  it('serves 304 and a pinned download through the real development identity refresh hook', async () => {
    const authenticated = Fastify();
    const config = loadConfig({
      DATABASE_URL: url!,
      AUTH_MODE: 'development',
      DEV_USER_SUBJECT: 'alice',
      DEV_USER_NAME: 'alice',
      DEV_USER_ROLE: 'reviewer',
      AUTO_JOIN_DEFAULT_TENANT: 'true',
      DEFAULT_TENANT_SLUG: 'distribution',
    });
    await registerAuthentication(authenticated, config, db);
    await registerKnowledgeRoutes(
      authenticated,
      db,
      new AuthorizationService(config),
      store,
      signer,
    );
    try {
      const first = await authenticated.inject({
        url: `${base()}/manifest?clientContractVersion=2`,
      });
      expect(first.statusCode, first.body).toBe(200);
      const payload = signedKnowledgeManifest(first.json()).payload;
      const again = await authenticated.inject({
        url: `${base()}/manifest?clientContractVersion=2`,
        headers: { 'if-none-match': String(first.headers.etag) },
      });
      expect(again.statusCode, again.body).toBe(304);
      expect(
        (
          await authenticated.inject({
            url: `${base()}/bundles/${payload.components.policy.bundleId}?snapshotId=${payload.snapshotId}`,
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await authenticated.close();
    }
  });
  it('downloads after real local password login and rejects the same cookie after logout', async () => {
    const authenticated = Fastify();
    const password = randomUUID() + randomUUID();
    const config = loadConfig({
      DATABASE_URL: url!,
      AUTH_MODE: 'local',
      LOCAL_BOOTSTRAP_ADMIN_USERNAME: 'knowledge-fixture',
      LOCAL_BOOTSTRAP_ADMIN_PASSWORD: password,
    });
    await registerAuthentication(authenticated, config, db);
    await registerKnowledgeRoutes(
      authenticated,
      db,
      new AuthorizationService(config),
      store,
      signer,
    );
    try {
      expect(
        (await authenticated.inject({ url: `${base()}/manifest?clientContractVersion=2` }))
          .statusCode,
      ).toBe(401);
      const login = await authenticated.inject({
        method: 'POST',
        url: '/auth/local/login',
        payload: { username: 'knowledge-fixture', password },
      });
      expect(login.statusCode, login.body).toBe(200);
      const cookie = String(login.headers['set-cookie']).split(';')[0]!;
      expect(
        (
          await authenticated.inject({
            url: `${base()}/manifest?clientContractVersion=2`,
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(503);
      await drain();
      const first = await authenticated.inject({
        url: `${base()}/manifest?clientContractVersion=2`,
        headers: { cookie },
      });
      expect(first.statusCode, first.body).toBe(200);
      const payload = signedKnowledgeManifest(first.json()).payload;
      expect(
        (
          await authenticated.inject({
            url: `${base()}/manifest?clientContractVersion=2`,
            headers: { cookie, 'if-none-match': String(first.headers.etag) },
          })
        ).statusCode,
      ).toBe(304);
      const downloadUrl = `${base()}/bundles/${payload.components.personal.bundleId}?snapshotId=${payload.snapshotId}`;
      expect(
        (await authenticated.inject({ url: downloadUrl, headers: { cookie } })).statusCode,
      ).toBe(200);
      expect(
        (await authenticated.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } }))
          .statusCode,
      ).toBe(204);
      expect(
        (await authenticated.inject({ url: downloadUrl, headers: { cookie } })).statusCode,
      ).toBe(401);
    } finally {
      await authenticated.close();
    }
  });
  it('shares public releases while isolating manifests, personal bundles and status by user', async () => {
    expect((await getManifest('bob')).statusCode).toBe(503);
    await drain();
    const alice = (await manifest()).parsed,
      bob = (await manifest('bob')).parsed;
    expect(alice.payload.components.policy).toEqual(bob.payload.components.policy);
    expect(alice.payload.components.collective).toEqual(bob.payload.components.collective);
    expect(alice.payload.components.personal.bundleId).not.toBe(
      bob.payload.components.personal.bundleId,
    );
    expect(
      (await download(alice.payload.snapshotId, alice.payload.components.policy.bundleId, 'bob'))
        .statusCode,
    ).toBe(404);
    expect(
      (await download(alice.payload.snapshotId, bob.payload.components.personal.bundleId))
        .statusCode,
    ).toBe(404);
    const status = await app.inject({ url: `${base()}/status`, headers: headers() });
    expect(status.statusCode).toBe(200);
    expect(status.body).not.toContain(bob.payload.components.personal.bundleId);
  });
  const memory = async (owner: string | null) => {
    const id = randomUUID();
    await db.query(
      `insert into review_memories(id,tenant_id,repository_id,scope,owner_user_id,kind,state,summary,detail,search_text,aggregation_key,source_kind,source_anchor,content_hash,reviewed_by,reviewed_at)
   values($1,$2,$3,$4,$5,'decision','active','Original','RAW_PRIVATE_SOURCE','raw',$6,'manual','{"raw":"PRIVATE_ANCHOR"}'::jsonb,$6,$7,clock_timestamp())`,
      [
        id,
        tenant,
        repository,
        owner ? 'personal' : 'collective',
        owner,
        createHash('sha256').update(id).digest('hex'),
        owner ?? actors.get('admin')!.id,
      ],
    );
    return id;
  };
  const preview = (id: string, name = 'alice') =>
    app.inject({ url: `${base()}/memories/${id}/projection`, headers: headers(name) });
  const approve = (
    id: string,
    fingerprint: string,
    name = 'alice',
    extra: Record<string, unknown> = {},
  ) =>
    app.inject({
      method: 'POST',
      url: `${base()}/memories/${id}/projection`,
      headers: headers(name),
      payload: { expectedFingerprint: fingerprint, content, ...extra },
    });
  it('curates personal memory with source-version checks and changes only the owner component', async () => {
    const before = (await manifest()).parsed;
    const bobBefore = (await manifest('bob')).parsed;
    const id = await memory(actors.get('alice')!.id);
    const pre = await preview(id);
    expect(pre.statusCode).toBe(200);
    expect(pre.body).not.toContain('RAW_PRIVATE_SOURCE');
    expect(pre.body).not.toContain('PRIVATE_ANCHOR');
    const fingerprint = pre.json().fingerprint;
    expect((await preview(id, 'admin')).statusCode).toBe(404);
    expect((await approve(id, fingerprint, 'bob')).statusCode).toBe(404);
    expect(
      (await approve(id, fingerprint, 'alice', { approvedBy: actors.get('admin')!.id })).statusCode,
    ).toBe(400);
    expect((await approve(id, 'a'.repeat(64))).statusCode).toBe(409);
    expect((await approve(id, fingerprint)).statusCode).toBe(201);
    expect((await getManifest('alice', `"${before.manifestHash}"`)).statusCode).toBe(503);
    await drain();
    const after = (await manifest()).parsed;
    expect(after.payload.components.policy).toEqual(before.payload.components.policy);
    expect(after.payload.components.collective).toEqual(before.payload.components.collective);
    expect(after.payload.components.personal.releaseSequence).toBeGreaterThan(
      before.payload.components.personal.releaseSequence,
    );
    expect((await manifest('bob')).parsed.payload.components).toEqual(bobBefore.payload.components);
    expect(
      (await download(before.payload.snapshotId, before.payload.components.policy.bundleId))
        .statusCode,
    ).toBe(409);
    const bundle = await download(
      after.payload.snapshotId,
      after.payload.components.personal.bundleId,
    );
    expect(bundle.body).toContain('Safe approved explanation');
    expect(bundle.body).not.toContain('RAW_PRIVATE_SOURCE');
  });
  it('restricts collective curation to repository maintainers and rejects stale source fingerprints', async () => {
    const id = await memory(null);
    expect((await preview(id)).statusCode).toBe(404);
    const p = await preview(id, 'admin');
    expect(p.statusCode).toBe(200);
    await db.query("update review_memories set detail='Changed raw source' where id=$1", [id]);
    expect((await approve(id, p.json().fingerprint, 'admin')).statusCode).toBe(409);
    expect(
      (await approve(id, (await preview(id, 'admin')).json().fingerprint, 'admin')).statusCode,
    ).toBe(201);
    await drain();
  });
  it('rechecks access before 304 and makes old snapshots unusable even after regrant', async () => {
    const before = (await manifest()).parsed;
    await db.query(
      "delete from repository_grants where repository_id=$1 and subject_or_group='alice'",
      [repository],
    );
    expect((await getManifest('alice', `"${before.manifestHash}"`)).statusCode).toBe(404);
    expect(
      (await download(before.payload.snapshotId, before.payload.components.personal.bundleId))
        .statusCode,
    ).toBe(404);
    await db.query(
      "insert into repository_grants(repository_id,subject_or_group,role) values($1,'alice','reviewer')",
      [repository],
    );
    await drain();
    const after = (await manifest()).parsed;
    expect(after.payload.authorizationRevision).toBeGreaterThan(
      before.payload.authorizationRevision,
    );
    expect(
      (await download(before.payload.snapshotId, before.payload.components.personal.bundleId))
        .statusCode,
    ).toBe(409);
    expect((await getManifest('alice', `"${before.manifestHash}"`)).statusCode).toBe(200);
  });
  it('does not trust an existing authentication object after DB user disable or membership revocation', async () => {
    await db.query('update users set enabled=false where id=$1', [actors.get('alice')!.id]);
    expect((await getManifest()).statusCode).toBe(403);
    await db.query('update users set enabled=true where id=$1', [actors.get('alice')!.id]);
    await db.query('update tenant_memberships set enabled=false where user_id=$1', [
      actors.get('alice')!.id,
    ]);
    expect((await getManifest()).statusCode).toBe(403);
    await db.query('update tenant_memberships set enabled=true where user_id=$1', [
      actors.get('alice')!.id,
    ]);
    await drain();
  });
  it('serializes a permission commit against an in-flight manifest without locking scope rows', async () => {
    let arrived!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = store.inspect.bind(store);
    const spy = vi.spyOn(store, 'inspect').mockImplementationOnce(async (locator) => {
      arrived();
      await resumed;
      return original(locator);
    });
    const c = await db.connect();
    let revoke: Promise<unknown> | undefined;
    const reading = Promise.resolve(getManifest());
    try {
      await reached;
      const pid = (await c.query('select pg_backend_pid() as pid')).rows[0].pid;
      revoke = c.query(
        "delete from repository_grants where repository_id=$1 and subject_or_group='alice'",
        [repository],
      );
      await expect
        .poll(
          async () =>
            (await db.query('select wait_event_type from pg_stat_activity where pid=$1', [pid]))
              .rows[0]?.wait_event_type,
          { timeout: 5000 },
        )
        .toBe('Lock');
      release();
      expect((await reading).statusCode).toBe(200);
      await revoke;
      expect((await getManifest()).statusCode).toBe(404);
    } finally {
      release();
      await reading;
      await revoke;
      c.release();
      spy.mockRestore();
      await db.query(
        "insert into repository_grants(repository_id,subject_or_group,role) values($1,'alice','reviewer') on conflict do nothing",
        [repository],
      );
      await drain();
    }
  });
  it('checks artifact integrity even for 304 and rejects a missing download', async () => {
    const { parsed, result } = await manifest();
    const bundle = parsed.payload.components.policy.bundleId;
    const row = (
      await db.query(
        'select a.locator from review_knowledge_releases r join artifacts a on a.id=r.artifact_id where r.id=$1',
        [bundle],
      )
    ).rows[0];
    const original = await store.readText(row.locator);
    const file = path.join(directory, row.locator);
    try {
      await writeFile(file, '{}');
      expect((await getManifest('alice', String(result.headers.etag))).statusCode).toBe(503);
      expect((await download(parsed.payload.snapshotId, bundle)).statusCode).toBe(503);
      await rm(file);
      expect((await download(parsed.payload.snapshotId, bundle)).statusCode).toBe(503);
    } finally {
      await writeFile(file, original);
    }
  });
  it('binds stable server/key identities, rotates with a new ID, and protects live manifest history', async () => {
    await expect(
      bindKnowledgeSigner(db, new KnowledgeSigner(randomUUID(), 'other', key.privateKey, 0)),
    ).rejects.toThrow('identity mismatch');
    await expect(
      bindKnowledgeSigner(
        db,
        new KnowledgeSigner(serverId, 'fixture-key', generateKeyPairSync('ed25519').privateKey, 0),
      ),
    ).rejects.toThrow('another key');
    await expect(
      bindKnowledgeSigner(
        db,
        new KnowledgeSigner(serverId, 'rotated', generateKeyPairSync('ed25519').privateKey, 0),
      ),
    ).resolves.toBeUndefined();
    const current = (await manifest()).parsed;
    await expect(
      db.query('delete from review_knowledge_manifests where id=$1', [current.payload.snapshotId]),
    ).rejects.toThrow('immutable');
    await expect(
      db.query('update review_knowledge_manifests set manifest=manifest where id=$1', [
        current.payload.snapshotId,
      ]),
    ).rejects.toThrow('immutable');
    const expired = randomUUID();
    await db.query(
      `insert into review_knowledge_manifests(id,repository_id,owner_user_id,recipe_hash,manifest,manifest_hash,refresh_after,expires_at) values($1,$2,$3,$4,'{}'::jsonb,$4,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour')`,
      [expired, repository, actors.get('alice')!.id, '0'.repeat(64)],
    );
    expect((await download(expired, current.payload.components.policy.bundleId)).statusCode).toBe(
      404,
    );
    expect(await removeExpiredKnowledgeManifests(db)).toBe(1);
    expect(
      (
        await db.query('select id from review_knowledge_manifests where id=$1', [
          current.payload.snapshotId,
        ])
      ).rowCount,
    ).toBe(1);
  });
  it('keeps optional distribution disabled without creating first-use scopes', async () => {
    const disabled = Fastify();
    disabled.addHook('onRequest', async (request) => {
      request.user = actors.get('alice')!;
    });
    await registerKnowledgeRoutes(
      disabled,
      db,
      new AuthorizationService(loadConfig({ DATABASE_URL: url! })),
      store,
    );
    try {
      expect(
        (await disabled.inject({ url: `${base()}/manifest?clientContractVersion=2` })).statusCode,
      ).toBe(503);
    } finally {
      await disabled.close();
    }
    await ensureKnowledgeScopes(db, repository, actors.get('alice')!.id);
  });
  it('reports pending, failure, disabled and unavailable states without inventing client sync', async () => {
    const scope = (
      await db.query(
        "select id from review_knowledge_scopes where repository_id=$1 and component='policy'",
        [repository],
      )
    ).rows[0].id;
    const read = () => app.inject({ url: `${base()}/status`, headers: headers() });
    await db.query("select request_review_knowledge($1,'policy',null,'status-test')", [repository]);
    let response = await read();
    expect(
      response.json().components.find((item: { component: string }) => item.component === 'policy')
        .state,
    ).toBe('pending');
    await db.query(
      "update review_knowledge_scopes set last_error='PUBLICATION_STORAGE_FAILED' where id=$1",
      [scope],
    );
    response = await read();
    expect(response.json().syncObservation).toBe('unknown');
    expect(
      response.json().components.find((item: { component: string }) => item.component === 'policy')
        .state,
    ).toBe('failed');
    await drain();
    const artifact = (
      await db.query(
        'select r.artifact_id from review_knowledge_scopes s join review_knowledge_releases r on r.id=s.current_release_id where s.id=$1',
        [scope],
      )
    ).rows[0].artifact_id;
    await db.query("update artifacts set state='unavailable' where id=$1", [artifact]);
    response = await read();
    expect(
      response.json().components.find((item: { component: string }) => item.component === 'policy')
        .state,
    ).toBe('unavailable');
    await db.query("update artifacts set state='available' where id=$1", [artifact]);
    const disabled = Fastify();
    disabled.addHook('onRequest', async (request) => {
      request.user = actors.get('alice')!;
    });
    await registerKnowledgeRoutes(
      disabled,
      db,
      new AuthorizationService(loadConfig({ DATABASE_URL: url! })),
      store,
    );
    try {
      const result = await disabled.inject({ url: `${base()}/status` });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().enabled).toBe(false);
      expect(
        result.json().components.every((item: { state: string }) => item.state === 'disabled'),
      ).toBe(true);
    } finally {
      await disabled.close();
    }
  });
  it('lists only memories the current user can curate, with bounded pagination', async () => {
    const privateId = await memory(actors.get('bob')!.id);
    const collectiveId = await memory(null);
    const list = (name: string, cursor = '') =>
      app.inject({
        url: `${base()}/memories${cursor ? `?cursor=${cursor}` : ''}`,
        headers: headers(name),
      });
    expect((await list('outsider')).statusCode).toBe(404);
    expect((await list('alice')).body).not.toContain(privateId);
    expect((await list('admin')).body).not.toContain(privateId);
    expect((await list('alice')).body).not.toContain(collectiveId);
    expect((await list('admin')).body).toContain(collectiveId);
    for (let i = 0; i < 100; i++) await memory(actors.get('bob')!.id);
    const first = await list('bob');
    expect(first.json().items).toHaveLength(100);
    expect(first.json().nextCursor).toBeTruthy();
    const second = await list('bob', first.json().nextCursor);
    expect(second.json().items).toHaveLength(1);
    expect(second.json().nextCursor).toBeNull();
    expect(first.body + second.body).not.toContain('RAW_PRIVATE_SOURCE');
    await drain();
  });
  it('approves curated memory in Chrome and shows publication, stale source and mobile status', async () => {
    const id = await memory(actors.get('alice')!.id);
    await db.query("update review_memories set summary='Browser publication memory' where id=$1", [
      id,
    ]);
    await drain();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw Error('Owned server required');
    const vite = await createServer({
      root: path.resolve('apps/web'),
      server: { host: '127.0.0.1', port: 0, proxy: { '/api': `http://127.0.0.1:${address.port}` } },
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await vite.listen();
      const web = vite.httpServer!.address();
      if (!web || typeof web === 'string') throw Error('Owned web server required');
      browser = await chromium.launch({ channel: 'chrome', headless: true });
      const context = await browser.newContext({
        viewport: { width: 1360, height: 1050 },
        extraHTTPHeaders: headers(),
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${web.port}/review-criteria`);
      await page.getByRole('heading', { name: '리뷰 지식 배포', exact: true }).waitFor();
      await page.getByText('클라이언트 동기화: 확인되지 않음.', { exact: false }).waitFor();
      await page.getByText('메모리 배포 내용 검토·승인', { exact: true }).click();
      await page.getByRole('button', { name: /Browser publication memory/ }).click();
      await page.getByLabel('배포 설명', { exact: true }).fill('Browser-approved safe content');
      await db.query("update review_memories set detail='New private source' where id=$1", [id]);
      await page.getByRole('button', { name: '배포 내용 승인', exact: true }).click();
      await page.getByText('활성 메모리와 출처를 다시 확인해 주세요.', { exact: true }).waitFor();
      expect(await page.getByLabel('배포 설명', { exact: true }).inputValue()).toBe(
        'Browser-approved safe content',
      );
      await page
        .getByRole('button', { name: '현재 입력을 버리고 최신 상태 불러오기', exact: true })
        .click();
      await page.getByLabel('배포 설명', { exact: true }).fill('Browser-approved safe content');
      await page.getByRole('button', { name: '배포 내용 승인', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page
        .getByText('배포 내용을 승인했습니다. 발행 상태에서 반영 결과를 확인해 주세요.', {
          exact: true,
        })
        .waitFor();
      await drain();
      await page.getByRole('button', { name: '배포 상태 새로고침', exact: true }).click();
      const ownRow = page
        .getByRole('row')
        .filter({ has: page.getByRole('rowheader', { name: '내 개인 메모리', exact: true }) });
      await ownRow.getByText('발행됨', { exact: true }).waitFor();
      const current = (await manifest()).parsed;
      const bundle = await download(
        current.payload.snapshotId,
        current.payload.components.personal.bundleId,
      );
      expect(bundle.body).toContain('Browser-approved safe content');
      expect(bundle.body).not.toContain('New private source');
      expect(await page.locator('body').innerText()).not.toContain('RAW_PRIVATE_SOURCE');
      expect(errors).toEqual([]);
      if (process.env.GCR_KNOWLEDGE_SCREENSHOT)
        await page.screenshot({
          path: process.env.GCR_KNOWLEDGE_SCREENSHOT.replace(/\.png$/, '-desktop.png'),
          fullPage: true,
        });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      if (process.env.GCR_KNOWLEDGE_SCREENSHOT)
        await page.screenshot({ path: process.env.GCR_KNOWLEDGE_SCREENSHOT, fullPage: true });
      await context.close();
    } finally {
      await browser?.close();
      await vite.close();
    }
  }, 60000);
  it('removes scoped manifests and release metadata on repository deletion', async () => {
    expect(
      (
        await db.query('select id from review_knowledge_manifests where repository_id=$1', [
          repository,
        ])
      ).rowCount,
    ).toBeGreaterThan(0);
    await db.query('delete from repositories where id=$1', [repository]);
    expect(
      (
        await db.query('select id from review_knowledge_manifests where repository_id=$1', [
          repository,
        ])
      ).rowCount,
    ).toBe(0);
    expect((await getManifest()).statusCode).toBe(404);
  });
});
