import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { FilesystemArtifactStore } from '@gcr/artifact-store';
import {
  CentralKnowledgeCache,
  KnowledgeHttpTransport,
  TrustedCentralBinding,
} from '../../../../packages/client-core/dist/index.js';
import { loadConfig, type AppConfig } from '../config.js';
import { registerMutationOriginGuard } from './mutation-origin.js';
import { registerAuthentication, requireUser, type AuthUser } from './index.js';
import { registerClientCredentialRoutes } from './client-routes.js';
import {
  authenticateClientKey,
  ClientCredentialError,
  issueClientKey,
} from './client-credentials.js';
import { registerReviewSubmissionRoutes } from '../routes/review-submissions.js';
import { registerProfileRoutes } from '../routes/profile.js';
import { registerReviewCriteriaRoutes } from '../routes/review-criteria.js';
import { registerKnowledgeRoutes } from '../routes/review-knowledge.js';
import { AuthorizationService } from '../services/authorization.js';
import {
  KnowledgeSigner,
  bindKnowledgeSigner,
  ensureKnowledgeScopes,
} from '../services/knowledge-manifest.js';
import { claimKnowledgePublication, publishKnowledge } from '../services/knowledge-publication.js';
import { hashLocalPassword } from '../services/local-accounts.js';
import { revokeUserClientCredentials } from '../identity/revocation.js';
const databaseUrl = process.env.GCR_TEST_DATABASE_URL;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe
  .skipIf(!databaseUrl)
  .sequential('scoped client API keys and actual HTTP cache sync', () => {
    const schema = `gcr_client_keys_${randomUUID().replaceAll('-', '')}`;
    const pair = generateKeyPairSync('ed25519');
    const serverId = randomUUID();
    const signer = new KnowledgeSigner(serverId, 'fixture', pair.privateKey, 86400);
    const actors = new Map<string, { user: AuthUser; cookie: string }>();
    let root: Database,
      db: Database,
      directory: string,
      store: FilesystemArtifactStore,
      config: AppConfig,
      app: ReturnType<typeof Fastify>,
      origin: string;
    let tenant: string, otherTenant: string, repo: string, secondRepo: string, otherRepo: string;
    const scope = () => ({
      name: 'Fixture laptop',
      clientId: 'commit-defender',
      tenantId: tenant,
      repositoryIds: [repo],
      scopes: ['knowledge:read'],
      lifetimeDays: 30,
    });
    const web = (name = 'alice') => ({
      cookie: actors.get(name)!.cookie,
      origin: 'http://127.0.0.1',
    });
    const auth = (token: string) => ({
      authorization: `Bearer ${token}`,
      'x-gcr-server-id': serverId,
    });
    const issue = async (name = 'alice', override = {}) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/me/client-credentials',
        headers: web(name),
        payload: { ...scope(), ...override },
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json();
    };
    const me = (token: string) =>
      app.inject({ url: '/api/v1/client-auth/me', headers: auth(token) });
    const manifestPath = (id = repo) =>
      `/api/v1/repositories/${id}/review-knowledge/manifest?clientContractVersion=2`;
    async function drain() {
      for (let i = 0; i < 40; i++) {
        const claim = await claimKnowledgePublication(db);
        if (!claim) return;
        expect(await publishKnowledge(db, store, claim)).not.toBe('failed');
      }
      throw Error('Fixture publication queue did not drain');
    }
    beforeAll(async () => {
      const url = new URL(databaseUrl!);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw Error('Owned local database only');
      root = createDatabase(url.href);
      await root.query(`create schema ${schema}`);
      url.searchParams.set('options', `-c search_path=${schema}`);
      db = createDatabase(url.href);
      await runMigrations(db, path.resolve('packages/db/migrations'));
      directory = await mkdtemp(path.join(tmpdir(), 'gcr-client-keys-'));
      store = new FilesystemArtifactStore(path.join(directory, 'artifacts'));
      config = loadConfig({
        DATABASE_URL: url.href,
        NODE_ENV: 'test',
        AUTH_MODE: 'local',
        PUBLIC_BASE_URL: 'http://127.0.0.1',
        LOCAL_BOOTSTRAP_ADMIN_USERNAME: 'fixture-admin',
        LOCAL_BOOTSTRAP_ADMIN_PASSWORD: 'Synthetic-only-password-2026!',
        CLIENT_API_KEYS_ENABLED: 'true',
        KNOWLEDGE_PUBLICATION_ENABLED: 'true',
        KNOWLEDGE_DISTRIBUTION_ENABLED: 'true',
        KNOWLEDGE_SERVER_ID: serverId,
        KNOWLEDGE_SIGNING_KEY_ID: 'fixture',
        KNOWLEDGE_SIGNING_KEY_FILE: '/synthetic-not-read-by-registration',
      });
      const instance = (
        await db.query(
          "insert into github_instances(name,api_base_url,web_base_url) values('fixture','https://fixture.invalid/api','https://fixture.invalid') returning id",
        )
      ).rows[0].id;
      tenant = (
        await db.query(
          "insert into tenants(slug,display_name) values('client-keys','Client keys') returning id",
        )
      ).rows[0].id;
      otherTenant = (
        await db.query(
          "insert into tenants(slug,display_name) values('client-other','Other') returning id",
        )
      ).rows[0].id;
      let githubId = 0;
      const repository = async (tenantId: string, name: string) =>
        (
          await db.query(
            "insert into repositories(tenant_id,instance_id,github_id,installation_id,owner,name,polling_enabled) values($1,$2,$3,'1','fixture',$4,false) returning id",
            [tenantId, instance, ++githubId, name],
          )
        ).rows[0].id;
      repo = await repository(tenant, 'repo');
      secondRepo = await repository(tenant, 'second');
      otherRepo = await repository(otherTenant, 'other');
      const passwordHash = await hashLocalPassword('Synthetic-user-password-2026!');
      for (const name of ['alice', 'bob', 'outsider']) {
        const id = (
          await db.query(
            "insert into users(oidc_subject,display_name,role) values($1,$1,'reviewer') returning id",
            [`local:${name}`],
          )
        ).rows[0].id;
        await db.query(
          'insert into local_credentials(user_id,username,password_hash) values($1,$2,$3)',
          [id, name, passwordHash],
        );
        const tenantId = name === 'outsider' ? otherTenant : tenant;
        await db.query('insert into tenant_memberships(tenant_id,user_id) values($1,$2)', [
          tenantId,
          id,
        ]);
        for (const repositoryId of name === 'outsider' ? [otherRepo] : [repo, secondRepo])
          await db.query(
            "insert into repository_grants(repository_id,subject_or_group,role) values($1,$2,'reviewer')",
            [repositoryId, `local:${name}`],
          );
        actors.set(name, {
          user: {
            id,
            subject: `local:${name}`,
            displayName: `local:${name}`,
            role: 'reviewer',
            groups: [],
            enabled: true,
            tenantIds: [tenantId],
            tenants: [],
          },
          cookie: '',
        });
      }
      app = Fastify();
      app.setErrorHandler((error: Error, _request: FastifyRequest, reply: FastifyReply) =>
        reply.code(error instanceof ClientCredentialError ? error.statusCode : 500).send({
          error: { code: error instanceof ClientCredentialError ? error.code : 'UNEXPECTED' },
        }),
      );
      registerMutationOriginGuard(app, { ...config, NODE_ENV: 'production' });
      await registerAuthentication(app, config, db);
      const authorization = new AuthorizationService(config);
      await registerClientCredentialRoutes(app, db, config, authorization, signer);
      await registerKnowledgeRoutes(app, db, authorization, store, signer);
      await registerReviewSubmissionRoutes(app, db, config, authorization);
      await registerReviewCriteriaRoutes(app, db, authorization, config);
      app.post('/api/v1/model-fixture', { preHandler: requireUser }, async () => ({
        executed: true,
      }));
      await bindKnowledgeSigner(db, signer);
      for (const [name, actor] of actors) {
        const login = await app.inject({
          method: 'POST',
          url: '/auth/local/login',
          headers: { origin: 'http://127.0.0.1' },
          payload: { username: name, password: 'Synthetic-user-password-2026!' },
        });
        expect(login.statusCode, login.body).toBe(200);
        actor.cookie = String(login.headers['set-cookie']).split(';')[0]!;
      }
      for (const name of ['alice', 'bob'])
        await ensureKnowledgeScopes(db, repo, actors.get(name)!.user.id);
      await drain();
      origin = await app.listen({ host: '127.0.0.1', port: 0 });
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
    it('keeps profile and client connections usable with HTTP and HTTPS browser sessions', async () => {
      const https = 'https://gcr.test';
      const http = 'http://gcr.test';
      const browserConfig = { ...config, PUBLIC_BASE_URL: https, LOCAL_HTTP_ORIGIN: http };
      const browserApp = Fastify();
      registerMutationOriginGuard(browserApp, { ...browserConfig, NODE_ENV: 'production' });
      await registerAuthentication(browserApp, browserConfig, db);
      await registerProfileRoutes(browserApp, db, browserConfig);
      await registerClientCredentialRoutes(
        browserApp,
        db,
        browserConfig,
        new AuthorizationService(browserConfig),
        signer,
      );
      try {
        for (const username of ['alice', 'fixture-admin']) {
          for (const origin of [http, https]) {
            const login = await browserApp.inject({
              method: 'POST',
              url: '/auth/local/login',
              headers: { origin },
              payload: {
                username,
                password:
                  username === 'alice'
                    ? 'Synthetic-user-password-2026!'
                    : 'Synthetic-only-password-2026!',
              },
            });
            expect(login.statusCode, login.body).toBe(200);
            const cookie = String(login.headers['set-cookie']).split(';')[0]!;
            expect(cookie.startsWith(origin === http ? 'gcr_http_session=' : 'gcr_session=')).toBe(
              true,
            );
            const headers = { cookie, origin };
            try {
              // Same-origin browser GETs need not send Origin.
              const profile = await browserApp.inject({
                url: '/api/v1/profile',
                headers: { cookie },
              });
              expect(profile.statusCode, profile.body).toBe(200);
              const keys = await browserApp.inject({
                url: '/api/v1/me/client-credentials',
                headers: { cookie },
              });
              expect(keys.statusCode, keys.body).toBe(200);
              expect(keys.headers['cache-control']).toBe('private, no-store');
              const connection = await browserApp.inject({
                url: `/api/v1/me/client-connection-config?repositoryId=${repo}`,
                headers: { cookie },
              });
              expect(connection.statusCode, connection.body).toBe(200);
              expect(connection.json().serverUrl).toBe(https);
              const issued = await browserApp.inject({
                method: 'POST',
                url: '/api/v1/me/client-credentials',
                headers,
                payload: scope(),
              });
              expect(issued.statusCode, issued.body).toBe(201);
              const { token, id } = issued.json();
              expect((await me(token)).statusCode).toBe(200);
              for (const invalidOrigin of [
                undefined,
                'https://attacker.test',
                `${http}:444`,
                'null',
              ]) {
                const rejected = await browserApp.inject({
                  method: 'DELETE',
                  url: `/api/v1/me/client-credentials/${id}`,
                  headers: {
                    cookie,
                    ...(invalidOrigin ? { origin: invalidOrigin } : {}),
                    'x-forwarded-host': 'gcr.test',
                    'x-forwarded-proto': 'https',
                  },
                });
                expect(rejected.statusCode, rejected.body).toBe(403);
              }
              expect(
                (
                  await browserApp.inject({
                    url: '/api/v1/me/client-credentials',
                    headers: { ...headers, ...auth(token) },
                  })
                ).statusCode,
              ).toBe(401);
              // An unrelated HTTPS cookie must not replace the approved HTTP session on mutation.
              const revoked = await browserApp.inject({
                method: 'DELETE',
                url: `/api/v1/me/client-credentials/${id}`,
                headers: {
                  ...headers,
                  cookie: origin === http ? `gcr_session=stale; ${cookie}` : cookie,
                },
              });
              expect(revoked.statusCode, revoked.body).toBe(204);
              expect((await me(token)).statusCode).toBe(403);
            } finally {
              expect(
                (await browserApp.inject({ method: 'POST', url: '/auth/logout', headers }))
                  .statusCode,
              ).toBe(204);
            }
            expect(
              (
                await browserApp.inject({
                  url: '/api/v1/me/client-credentials',
                  headers: { cookie },
                })
              ).statusCode,
            ).toBe(401);
          }
        }
      } finally {
        await browserApp.close();
      }
    });
    it('exports a pinned public connection only for the authenticated web user and authorized repository', async () => {
      const url = `/api/v1/me/client-connection-config?repositoryId=${repo}`;
      const response = await app.inject({ url, headers: { ...web(), host: 'attacker.invalid' } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toEqual({
        serverUrl: config.PUBLIC_BASE_URL,
        serverId,
        tenantId: tenant,
        repositoryId: repo,
        trustedKeys: [
          {
            id: signer.keyId,
            pem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          },
        ],
        ca: null,
      });
      expect(response.body).not.toContain('PRIVATE KEY');
      expect((await app.inject({ url })).statusCode).toBe(401);
      expect((await app.inject({ url, headers: web('outsider') })).statusCode).toBe(403);
      const key = await issue();
      expect((await app.inject({ url, headers: auth(key.token) })).statusCode).toBe(401);
      expect(
        (await app.inject({ url: `${url}&tenantId=${otherTenant}`, headers: web() })).statusCode,
      ).toBe(400);
      await db.query('update repositories set enabled=false where id=$1', [repo]);
      try {
        expect((await app.inject({ url, headers: web() })).statusCode).toBe(403);
      } finally {
        await db.query('update repositories set enabled=true where id=$1', [repo]);
      }
    });
    it('returns only the selected authorized repository identity through a read-only client route', async () => {
      const key = await issue();
      const url = `/api/v1/client-repositories/${repo}`;
      const response = await app.inject({ url, headers: auth(key.token) });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toMatchObject({
        schemaVersion: 1,
        serverId,
        tenantId: tenant,
        repositoryId: repo,
        webBaseUrl: 'https://fixture.invalid/',
      });
      expect(response.json().owner).toBeTruthy();
      expect(response.body).not.toContain(key.token);
      for (const id of [secondRepo, otherRepo, randomUUID()])
        expect(
          (await app.inject({ url: `/api/v1/client-repositories/${id}`, headers: auth(key.token) }))
            .statusCode,
        ).toBe(403);
      expect((await app.inject({ url, headers: web() })).statusCode).toBe(401);
      const revoked = await app.inject({
        method: 'DELETE',
        url: '/api/v1/me/client-credentials/' + key.id,
        headers: web(),
      });
      expect(revoked.statusCode).toBe(204);
      expect((await app.inject({ url, headers: auth(key.token) })).statusCode).toBe(403);
    });
    it('advertises only the implemented key flow and returns a secret once without storing or listing it', async () => {
      expect((await app.inject('/api/v1/client-auth/config')).json().methods).toEqual(['api-key']);
      const key = await issue();
      expect(key.token).toMatch(/^gcr_key_/);
      const listed = await app.inject({ url: '/api/v1/me/client-credentials', headers: web() });
      expect(listed.body).not.toContain(key.token);
      expect(listed.body).not.toContain('secret_hash');
      const rows = await db.query('select secret_hash from client_api_keys where id=$1', [key.id]);
      expect(rows.rows[0].secret_hash).toBe(hash(key.token));
      expect(
        (await db.query('select metadata from audit_events where resource_id=$1', [key.id])).rows,
      ).toHaveLength(1);
      const result = await me(key.token);
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toMatchObject({
        userId: actors.get('alice')!.user.id,
        repositoryIds: [repo],
        scopes: ['knowledge:read'],
      });
    });
    it('issues, lists and authenticates a non-expiring key while still enforcing revocation', async () => {
      const key = await issue('alice', { lifetimeDays: null });
      expect(key.expiresAt).toBeNull();
      await db.query(
        "update client_api_keys set created_at=statement_timestamp()-interval '10 years' where id=$1",
        [key.id],
      );
      expect((await me(key.token)).json()).toMatchObject({ keyId: key.id, expiresAt: null });
      const listed = (
        await app.inject({ url: '/api/v1/me/client-credentials', headers: web() })
      ).json();
      expect(listed.items.find((item: { id: string }) => item.id === key.id).expiresAt).toBeNull();
      expect(
        (await app.inject({ url: `/api/v1/client-repositories/${repo}`, headers: auth(key.token) }))
          .statusCode,
      ).toBe(200);
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(
          (
            await app.inject({
              method: 'DELETE',
              url: '/api/v1/me/client-credentials/' + key.id,
              headers: web(),
            })
          ).statusCode,
        ).toBe(204);
      }
      expect((await me(key.token)).statusCode).toBe(403);
    });
    it('counts non-expiring keys toward the 50 active key limit', async () => {
      const key = await issue('bob', { lifetimeDays: null });
      const ids: string[] = [];
      try {
        const { rows } = await db.query<{ count: string }>(
          'select count(*) from client_api_keys where user_id=$1 and revoked_at is null and (expires_at is null or expires_at>clock_timestamp())',
          [actors.get('bob')!.user.id],
        );
        for (let count = Number(rows[0]!.count); count < 50; count++) {
          const id = randomUUID();
          await db.query(
            `insert into client_api_keys(id,user_id,server_id,tenant_id,client_id,name,secret_hash,scopes,repository_ids,credential_epoch,auth_mode,local_password_changed_at,expires_at)
            select $2,user_id,server_id,tenant_id,client_id,name,$3,scopes,repository_ids,credential_epoch,auth_mode,local_password_changed_at,null from client_api_keys where id=$1`,
            [key.id, id, hash(id)],
          );
          ids.push(id);
        }
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/me/client-credentials',
          headers: web('bob'),
          payload: { ...scope(), lifetimeDays: null },
        });
        expect(response.statusCode, response.body).toBe(429);
        expect(response.json().error.code).toBe('CLIENT_KEY_LIMIT');
      } finally {
        await db.query('delete from client_api_keys where id=any($1::uuid[])', [[...ids, key.id]]);
      }
    });
    it('preserves the dated key database bounds and rejects invalid API lifetimes', async () => {
      const key = await issue();
      expect(Date.parse(key.expiresAt) - Date.parse(key.createdAt)).toBe(30 * 86400000);
      for (const days of [0, 91]) {
        await expect(
          db.query(
            "update client_api_keys set expires_at=created_at+$2*interval '1 day' where id=$1",
            [key.id, days],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/v1/me/client-credentials',
              headers: web(),
              payload: { ...scope(), lifetimeDays: days },
            })
          ).statusCode,
        ).toBe(400);
      }
      expect((await me(key.token)).statusCode).toBe(200);
    });
    it('rejects CSRF, another tenant, ungranted scopes and attempts to choose another owner', async () => {
      for (const request of [
        { headers: { ...web(), origin: 'https://attacker.invalid' }, payload: scope() },
        {
          headers: web(),
          payload: { ...scope(), tenantId: otherTenant, repositoryIds: [otherRepo] },
        },
        { headers: web(), payload: { ...scope(), scopes: ['model:execute'] } },
        { headers: web(), payload: { ...scope(), userId: actors.get('bob')!.user.id } },
      ])
        expect([400, 403]).toContain(
          (await app.inject({ method: 'POST', url: '/api/v1/me/client-credentials', ...request }))
            .statusCode,
        );
    });
    it('does not use cookies as bearer credentials or allow a valid key to execute another API', async () => {
      const key = await issue();
      expect((await app.inject({ url: '/api/v1/client-auth/me', headers: web() })).statusCode).toBe(
        401,
      );
      expect(
        (
          await app.inject({
            url: manifestPath(),
            headers: { ...web(), authorization: 'Bearer invalid' },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/model-fixture',
            headers: { ...web(), ...auth(key.token) },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            url: '/api/v1/client-auth/me',
            headers: { ...auth(key.token), 'x-gcr-server-id': randomUUID() },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            url: '/api/v1/client-auth/me',
            headers: auth(actors.get('alice')!.cookie.split('=')[1]!),
          })
        ).statusCode,
      ).toBe(401);
    });
    it('restricts a key to issued repositories and keeps personal manifests separate for two users', async () => {
      const alice = await issue();
      const bob = await issue('bob');
      expect(
        (await app.inject({ url: manifestPath(secondRepo), headers: auth(alice.token) }))
          .statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ url: manifestPath(otherRepo), headers: auth(alice.token) })).statusCode,
      ).toBe(403);
      await drain();
      const a = await app.inject({ url: manifestPath(), headers: auth(alice.token) });
      const b = await app.inject({ url: manifestPath(), headers: auth(bob.token) });
      expect(a.statusCode, a.body).toBe(200);
      expect(b.statusCode, b.body).toBe(200);
      const am = a.json().payload,
        bm = b.json().payload;
      expect(am.components.personal.bundleId).not.toBe(bm.components.personal.bundleId);
      const stolen = await app.inject({
        url: `/api/v1/repositories/${repo}/review-knowledge/bundles/${bm.components.personal.bundleId}?snapshotId=${bm.snapshotId}`,
        headers: auth(alice.token),
      });
      expect([403, 404]).toContain(stolen.statusCode);
    });
    it('keeps client propagation read-only even for previously issued write-scoped keys', async () => {
      const reader = await issue();
      const legacy = await issue('alice');
      await db.query('update client_api_keys set scopes=$1::text[] where id=$2', [
        ['knowledge:read', 'reviews:submit', 'feedback:submit'],
        legacy.id,
      ]);
      const before = (await db.query('select count(*) from client_review_submissions')).rows[0]
        .count;
      for (const key of [reader, legacy]) {
        expect(
          (await app.inject({ url: '/api/v1/client-auth/me', headers: auth(key.token) }))
            .statusCode,
        ).toBe(200);
        for (const kind of ['results', 'feedback']) {
          const result = await app.inject({
            method: 'POST',
            url: `/api/v1/repositories/${repo}/review-submissions/${kind}`,
            headers: auth(key.token),
            payload: { localSource: 'must-stay-local' },
          });
          expect(result.statusCode).toBe(403);
          expect(result.json().error.code).toBe('CLIENT_READ_ONLY');
        }
      }
      expect((await db.query('select count(*) from client_review_submissions')).rows[0].count).toBe(
        before,
      );
    });
    it('downloads real signed publications over HTTP into the encrypted cache and honors 304', async () => {
      const key = await issue();
      await drain();
      const binding = new TrustedCentralBinding({
        serverUrl: origin,
        audience: {
          serverId,
          tenantId: tenant,
          repositoryId: repo,
          userId: actors.get('alice')!.user.id,
        },
        trustedKeys: new Map([['fixture', pair.publicKey]]),
        allowLoopbackHttp: true,
      });
      const keys = new Map<string, Buffer>();
      const cache = await CentralKnowledgeCache.open({
        binding,
        dataDirectory: path.join(directory, 'cache'),
        scope: {
          kind: 'repository',
          profileId: 'fixture',
          repositoryKey: hash('repository'),
          worktreeKey: hash('worktree'),
        },
        keys: {
          async read(id) {
            return keys.get(id);
          },
          async write(id, v) {
            keys.set(id, Buffer.from(v));
          },
          async remove(id) {
            keys.delete(id);
          },
        },
      });
      try {
        const transport = new KnowledgeHttpTransport(binding, {
          bindingId: binding.id,
          readToken: async () => key.token,
        });
        const first = await cache.synchronize(transport);
        expect(first.bundles.personal.ownerUserId).toBe(actors.get('alice')!.user.id);
        const second = await cache.synchronize(transport);
        expect(second.manifest.manifestHash).toBe(first.manifest.manifestHash);
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/me/client-credentials/${key.id}`,
          headers: web(),
        });
        await expect(cache.synchronize(transport)).rejects.toMatchObject({ code: 'revoked' });
        await expect(cache.read()).rejects.toMatchObject({ code: 'revoked' });
      } finally {
        cache.close();
      }
    });
    it('rechecks current membership before 304 and applies individual revocation only to the owner', async () => {
      const key = await issue();
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/me/client-credentials/${key.id}`,
            headers: web('bob'),
          })
        ).statusCode,
      ).toBe(403);
      await db.query(
        'update tenant_memberships set enabled=false where user_id=$1 and tenant_id=$2',
        [actors.get('alice')!.user.id, tenant],
      );
      expect(
        (
          await app.inject({
            url: manifestPath(),
            headers: { ...auth(key.token), 'if-none-match': '*' },
          })
        ).statusCode,
      ).toBe(403);
      await db.query(
        'update tenant_memberships set enabled=true where user_id=$1 and tenant_id=$2',
        [actors.get('alice')!.user.id, tenant],
      );
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/me/client-credentials/${key.id}`,
            headers: web(),
          })
        ).statusCode,
      ).toBe(204);
      expect((await me(key.token)).statusCode).toBe(403);
    });
    it('applies the existing user credential epoch and local password-change invalidation', async () => {
      const key = await issue('bob', { lifetimeDays: null });
      const c = await db.connect();
      try {
        await c.query('begin');
        await revokeUserClientCredentials(c, actors.get('bob')!.user.id);
        await c.query('commit');
      } finally {
        c.release();
      }
      expect((await me(key.token)).statusCode).toBe(403);
      const local = await issue('bob', { lifetimeDays: null });
      await db.query(
        'update local_credentials set password_changed_at=clock_timestamp() where user_id=$1',
        [actors.get('bob')!.user.id],
      );
      expect((await me(local.token)).statusCode).toBe(403);
    });
    it('distinguishes stale SAML identity freshness from confirmed security-epoch revocation', async () => {
      const user = actors.get('alice')!.user;
      const identity = (
        await db.query(
          `insert into user_identities(user_id,identity_key,user_binding_key,keycloak_identity_key,idp_issuer,sp_entity_id,name_id_format,name_id,keycloak_user_id,enabled,provisioning_state,identity_verified_at,security_checked_at,security_fresh_until)
      values($1,$2,$3,$4,'https://idp.invalid','https://gcr.invalid','urn:oasis:names:tc:SAML:2.0:nameid-format:persistent','fixture','fixture',true,'provisioned',clock_timestamp(),statement_timestamp(),statement_timestamp()+interval '5 minutes') returning id`,
          [user.id, hash('identity'), hash('binding'), hash('keycloak')],
        )
      ).rows[0].id;
      const sessionToken = randomBytes(32).toString('base64url');
      await db.query(
        `insert into user_sessions(id_hash,user_id,expires_at,saml_identity_id,saml_session_index,saml_security_epoch,saml_session_not_on_or_after) values($1,$2,statement_timestamp()+interval '1 hour',$3,'fixture',1,statement_timestamp()+interval '1 hour')`,
        [hash(sessionToken), user.id, identity],
      );
      const key = await issueClientKey(db, {
        user,
        sessionToken,
        serverId,
        authMode: 'saml',
        requestId: 'fixture-saml',
        input: scope(),
      });
      const verify = () =>
        authenticateClientKey(db, {
          authorization: `Bearer ${key.token}`,
          serverId,
          requestedServerId: serverId,
          authMode: 'saml',
          repositoryId: repo,
        });
      expect((await verify()).user.id).toBe(user.id);
      await expect(
        db.query('update client_api_keys set user_id=$2 where id=$1', [
          key.id,
          actors.get('bob')!.user.id,
        ]),
      ).rejects.toMatchObject({ code: '23503' });
      await db.query(
        "update user_identities set security_checked_at=statement_timestamp()-interval '6 minutes',security_fresh_until=statement_timestamp()-interval '1 minute' where id=$1",
        [identity],
      );
      await expect(verify()).rejects.toMatchObject({
        statusCode: 503,
        code: 'IDENTITY_UNAVAILABLE',
      });
      await db.query('update user_identities set security_epoch=security_epoch+1 where id=$1', [
        identity,
      ]);
      await expect(verify()).rejects.toMatchObject({
        statusCode: 403,
        code: 'CLIENT_ACCESS_REVOKED',
      });
    });
    it('rejects expired keys, disabled users and changed repository grants on the next request', async () => {
      const expired = await issue();
      await db.query(
        "update client_api_keys set created_at=statement_timestamp()-interval '2 days',expires_at=statement_timestamp()-interval '1 day' where id=$1",
        [expired.id],
      );
      expect((await me(expired.token)).statusCode).toBe(401);
      const key = await issue('alice', { lifetimeDays: null });
      await db.query('update users set enabled=false where id=$1', [actors.get('alice')!.user.id]);
      expect((await me(key.token)).statusCode).toBe(403);
      await db.query('update users set enabled=true where id=$1', [actors.get('alice')!.user.id]);
      await db.query(
        'delete from repository_grants where repository_id=$1 and subject_or_group=$2',
        [repo, 'local:alice'],
      );
      expect((await app.inject({ url: manifestPath(), headers: auth(key.token) })).statusCode).toBe(
        403,
      );
      await db.query(
        "insert into repository_grants(repository_id,subject_or_group,role) values($1,'local:alice','reviewer')",
        [repo],
      );
    });
    it('ignores development-user fallback for bearer requests even when keys are disabled', async () => {
      const dev = Fastify();
      const development = loadConfig({
        DATABASE_URL: databaseUrl!,
        AUTH_MODE: 'development',
        DEV_USER_ROLE: 'administrator',
      });
      await registerAuthentication(dev, development, db);
      dev.get('/fixture', { preHandler: requireUser }, async (request) => ({
        id: request.user!.id,
      }));
      try {
        expect(
          (await dev.inject({ url: '/fixture', headers: { authorization: 'Bearer invalid' } }))
            .statusCode,
        ).toBe(401);
        expect((await dev.inject({ url: '/fixture' })).statusCode).toBe(200);
      } finally {
        await dev.close();
      }
    });
  });
