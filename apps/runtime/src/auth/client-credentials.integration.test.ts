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
import { registerReviewCriteriaRoutes } from '../routes/review-criteria.js';
import { reviewSubmission, reviewSubmissionStatus } from '@gcr/client-contract';
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
      app.post(
        '/api/v1/repositories/:repoId/remote-model-fixture',
        {
          preHandler: requireUser,
          config: { clientModelInvoke: true },
        },
        async (request: FastifyRequest) => {
          if (!request.clientPrincipal)
            throw new ClientCredentialError(401, 'CLIENT_AUTHENTICATION_REQUIRED');
          return { admitted: true, repositoryIds: request.clientPrincipal.repositoryIds };
        },
      );
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
    it('requires explicit model scope and a current reviewer grant, including after key issuance', async () => {
      const url = `/api/v1/repositories/${repo}/remote-model-fixture`;
      const readKey = await issue();
      expect(
        (await app.inject({ method: 'POST', url, headers: auth(readKey.token) })).statusCode,
      ).toBe(403);
      const key = await issue('alice', { scopes: ['knowledge:read', 'ai:invoke'] });
      expect((await app.inject({ method: 'POST', url, headers: auth(key.token) })).json()).toEqual({
        admitted: true,
        repositoryIds: [repo],
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { ...auth(key.token), origin: 'https://attacker.invalid' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ method: 'POST', url, headers: { authorization: 'Bearer invalid' } }))
          .statusCode,
      ).toBe(401);
      expect((await app.inject({ method: 'POST', url, headers: web() })).statusCode).toBe(401);
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
            method: 'POST',
            url: `/api/v1/repositories/${otherRepo}/remote-model-fixture`,
            headers: auth(key.token),
          })
        ).statusCode,
      ).toBe(403);
      const subject = actors.get('alice')!.user.subject;
      await db.query(
        "update repository_grants set role='viewer' where repository_id=$1 and subject_or_group=$2",
        [repo, subject],
      );
      try {
        expect(
          (await app.inject({ method: 'POST', url, headers: auth(key.token) })).statusCode,
        ).toBe(403);
        expect((await me(key.token)).statusCode).toBe(200);
        const denied = await app.inject({
          method: 'POST',
          url: '/api/v1/me/client-credentials',
          headers: web(),
          payload: { ...scope(), scopes: ['knowledge:read', 'ai:invoke'] },
        });
        expect(denied.statusCode, denied.body).toBe(403);
      } finally {
        await db.query(
          "update repository_grants set role='reviewer' where repository_id=$1 and subject_or_group=$2",
          [repo, subject],
        );
      }
      await db.query('update client_api_keys set revoked_at=clock_timestamp() where id=$1', [
        key.id,
      ]);
      expect((await app.inject({ method: 'POST', url, headers: auth(key.token) })).statusCode).toBe(
        403,
      );
      expect((await me(readKey.token)).json().scopes).toEqual(['knowledge:read']);
    });
    it('accepts an effective reviewer group but does not let a viewer group invoke models', async () => {
      const actor = actors.get('alice')!.user;
      await db.query(
        "update repository_grants set role='viewer' where repository_id=$1 and subject_or_group=$2",
        [repo, actor.subject],
      );
      await db.query('update users set groups_json=\'["remote-fixture"]\'::jsonb where id=$1', [
        actor.id,
      ]);
      await db.query(
        "insert into repository_grants(repository_id,subject_or_group,role) values($1,'group:remote-fixture','reviewer')",
        [repo],
      );
      try {
        const key = await issue('alice', {
          scopes: ['knowledge:read', 'reviews:submit', 'feedback:submit', 'ai:invoke'],
        });
        const url = `/api/v1/repositories/${repo}/remote-model-fixture`;
        expect(
          (await app.inject({ method: 'POST', url, headers: auth(key.token) })).statusCode,
        ).toBe(200);
        await db.query(
          "update repository_grants set role='viewer' where repository_id=$1 and subject_or_group='group:remote-fixture'",
          [repo],
        );
        expect(
          (await app.inject({ method: 'POST', url, headers: auth(key.token) })).statusCode,
        ).toBe(403);
      } finally {
        await db.query(
          "delete from repository_grants where repository_id=$1 and subject_or_group='group:remote-fixture'",
          [repo],
        );
        await db.query("update users set groups_json='[]'::jsonb where id=$1", [actor.id]);
        await db.query(
          "update repository_grants set role='reviewer' where repository_id=$1 and subject_or_group=$2",
          [repo, actor.subject],
        );
      }
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
    it('requires separate write scopes, preserves idempotency and never admits private report fields', async () => {
      const reader = await issue();
      const feedbackKey = await issue('alice', { scopes: ['knowledge:read', 'feedback:submit'] });
      const input = reviewSubmission({
        schemaVersion: 1,
        id: randomUUID(),
        audience: {
          serverId,
          tenantId: tenant,
          repositoryId: repo,
          userId: actors.get('alice')!.user.id,
        },
        clientId: 'commit-defender',
        approvedAt: new Date().toISOString(),
        visibility: 'repository-reviewers',
        kind: 'feedback',
        review: {
          runId: randomUUID(),
          mode: 'standalone',
          sourceHash: hash('source'),
          contextHash: hash('context'),
          snapshot: null,
        },
        feedback: {
          kind: 'judgment',
          message: 'User-selected synthetic judgment',
          findingId: null,
          rule: null,
          source: null,
        },
      });
      if (input.kind !== 'feedback') throw Error('Expected feedback fixture');
      const url = `/api/v1/repositories/${repo}/review-submissions/feedback`;
      const send = (payload: unknown, token = feedbackKey.token) =>
        app.inject({ method: 'POST', url, headers: auth(token), payload });
      expect((await send(input, reader.token)).statusCode).toBe(403);
      for (const headers of [
        { ...auth(feedbackKey.token), origin: 'https://untrusted.invalid' },
        { cookie: actors.get('alice')!.cookie },
      ]) {
        const response = await app.inject({ method: 'POST', url, headers, payload: input });
        expect(response.statusCode).toBe(403);
        expect(response.json().error.code).toBe('INVALID_ORIGIN');
      }
      expect(
        (await app.inject({ method: 'POST', url, headers: auth('invalid'), payload: input }))
          .statusCode,
      ).toBe(401);
      const unmarked = await app.inject({
        method: 'POST',
        url: '/api/v1/model-fixture',
        headers: auth(feedbackKey.token),
      });
      expect(unmarked.statusCode).toBe(403);
      expect(unmarked.json().error.code).toBe('INVALID_ORIGIN');

      expect(
        (await app.inject({ method: 'POST', url, headers: web(), payload: input })).statusCode,
      ).toBe(401);
      for (const extra of [
        { chat: 'PRIVATE_CHAT_CANARY' },
        { memory: 'PRIVATE_MEMORY_CANARY' },
        { report: { summary: 'PRIVATE_REPORT_CANARY' } },
        { source: 'PRIVATE_SOURCE_CANARY' },
      ])
        expect((await send({ ...input, ...extra })).statusCode).toBe(400);
      const first = await send(input);
      expect(first.statusCode, first.body).toBe(201);
      expect(first.json()).toMatchObject({
        status: 'submitted',
        evidence: 'client-reported',
        kind: 'feedback',
      });
      const again = await send(input);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toEqual(first.json());
      const concurrentKey = await issue('alice', { scopes: ['knowledge:read', 'feedback:submit'] });
      const parallel = { ...input, id: randomUUID() };
      const pair = await Promise.all([send(parallel), send(parallel, concurrentKey.token)]);
      for (const response of pair) expect([200, 201, 409]).toContain(response.statusCode);
      expect((await send(parallel)).statusCode).toBe(200);
      expect(
        (
          await db.query('select id from client_review_submissions where request_id=$1', [
            parallel.id,
          ])
        ).rowCount,
      ).toBe(1);
      await db.query('delete from client_review_submissions where request_id=$1', [parallel.id]);

      expect(
        (await send({ ...input, feedback: { ...input.feedback, message: 'changed' } })).statusCode,
      ).toBe(409);
      expect(
        (
          await send({
            ...input,
            id: randomUUID(),
            audience: { ...input.audience, userId: actors.get('bob')!.user.id },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await send({
            ...input,
            id: randomUUID(),
            audience: { ...input.audience, repositoryId: secondRepo },
          })
        ).statusCode,
      ).toBe(403);
      const payloads = (
        await db.query('select payload from client_review_submissions where request_id=$1', [
          input.id,
        ])
      ).rows;
      expect(payloads).toHaveLength(1);
      expect(JSON.stringify(payloads)).not.toContain('PRIVATE_');
      expect(
        (
          await app.inject({
            url: `/api/v1/repositories/${repo}/review-submissions`,
            headers: web(),
          })
        ).json().items,
      ).toHaveLength(1);
      expect(
        (
          await app.inject({
            url: `/api/v1/repositories/${repo}/review-submissions`,
            headers: web('outsider'),
          })
        ).statusCode,
      ).toBe(404);
      const result = {
        ...input,
        id: randomUUID(),
        kind: 'result',
        feedback: undefined,
        result: { status: 'completed', fileCount: 1, findingCount: 2 },
      };
      Reflect.deleteProperty(result, 'feedback');
      const resultUrl = `/api/v1/repositories/${repo}/review-submissions/results`;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: resultUrl,
            headers: auth(feedbackKey.token),
            payload: result,
          })
        ).statusCode,
      ).toBe(403);
      const resultKey = await issue('alice', { scopes: ['knowledge:read', 'reviews:submit'] });
      const submitted = await app.inject({
        method: 'POST',
        url: resultUrl,
        headers: auth(resultKey.token),
        payload: result,
      });
      expect(submitted.statusCode, submitted.body).toBe(201);
      await db.query('update client_api_keys set revoked_at=clock_timestamp() where id=$1', [
        feedbackKey.id,
      ]);
      expect((await send(input)).statusCode).toBe(403);
      const replacement = await issue('alice', { scopes: ['knowledge:read', 'feedback:submit'] });
      expect((await send(input, replacement.token)).json()).toEqual(first.json());
      const transport = new KnowledgeHttpTransport(
        new TrustedCentralBinding({
          serverUrl: origin,
          audience: input.audience,
          trustedKeys: new Map([[signer.keyId, signer.publicKeyPem]]),
          allowLoopbackHttp: true,
        }),
        {
          bindingId: new TrustedCentralBinding({
            serverUrl: origin,
            audience: input.audience,
            trustedKeys: new Map([[signer.keyId, signer.publicKeyPem]]),
            allowLoopbackHttp: true,
          }).id,
          readToken: async () => replacement.token,
        },
      );
      expect(await transport.submitReview(input, new AbortController().signal)).toEqual(
        first.json(),
      );
      await db.query(
        "update client_review_submissions set expires_at=clock_timestamp()-interval '1 second' where request_id=$1",
        [input.id],
      );
      expect((await send(input, replacement.token)).statusCode).toBe(410);
      expect(
        (
          await app.inject({
            url: `/api/v1/repositories/${repo}/review-submissions`,
            headers: web(),
          })
        ).json().items,
      ).toHaveLength(1);
      await db.query('delete from client_review_submissions where expires_at<=clock_timestamp()');
      expect(
        (await db.query('select id from client_review_submissions where request_id=$1', [input.id]))
          .rowCount,
      ).toBe(0);
    });
    it('returns only the bound submitter status across adoption, exception approval, revocation and expiry', async () => {
      const writer = await issue('alice', { scopes: ['knowledge:read', 'feedback:submit'] });
      const reader = await issue('alice');
      const otherClient = await issue('alice', { clientId: 'gcr-cli' });
      const bob = await issue('bob');
      const base = `/api/v1/repositories/${repo}/review-submissions`;
      const submit = async (kind: 'judgment' | 'exception') => {
        const response = await app.inject({
          method: 'POST',
          url: base + '/feedback',
          headers: auth(writer.token),
          payload: {
            schemaVersion: 1,
            id: randomUUID(),
            audience: {
              serverId,
              tenantId: tenant,
              repositoryId: repo,
              userId: actors.get('alice')!.user.id,
            },
            clientId: 'commit-defender',
            approvedAt: new Date().toISOString(),
            visibility: 'repository-reviewers',
            kind: 'feedback',
            review: {
              runId: randomUUID(),
              mode: 'standalone',
              sourceHash: hash('status-source'),
              contextHash: hash('status-context'),
              snapshot: null,
            },
            feedback: {
              kind,
              message: 'EXPLICIT_PAYLOAD_NOT_RETURNED_IN_STATUS',
              findingId: null,
              rule: null,
              source: null,
            },
          },
        });
        expect(response.statusCode, response.body).toBe(201);
        return response.json();
      };
      const receipt = await submit('judgment');
      const status = (id = receipt.id, token = reader.token, repository = repo) =>
        app.inject({
          url: `/api/v1/repositories/${repository}/review-submissions/${id}/status`,
          headers: auth(token),
        });
      expect(
        (await app.inject({ url: base + '/' + receipt.id + '/status', headers: web() })).statusCode,
      ).toBe(401);
      expect((await status(receipt.id, bob.token)).statusCode).toBe(404);
      expect((await status(receipt.id, otherClient.token)).statusCode).toBe(404);
      const second = await issue('alice', { repositoryIds: [secondRepo] });
      expect((await status(receipt.id, second.token, secondRepo)).statusCode).toBe(404);
      const pending = await status();
      expect(pending.statusCode, pending.body).toBe(200);
      expect(pending.headers['cache-control']).toBe('private, no-store');
      expect(reviewSubmissionStatus(pending.json()).decision).toBeNull();
      expect(pending.body).not.toContain('EXPLICIT_PAYLOAD_NOT_RETURNED_IN_STATUS');
      await db.query(
        "insert into review_criteria_roles(repository_id,user_id,role,granted_by) values($1,$2,'maintainer',$2)",
        [repo, actors.get('alice')!.user.id],
      );
      await db.query(
        "insert into review_criteria_roles(repository_id,user_id,role,granted_by) values($1,$2,'domain-owner',$2)",
        [repo, actors.get('bob')!.user.id],
      );
      const post = async (url: string, payload: unknown, actor = 'alice', expected = 200) => {
        const r = await app.inject({ method: 'POST', url, headers: web(actor), payload });
        expect(r.statusCode, r.body).toBe(expected);
        return r.json();
      };
      const adoption = await post(base + '/' + receipt.id + '/review', {
        expectedPayloadHash: receipt.payloadHash,
        note: 'Reviewed visible feedback',
        action: 'create-candidate',
        document: {
          title: 'Status criterion',
          topicKey: 'status',
          requirement: 'Separate tenant cache keys.',
          rationale: 'Avoid another tenant value.',
          severity: 'P2',
          counterEvidence: ['Separate cache instances.'],
          reviewSteps: ['Inspect caller.'],
          appliesTo: { filePaths: ['cache.py'] },
        },
        outcome: 'defect',
        reasoning: 'Synthetic review.',
      });
      const criteria = `/api/v1/repositories/${repo}/review-criteria/${adoption.decision.ruleId}`;
      let detail = (await app.inject({ url: criteria, headers: web() })).json();
      expect(reviewSubmissionStatus((await status()).json()).decision?.rule).toMatchObject({
        state: 'draft',
        revision: 1,
        contentHash: detail.criterion.contentHash,
      });
      detail = await post(
        criteria + '/evaluations',
        {
          expectedVersion: detail.criterion.version,
          note: 'Manual synthetic cases.',
          cases: ['defect', 'fixed', 'normal', 'counter-evidence'].map((kind) => ({
            kind,
            name: kind,
            source: 'cache[key]',
            observed: kind === 'defect' ? 'finding' : 'clear',
            evidence: 'Synthetic manual observation.',
          })),
        },
        'alice',
        201,
      );
      for (const action of ['evaluate', 'shadow', 'activate'])
        detail = await post(criteria + '/actions', {
          expectedVersion: detail.criterion.version,
          action,
          note: 'Synthetic transition.',
        });
      expect(reviewSubmissionStatus((await status()).json()).decision?.rule?.state).toBe('active');
      const exception = await submit('exception');
      const linked = await post(base + '/' + exception.id + '/review', {
        expectedPayloadHash: exception.payloadHash,
        note: 'Review exception scope.',
        action: 'link-feedback',
        ruleId: detail.criterion.id,
        expectedVersion: detail.criterion.version,
        exceptionTerms: {
          appliesTo: { filePaths: ['legacy/cache.py'] },
          startsAt: new Date(Date.now() - 1000).toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      });
      expect(
        reviewSubmissionStatus((await status(exception.id)).json()).decision?.feedback?.resolution,
      ).toBeNull();
      detail = (await app.inject({ url: criteria, headers: web() })).json();
      await post(
        criteria + '/feedback/' + linked.decision.feedbackId + '/resolution',
        {
          expectedVersion: detail.criterion.version,
          action: 'approve-exception',
          note: 'Independent owner approval.',
        },
        'bob',
      );
      const approved = reviewSubmissionStatus((await status(exception.id)).json());
      expect(approved.decision?.feedback?.resolution?.action).toBe('approve-exception');
      expect(approved.decision?.feedback?.exception?.revoked).toBe(false);
      detail = (await app.inject({ url: criteria, headers: web() })).json();
      await post(
        criteria + '/exceptions/' + approved.decision!.feedback!.exception!.id + '/revocation',
        { expectedVersion: detail.criterion.version, note: 'Exception no longer applies.' },
        'bob',
      );
      expect(
        reviewSubmissionStatus((await status(exception.id)).json()).decision?.feedback?.exception
          ?.revoked,
      ).toBe(true);
      await db.query(
        "update client_review_submissions set expires_at=clock_timestamp()-interval '1 second' where id=$1",
        [receipt.id],
      );
      expect((await status()).statusCode).toBe(410);
      await db.query('delete from client_review_submissions where id=any($1::uuid[])', [
        [receipt.id, exception.id],
      ]);
      expect((await status()).statusCode).toBe(404);
      await db.query('update client_api_keys set revoked_at=clock_timestamp() where id=$1', [
        reader.id,
      ]);
      expect((await status()).statusCode).toBe(403);
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
      const key = await issue('bob');
      const c = await db.connect();
      try {
        await c.query('begin');
        await revokeUserClientCredentials(c, actors.get('bob')!.user.id);
        await c.query('commit');
      } finally {
        c.release();
      }
      expect((await me(key.token)).statusCode).toBe(403);
      const local = await issue('bob');
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
      const key = await issue();
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
