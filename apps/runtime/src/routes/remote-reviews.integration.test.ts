import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { FilesystemArtifactStore } from '@gcr/artifact-store';
import { executeRemoteReviewJob } from '../services/remote-review-worker.js';
import { runWorker } from '../jobs/worker.js';
import { resolveChatAccountSelection } from '../services/account-registry.js';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { clientReviewReport, type RemoteReviewPayload } from '@gcr/client-contract';
import {
  builtinReviewSkill,
  TrustedCentralBinding,
  KnowledgeHttpTransport,
  prepareRemoteReviewHandle,
  RemoteReviewDeliveryError,
  canonicalJson,
  contentHash,
  remoteReviewContextHash,
  restoreRemoteReviewContext,
  restoreRemoteReviewSource,
} from '@gcr/client-core';
import { loadConfig, type AppConfig } from '../config.js';
import { registerAuthentication, type AuthUser } from '../auth/index.js';
import { registerMutationOriginGuard } from '../auth/mutation-origin.js';
import { issueClientKey } from '../auth/client-credentials.js';
import { AuthorizationService } from '../services/authorization.js';
import { decryptCredential, encryptCredential } from '../services/credential-crypto.js';
import {
  expireRemoteReviewJobs,
  remoteReviewEncryptionPurpose,
} from '../services/remote-review-jobs.js';
import { registerRemoteReviewRoutes } from './remote-reviews.js';
import {
  claimRemoteReviewJob,
  completeRemoteReviewJob,
  deferRemoteReviewJob,
  fenceRemoteReviewInvocation,
  heartbeatRemoteReviewJob,
  loadRemoteReviewPayload,
  recoverRemoteReviewLeases,
} from '../services/remote-review-execution.js';
import { admittedFetch, ModelCapacityError, withModelBudget } from '../services/model-admission.js';
import { centralReviewExecutorConfigHash } from '../services/central-review-executor.js';

const databaseUrl = process.env.GCR_TEST_DATABASE_URL;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
describe.skipIf(!databaseUrl).sequential('durable remote review HTTP admission', () => {
  const schema = `gcr_remote_${randomUUID().replaceAll('-', '')}`;
  const serverId = randomUUID(),
    encryptionKey = randomBytes(32).toString('base64');
  let root: Database, db: Database, app: ReturnType<typeof Fastify>, config: AppConfig;
  let tenant: string, repo: string, otherRepo: string, account: string;
  let authorization: AuthorizationService;
  let beforeAdmission: (() => Promise<void>) | undefined;
  let origin: string;
  let holdReceipt: (() => Promise<void>) | undefined;
  const users = new Map<string, { user: AuthUser; session: string }>();
  const base = () => `/api/v1/repositories/${repo}/remote-reviews`;
  const headers = (token: string) => ({
    authorization: `Bearer ${token}`,
    'x-gcr-server-id': serverId,
  });
  const key = async (
    name = 'alice',
    scopes = ['knowledge:read', 'ai:invoke'],
    repository = repo,
  ) => {
    const actor = users.get(name)!;
    return issueClientKey(db, {
      user: actor.user,
      sessionToken: actor.session,
      serverId,
      authMode: 'local',
      requestId: randomUUID(),
      input: {
        name: 'Synthetic fixture',
        clientId: 'commit-defender',
        tenantId: tenant,
        repositoryIds: [repository],
        scopes,
        lifetimeDays: 30,
      },
    });
  };
  const input = (name = 'alice', repository = repo) => {
    const text = 'export const reviewed = "synthetic-source-only";\n';
    const payload: RemoteReviewPayload = {
      schemaVersion: 1,
      requestId: randomUUID(),
      executor: 'central',
      clientId: 'commit-defender',
      audience: {
        serverId,
        tenantId: tenant,
        repositoryId: repository,
        userId: users.get(name)!.user.id,
      },
      client: {
        mode: 'standalone',
        profileId: 'test',
        repositoryKey: 'a'.repeat(64),
        worktreeKey: 'b'.repeat(64),
      },
      model: { accountId: account, name: 'gpt-6-astra', reasoningEffort: 'xhigh' },
      source: {
        provenance: 'client-captured',
        snapshot: {
          kind: 'working-tree',
          hash: 'c'.repeat(64),
          objectFormat: 'sha1',
          baseCommit: null,
          baseTree: 'd'.repeat(40),
        },
        files: [
          {
            metadata: {
              path: 'app.ts',
              side: 'source',
              hash: hash(text),
              byteLength: Buffer.byteLength(text),
              lineCount: 2,
            },
            text,
          },
        ],
        selected: [{ path: 'app.ts', side: 'source' }],
        review: {
          changes: [{ path: 'app.ts', side: 'source', status: 'A', base: 'absent' }],
          incomplete: false,
        },
      },
      context: { provenance: 'client-supplied', documents: [] },
      budget: {
        modelCalls: 2,
        durationMs: 120000,
        sourceBytes: 1048576,
        toolCalls: 100,
      },
      retention: { sourceSeconds: 3600, resultSeconds: 86400 },
    };
    payload.context.resolved = {
      version: 1,
      client: payload.client,
      sourceHash: payload.source.snapshot.hash,
      originalContextHash: hash('original-context'),
      builtin: {
        id: builtinReviewSkill.id,
        revision: builtinReviewSkill.revision,
        hash: builtinReviewSkill.hash,
      },
      knowledge: [],
      requiredSources: [{ path: 'app.ts', side: 'source' }],
      validUntil: null,
    };
    return {
      payload,
      approval: { payloadHash: contentHash(payload), approvedAt: new Date().toISOString() },
    };
  };
  const reportFor = (body: ReturnType<typeof input>) => {
    const source = body.payload.source.files[0]!.metadata,
      at = new Date().toISOString();
    return clientReviewReport({
      contractVersion: 1,
      runId: randomUUID(),
      identity: {
        client: body.payload.client,
        source: body.payload.source.snapshot,
        context: { hash: remoteReviewContextHash(body.payload), entries: [], required: [] },
        reviewProfile: { id: 'fixture', revision: 1, hash: hash('profile') },
        executor: {
          id: 'central',
          version: 'fixture',
          model: 'gpt-6-astra',
          configHash: centralReviewExecutorConfigHash(
            body.payload.model,
            body.payload.budget.modelCalls,
          ),
        },
        toolsHash: hash('tools'),
      },
      status: 'completed',
      trigger: 'manual',
      requestedAt: at,
      startedAt: at,
      finishedAt: at,
      durationMs: 0,
      summary: 'Synthetic result fixture',
      sourceFiles: [source],
      files: [{ source, status: 'completed', summary: 'Synthetic coverage' }],
      excluded: [],
      problems: [],
      findings: [],
      evidence: [],
      questions: [],
    });
  };
  const approve = (value: ReturnType<typeof input>) => {
    value.approval.payloadHash = contentHash(value.payload);
    return value;
  };
  const submit = (token: string, body = input(), repository = repo) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/repositories/${repository}/remote-reviews`,
      headers: headers(token),
      payload: body,
    });
  const get = (token: string, value: ReturnType<typeof input>, kind = 'status') =>
    app.inject({
      url: `${base()}/${value.payload.requestId}/${kind}`,
      headers: headers(token),
    });
  const cancel = (token: string, value: ReturnType<typeof input>) =>
    app.inject({
      method: 'POST',
      url: `${base()}/${value.payload.requestId}/cancel`,
      headers: headers(token),
      payload: {
        schemaVersion: 1,
        requestId: value.payload.requestId,
        payloadHash: value.approval.payloadHash,
      },
    });
  const event = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
  const completeStream = (text: string) =>
    event({ type: 'response.output_text.delta', delta: text }) +
    event({ type: 'response.completed', response: {} });
  async function providerFixture(
    handler: (
      body: { input: Record<string, unknown>[]; model: string; reasoning: { effort: string } },
      reply: FastifyReply,
    ) => Promise<unknown>,
  ) {
    const directory = await mkdtemp(path.join(tmpdir(), 'gcr-remote-worker-'));
    const provider = Fastify();
    const requests: unknown[] = [];
    provider.post('/responses', async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as Parameters<typeof handler>[0];
      requests.push(body);
      reply.type('text/event-stream');
      return handler(body, reply);
    });
    const endpoint = await provider.listen({ host: '127.0.0.1', port: 0 });
    const upstream = randomUUID();
    const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.synthetic`;
    const auth = encryptCredential(
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: token,
          refresh_token: 'synthetic-never-refreshed',
          account_id: upstream,
        },
        last_refresh: new Date().toISOString(),
      }),
      encryptionKey,
      'chat-account',
    );
    await db.query(
      'update chat_accounts set endpoint=$1,credential_ciphertext=$2,credential_iv=$3,credential_auth_tag=$4 where id=$5',
      [
        endpoint + '/',
        auth.credentialCiphertext,
        auth.credentialIv,
        auth.credentialAuthTag,
        account,
      ],
    );
    return {
      requests,
      quota: hash(`chatgpt:${upstream}`),
      artifacts: new FilesystemArtifactStore(directory),
      settings: {
        ...config,
        WORKSPACE_ROOT: path.join(directory, 'work'),
        ARTIFACT_ROOT: directory,
        HOST: '127.0.0.1',
        WORKER_HEALTH_PORT: 0,
        GITHUB_MODE: 'disabled' as const,
        KNOWLEDGE_PUBLICATION_ENABLED: false,
        CHAT_AGENT_ENABLED: false,
        WORKER_CONCURRENCY: 1,
      },
      async close() {
        await provider.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const reviewHandler: Parameters<typeof providerFixture>[0] = async (body) => {
    expect(body.model).toBe('gpt-6-astra');
    expect(body.reasoning.effort).toBe('xhigh');
    const output = body.input.find((item) => item.type === 'function_call_output');
    if (!output)
      return (
        event({
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            call_id: 'source-read',
            name: 'read_file',
            arguments: '{"path":"app.ts"}',
          },
        }) + event({ type: 'response.completed', response: {} })
      );
    const read = JSON.parse(String(output.output));
    expect(read.text).toContain('synthetic-source-only');
    return completeStream(
      JSON.stringify({
        summary: 'Synthetic registered-provider review',
        files: [
          {
            path: 'app.ts',
            side: 'source',
            complete: true,
            summary: 'Read approved bytes',
            readIds: [read.readId],
          },
        ],
        findings: [],
        questions: [],
      }),
    );
  };
  async function until(check: () => Promise<boolean> | boolean) {
    const deadline = Date.now() + 10000;
    while (!(await check())) {
      if (Date.now() > deadline) throw Error('Fixture observation timeout');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw Error('Owned local fixture only');
    root = createDatabase(url.href);
    await root.query(`create schema ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    db = createDatabase(url.href);
    await runMigrations(db, path.resolve('packages/db/migrations'));
    config = loadConfig({
      DATABASE_URL: url.href,
      NODE_ENV: 'test',
      AUTH_MODE: 'local',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      CLIENT_API_KEYS_ENABLED: 'true',
      KNOWLEDGE_PUBLICATION_ENABLED: 'true',
      KNOWLEDGE_DISTRIBUTION_ENABLED: 'true',
      KNOWLEDGE_SERVER_ID: serverId,
      KNOWLEDGE_SIGNING_KEY_ID: 'fixture',
      KNOWLEDGE_SIGNING_KEY_FILE: '/synthetic-not-read',
      LOCAL_BOOTSTRAP_ADMIN_USERNAME: 'fixture-admin',
      LOCAL_BOOTSTRAP_ADMIN_PASSWORD: 'Synthetic-password-2026!',
      CREDENTIAL_REGISTRY_ENABLED: 'true',
      CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
      MODEL_ADMISSION_ENABLED: 'true',
      REMOTE_REVIEWS_ENABLED: 'true',
    });
    tenant = (
      await db.query(
        "insert into tenants(slug,display_name) values('remote-test','Remote test') returning id",
      )
    ).rows[0].id;
    const instance = (
      await db.query(
        "insert into github_instances(name,api_base_url,web_base_url) values('fixture','https://fixture.invalid/api','https://fixture.invalid') returning id",
      )
    ).rows[0].id;
    const repository = async (id: string) =>
      (
        await db.query(
          "insert into repositories(tenant_id,instance_id,github_id,installation_id,owner,name,polling_enabled) values($1,$2,$3::bigint,'1','fixture',$3::text,false) returning id",
          [tenant, instance, id],
        )
      ).rows[0].id;
    repo = await repository('1');
    otherRepo = await repository('2');
    for (const name of ['alice', 'bob']) {
      const subject = `local:${name}`;
      const id = (
        await db.query(
          "insert into users(oidc_subject,display_name,role) values($1,$1,'reviewer') returning id",
          [subject],
        )
      ).rows[0].id;
      await db.query('insert into tenant_memberships(tenant_id,user_id) values($1,$2)', [
        tenant,
        id,
      ]);
      for (const repository of [repo, otherRepo])
        await db.query(
          "insert into repository_grants(repository_id,subject_or_group,role) values($1,$2,'reviewer')",
          [repository, subject],
        );
      await db.query(
        'insert into local_credentials(user_id,username,password_hash) values($1,$2,$3)',
        [id, name, 'unused-synthetic-hash'],
      );
      const session = randomBytes(32).toString('base64url');
      await db.query(
        "insert into user_sessions(id_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 hour')",
        [hash(session), id],
      );
      users.set(name, {
        session,
        user: {
          id,
          subject,
          displayName: name,
          role: 'reviewer',
          groups: [],
          enabled: true,
          tenantIds: [tenant],
          tenants: [],
        },
      });
    }
    const encrypted = encryptCredential(
      'synthetic-account-never-used-for-model',
      encryptionKey,
      'fixture',
    );
    account = (
      await db.query(
        `insert into chat_accounts(display_name,provider_type,credential_ciphertext,credential_iv,credential_auth_tag,credential_fingerprint,created_by)
      values('Fixture central account','chatgpt-account',$1,$2,$3,$4,$5) returning id`,
        [
          encrypted.credentialCiphertext,
          encrypted.credentialIv,
          encrypted.credentialAuthTag,
          hash('fixture'),
          users.get('alice')!.user.id,
        ],
      )
    ).rows[0].id;
    await db.query(
      "insert into chat_account_models(account_id,model_id,display_name,allowed_efforts,default_effort) values($1,'gpt-6-astra','Astra',array['high','xhigh'],'xhigh')",
      [account],
    );
    for (const actor of users.values())
      await db.query(
        "insert into chat_account_assignments(account_id,scope_type,scope_id,created_by) values($1,'user',($2::uuid)::text,$2::uuid)",
        [account, actor.user.id],
      );
    app = Fastify();
    app.addHook(
      'onSend',
      async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
        if (
          request.method === 'POST' &&
          request.url.endsWith('/remote-reviews') &&
          reply.statusCode === 201 &&
          holdReceipt
        ) {
          const wait = holdReceipt;
          holdReceipt = undefined;
          await wait();
        }
        return payload;
      },
    );
    registerMutationOriginGuard(app, { ...config, NODE_ENV: 'production' });
    await registerAuthentication(app, config, db);
    app.addHook('preHandler', async (request: FastifyRequest) => {
      if (request.method === 'POST' && request.url.endsWith('/remote-reviews') && beforeAdmission) {
        const action = beforeAdmission;
        beforeAdmission = undefined;
        await action();
      }
    });
    authorization = new AuthorizationService(config);
    await registerRemoteReviewRoutes(app, db, config, authorization);
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
  }, 30000);
  beforeEach(async () => {
    beforeAdmission = undefined;
    holdReceipt = undefined;
    await db.query('delete from client_review_jobs');
    await db.query('delete from client_api_keys');
    config.REMOTE_REVIEWS_ENABLED = true;
    config.REMOTE_REVIEW_USER_HOURLY_CALLS = 60;
    config.REMOTE_REVIEW_REPOSITORY_HOURLY_CALLS = 300;
    await db.query('update chat_account_assignments set enabled=true');
    await db.query('update chat_accounts set enabled=true,deleted_at=null');
    await db.query('update chat_account_models set enabled=true');
  });
  afterAll(async () => {
    await app?.close();
    await db?.end();
    if (root) {
      await root.query(`drop schema ${schema} cascade`);
      await root.end();
    }
  });
  it('lists only currently authorized central model metadata without admitting or invoking a job', async () => {
    const auth = await key(),
      body = input();
    const binding = new TrustedCentralBinding({
      serverUrl: origin,
      allowLoopbackHttp: true,
      audience: body.payload.audience,
      trustedKeys: new Map([['fixture', generateKeyPairSync('ed25519').publicKey]]),
    });
    const client = new KnowledgeHttpTransport(binding, {
      bindingId: binding.id,
      readToken: async () => auth.token,
    });
    const result = await client.remoteReviewModels('commit-defender', new AbortController().signal);
    expect(result).toMatchObject({
      enabled: true,
      outputTokenLimit: false,
      models: [{ accountId: account, name: 'gpt-6-astra', allowedEfforts: ['high', 'xhigh'] }],
    });
    expect(JSON.stringify(result)).not.toContain('credential');
    expect((await db.query('select count(*) from client_review_jobs')).rows[0].count).toBe('0');
    expect((await db.query('select count(*) from model_request_ledger')).rows[0].count).toBe('0');
    const readOnly = await key('alice', ['knowledge:read']);
    expect(
      (await app.inject({ url: `${base()}/models`, headers: headers(readOnly.token) })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: `/api/v1/repositories/${otherRepo}/remote-reviews/models`,
          headers: headers(auth.token),
        })
      ).statusCode,
    ).toBe(403);
    await db.query('update chat_account_assignments set enabled=false where scope_id=$1', [
      users.get('alice')!.user.id,
    ]);
    expect(
      (await client.remoteReviewModels('commit-defender', new AbortController().signal)).models,
    ).toEqual([]);
    config.REMOTE_REVIEWS_ENABLED = false;
    expect(
      await client.remoteReviewModels('commit-defender', new AbortController().signal),
    ).toMatchObject({ enabled: false, models: [] });
  });
  it('stores encrypted source once and recovers a lost acknowledgement by client request ID after key rotation', async () => {
    const first = await key(),
      body = input();
    const response = await submit(first.token, body);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const row = (await db.query('select * from client_review_jobs')).rows[0];
    expect(JSON.stringify(row)).not.toContain('synthetic-source-only');
    expect(JSON.stringify(row)).not.toContain(first.token);
    const decoded = decryptCredential(
      {
        credentialCiphertext: row.source_ciphertext,
        credentialIv: row.source_iv,
        credentialAuthTag: row.source_tag,
      },
      encryptionKey,
      remoteReviewEncryptionPurpose(row.id, row.payload_hash, 'source'),
    );
    expect(JSON.parse(decoded)).toEqual(body.payload);
    expect(response.body).not.toContain('credential');
    expect(response.body).not.toContain('synthetic-source-only');
    await db.query('update client_api_keys set revoked_at=clock_timestamp() where id=$1', [
      first.id,
    ]);
    const replacement = await key();
    expect((await get(replacement.token, body)).json()).toEqual(response.json());
    body.approval.approvedAt = '2020-01-01T00:00:00.000Z';
    const retry = await submit(replacement.token, body);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toEqual(response.json());
    expect((await db.query('select count(*) from client_review_jobs')).rows[0].count).toBe('1');
    expect(
      (await db.query("select count(*) from audit_events where action='remote-review.submit'"))
        .rows[0].count,
    ).toBe('1');
  });
  it('rejects reusing a request ID for changed source, model, account or budget', async () => {
    const auth = await key(),
      body = input();
    expect((await submit(auth.token, body)).statusCode).toBe(201);
    for (const field of ['source', 'model', 'account', 'budget']) {
      const changed = structuredClone(body);
      if (field === 'source') {
        changed.payload.source.snapshot.hash = 'e'.repeat(64);
        changed.payload.context.resolved!.sourceHash = changed.payload.source.snapshot.hash;
      }
      if (field === 'model') changed.payload.model.reasoningEffort = 'high';
      if (field === 'account') changed.payload.model.accountId = randomUUID();
      if (field === 'budget') changed.payload.budget.modelCalls++;
      expect((await submit(auth.token, approve(changed))).statusCode).toBe(409);
    }
  });
  it('recovers a committed job after the native HTTP caller disconnects before receiving its receipt', async () => {
    const auth = await key(),
      body = input(),
      controller = new AbortController();
    let accepted!: () => void, release!: () => void;
    const committed = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const sending = new Promise<void>((resolve) => {
      release = resolve;
    });
    holdReceipt = async () => {
      accepted();
      await sending;
    };
    try {
      const disconnected = fetch(`${origin}${base()}`, {
        method: 'POST',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
        headers: { ...headers(auth.token), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(
        () => false,
        () => true,
      );
      await Promise.race([
        committed,
        disconnected.then(() => {
          throw Error('Request did not reach receipt barrier');
        }),
      ]);
      controller.abort();
      expect(await disconnected).toBe(true);
      release();
      const status = await fetch(`${origin}${base()}/${body.payload.requestId}/status`, {
        headers: headers(auth.token),
      });
      expect(status.status).toBe(200);
      expect(((await status.json()) as { state: string }).state).toBe('queued');
      const retry = await fetch(`${origin}${base()}`, {
        method: 'POST',
        headers: { ...headers(auth.token), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(retry.status).toBe(200);
      await retry.arrayBuffer();
      expect(
        (
          await db.query(
            'select count(*),sum(reserved_model_calls) as calls from client_review_jobs',
          )
        ).rows[0],
      ).toEqual({ count: '1', calls: '2' });
    } finally {
      controller.abort();
      release();
    }
  });
  it('does not double reserve simultaneous identical submissions', async () => {
    const auth = await key(),
      body = input();
    const responses = await Promise.all([submit(auth.token, body), submit(auth.token, body)]);
    expect(responses.map((response) => response.statusCode)).toContain(201);
    expect(responses.every((response) => [200, 201, 409].includes(response.statusCode))).toBe(true);
    expect((await submit(auth.token, body)).statusCode).toBe(200);
    const row = (
      await db.query('select count(*),sum(reserved_model_calls) as calls from client_review_jobs')
    ).rows[0];
    expect(row).toEqual({ count: '1', calls: '2' });
  });
  it('enforces scope, current repository access, owner, audience and client boundaries on actual routes', async () => {
    const auth = await key(),
      readOnly = await key('alice', ['knowledge:read']),
      bob = await key('bob'),
      body = input();
    expect((await submit(readOnly.token, body)).statusCode).toBe(403);
    expect((await submit(auth.token, body)).statusCode).toBe(201);
    expect((await get(readOnly.token, body)).statusCode).toBe(200);
    expect((await get(bob.token, body)).statusCode).toBe(404);
    expect((await cancel(bob.token, body)).statusCode).toBe(404);
    expect((await cancel(readOnly.token, body)).statusCode).toBe(403);
    const changed = input();
    changed.payload.audience.userId = users.get('bob')!.user.id;
    expect((await submit(auth.token, approve(changed))).statusCode).toBe(403);
    const other = await key('alice', ['knowledge:read', 'ai:invoke'], otherRepo);
    expect((await submit(other.token, input('alice', otherRepo))).statusCode).toBe(403);
    await db.query(
      "update repository_grants set role='viewer' where repository_id=$1 and subject_or_group=$2",
      [repo, users.get('alice')!.user.subject],
    );
    try {
      expect((await submit(auth.token, input())).statusCode).toBe(403);
    } finally {
      await db.query(
        "update repository_grants set role='reviewer' where repository_id=$1 and subject_or_group=$2",
        [repo, users.get('alice')!.user.subject],
      );
    }
  });
  it('checks account/model grants at admission without decrypting or invoking the account', async () => {
    const auth = await key();
    for (const table of ['chat_account_assignments', 'chat_accounts', 'chat_account_models']) {
      await db.query(`update ${table} set enabled=false`);
      expect((await submit(auth.token)).statusCode).toBe(403);
      await db.query(`update ${table} set enabled=true`);
    }
    const unsupported = input();
    unsupported.payload.model.reasoningEffort = 'low';
    expect((await submit(auth.token, approve(unsupported))).statusCode).toBe(403);
    expect((await db.query('select count(*) from client_review_jobs')).rows[0].count).toBe('0');
  });
  it('rechecks the actual key inside the write transaction after initial HTTP authentication', async () => {
    const auth = await key();
    beforeAdmission = async () => {
      await db.query('update client_api_keys set revoked_at=clock_timestamp() where id=$1', [
        auth.id,
      ]);
    };
    const response = await submit(auth.token);
    expect(response.statusCode, response.body).toBe(403);
    expect((await db.query('select count(*) from client_review_jobs')).rows[0].count).toBe('0');
  });
  it('requires an affirmative external authorization decision and fails closed on backend failure', async () => {
    const auth = await key();
    const decision = vi.spyOn(authorization, 'isAllowed').mockResolvedValue(false);
    try {
      expect((await submit(auth.token)).statusCode).toBe(403);
      expect(decision.mock.calls[0]![1]).toBe('chat');
      decision.mockRejectedValue(Error('synthetic-private-backend-diagnostic'));
      const response = await submit(auth.token);
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('synthetic-private');
      expect((await db.query('select count(*) from client_review_jobs')).rows[0].count).toBe('0');
    } finally {
      decision.mockRestore();
    }
  });
  it('rejects stale approval, modified bytes, oversized uploads and hostile browser origin', async () => {
    const auth = await key(),
      stale = input();
    stale.approval.approvedAt = '2020-01-01T00:00:00.000Z';
    expect((await submit(auth.token, stale)).statusCode).toBe(409);
    const capped = input();
    capped.payload.budget.outputTokensPerCall = 4096;
    expect((await submit(auth.token, approve(capped))).statusCode).toBe(422);
    const tampered = input();
    tampered.payload.source.files[0]!.text += 'modified';
    expect((await submit(auth.token, tampered)).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: base(),
          headers: { ...headers(auth.token), 'content-type': 'application/json' },
          payload: JSON.stringify({ oversized: 'a'.repeat(9 * 1024 * 1024) }),
        })
      ).statusCode,
    ).toBe(413);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: base(),
          headers: { ...headers(auth.token), origin: 'https://attacker.invalid' },
          payload: input(),
        })
      ).statusCode,
    ).toBe(403);
    expect((await db.query('select count(*) from client_review_jobs')).rows[0].count).toBe('0');
  });
  it('reserves a user budget across keys and repositories without refunding cancellation or charging retries', async () => {
    config.REMOTE_REVIEW_USER_HOURLY_CALLS = 2;
    const first = await key(),
      second = await key(),
      elsewhere = await key('alice', ['knowledge:read', 'ai:invoke'], otherRepo),
      body = input();
    expect((await submit(first.token, body)).statusCode).toBe(201);
    expect((await submit(second.token, body)).statusCode).toBe(200);
    expect((await cancel(first.token, body)).json().state).toBe('cancelled');
    expect((await submit(second.token)).statusCode).toBe(429);
    expect((await submit(elsewhere.token, input('alice', otherRepo), otherRepo)).statusCode).toBe(
      429,
    );
  });
  it('reserves a repository budget across users and caps active jobs', async () => {
    const alice = await key(),
      bob = await key('bob');
    config.REMOTE_REVIEW_REPOSITORY_HOURLY_CALLS = 2;
    expect((await submit(alice.token)).statusCode).toBe(201);
    expect((await submit(bob.token, input('bob'))).statusCode).toBe(429);
    config.REMOTE_REVIEW_REPOSITORY_HOURLY_CALLS = 300;
    for (let count = 1; count < 4; count++)
      expect((await submit(alice.token)).statusCode).toBe(201);
    expect((await submit(alice.token)).statusCode).toBe(429);
  });
  it('cancels a queued job idempotently, erases source, and preserves the replay fence', async () => {
    const auth = await key(),
      body = input();
    await submit(auth.token, body);
    await expect(
      db.query("update client_review_jobs set state='failed',reason=null"),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await get(auth.token, body, 'result')).statusCode).toBe(409);
    const changed = structuredClone(body);
    changed.approval.payloadHash = '0'.repeat(64);
    expect((await cancel(auth.token, changed)).statusCode).toBe(409);
    const response = await cancel(auth.token, body);
    expect(response.json().state).toBe('cancelled');
    expect((await cancel(auth.token, body)).json()).toEqual(response.json());
    expect((await submit(auth.token, body)).json().state).toBe('cancelled');
    const row = (
      await db.query('select source_ciphertext,source_iv,source_tag from client_review_jobs')
    ).rows[0];
    expect(Object.values(row)).toEqual([null, null, null]);
  });
  it('keeps running cancellation pending and marks lost execution uncertain when source expires', async () => {
    const auth = await key(),
      body = input();
    await submit(auth.token, body);
    await db.query("update client_review_jobs set state='running'");
    expect((await cancel(auth.token, body)).json().state).toBe('cancel-requested');
    await db.query(
      "update client_review_jobs set received_at=clock_timestamp()-interval '2 hours',source_expires_at=clock_timestamp()-interval '1 hour'",
    );
    expect(await expireRemoteReviewJobs(db)).toBe(1);
    const receipt = (await get(auth.token, body)).json();
    expect(receipt.state).toBe('uncertain');
    expect(receipt.reason).toBe('execution-lost');
    expect((await submit(auth.token, body)).json().state).toBe('uncertain');
  });
  it('expires queued source and retains only the receipt without allowing re-enqueue', async () => {
    const auth = await key(),
      body = input();
    await submit(auth.token, body);
    await db.query(
      "update client_review_jobs set received_at=clock_timestamp()-interval '2 hours',source_expires_at=clock_timestamp()-interval '1 hour'",
    );
    expect((await get(auth.token, body)).json().state).toBe('expired');
    expect(
      (await db.query('select source_ciphertext from client_review_jobs')).rows[0]
        .source_ciphertext,
    ).toBe(null);
    expect((await submit(auth.token, body)).json().state).toBe('expired');
  });
  it('allows receipt recovery and cancellation when new central admission is disabled', async () => {
    const auth = await key(),
      body = input();
    await submit(auth.token, body);
    config.REMOTE_REVIEWS_ENABLED = false;
    expect((await submit(auth.token)).statusCode).toBe(503);
    expect((await submit(auth.token, body)).statusCode).toBe(200);
    expect((await get(auth.token, body)).statusCode).toBe(200);
    expect((await cancel(auth.token, body)).json().state).toBe('cancelled');
  });
  it('requires approved change descriptions for new jobs while preserving legacy receipt replay', async () => {
    const auth = await key(),
      body = input();
    const legacy = structuredClone(body);
    delete legacy.payload.source.review;
    delete legacy.payload.context.resolved;
    approve(legacy);
    const noContext = structuredClone(body);
    delete noContext.payload.context.resolved;
    const contextRejected = await submit(auth.token, approve(noContext));
    expect(contextRejected.statusCode).toBe(422);
    expect(contextRejected.body).toContain('REMOTE_REVIEW_CONTEXT_REQUIRED');
    const rejected = await submit(auth.token, legacy);
    expect(rejected.statusCode).toBe(422);
    expect(rejected.body).toContain('REMOTE_REVIEW_SOURCE_DESCRIPTION_REQUIRED');
    expect((await db.query('select count(*) from client_review_jobs')).rows[0].count).toBe('0');
    await submit(auth.token, body);
    const row = (await db.query('select id from client_review_jobs')).rows[0];
    // Recreate the encrypted pre-description format, including its original approval hash.
    const encrypted = encryptCredential(
      canonicalJson(legacy.payload),
      encryptionKey,
      remoteReviewEncryptionPurpose(row.id, legacy.approval.payloadHash, 'source'),
    );
    await db.query(
      'update client_review_jobs set payload_hash=$1,source_ciphertext=$2,source_iv=$3,source_tag=$4',
      [
        legacy.approval.payloadHash,
        encrypted.credentialCiphertext,
        encrypted.credentialIv,
        encrypted.credentialAuthTag,
      ],
    );
    expect((await get(auth.token, legacy)).statusCode).toBe(200);
    expect((await submit(auth.token, legacy)).statusCode).toBe(200);
    const claim = (await claimRemoteReviewJob(db, config, 'worker'))!;
    const loaded = await loadRemoteReviewPayload(db, config, authorization, claim);
    expect(loaded).toEqual(legacy.payload);
    expect(() => restoreRemoteReviewSource(loaded)).toThrow('invalid-upload');
    expect(
      (await db.query('select count(*),sum(reserved_model_calls) as calls from client_review_jobs'))
        .rows[0],
    ).toEqual({ count: '1', calls: '2' });
  });
  it('claims a job once, checks its original key and account again, and rejects another owner', async () => {
    const auth = await key(),
      body = input();
    await submit(auth.token, body);
    const claims = await Promise.all([
      claimRemoteReviewJob(db, config, 'worker-a'),
      claimRemoteReviewJob(db, config, 'worker-b'),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    const loaded = await loadRemoteReviewPayload(db, config, authorization, claim);
    expect(loaded).toEqual(body.payload);
    const context = await restoreRemoteReviewContext(loaded);
    expect(context.status).toBe('ready');
    expect(context.context?.identity.hash).toBe(remoteReviewContextHash(body.payload));
    const uploaded = restoreRemoteReviewSource(loaded);
    try {
      expect(uploaded.readFile('app.ts')).toEqual({
        status: 'available',
        source: body.payload.source.files[0]!.metadata,
        text: body.payload.source.files[0]!.text,
      });
      expect(uploaded.readFile('app.ts', 'base')).toEqual({ status: 'absent' });
      expect(uploaded.selected).toEqual([{ path: 'app.ts', side: 'source', status: 'A' }]);
    } finally {
      uploaded.close();
    }
    await expect(
      heartbeatRemoteReviewJob(db, config, authorization, { ...claim, executor: 'wrong' }),
    ).rejects.toThrow('REMOTE_REVIEW_LEASE_LOST');
    await db.query('update chat_account_assignments set enabled=false');
    await expect(fenceRemoteReviewInvocation(db, config, authorization, claim)).rejects.toThrow(
      'REMOTE_REVIEW_ACCOUNT_DENIED',
    );
    await db.query('update chat_account_assignments set enabled=true');
    await db.query('update client_api_keys set revoked_at=clock_timestamp() where id=$1', [
      auth.id,
    ]);
    const replacement = await key();
    expect((await get(replacement.token, body)).statusCode).toBe(200);
    await expect(loadRemoteReviewPayload(db, config, authorization, claim)).rejects.toThrow(
      'CLIENT_ACCESS_REVOKED',
    );
    expect(
      (await db.query('select invocation_started_at from client_review_jobs')).rows[0]
        .invocation_started_at,
    ).toBe(null);
  });
  it('reclaims pre-send lease loss with a new owner but never retries an invoked job', async () => {
    const auth = await key(),
      body = input();
    await submit(auth.token, body);
    const old = (await claimRemoteReviewJob(db, config, 'worker'))!;
    await db.query(
      "update client_review_jobs set lease_until=clock_timestamp()-interval '1 second'",
    );
    expect(await recoverRemoteReviewLeases(db)).toBe(1);
    const current = (await claimRemoteReviewJob(db, config, 'worker'))!;
    expect(current.executor).not.toBe(old.executor);
    await expect(fenceRemoteReviewInvocation(db, config, authorization, old)).rejects.toThrow(
      'REMOTE_REVIEW_LEASE_LOST',
    );
    await fenceRemoteReviewInvocation(db, config, authorization, current);
    expect(await deferRemoteReviewJob(db, current, new Date())).toBe(false);
    await db.query(
      "update client_review_jobs set lease_until=clock_timestamp()-interval '1 second'",
    );
    expect(await recoverRemoteReviewLeases(db)).toBe(1);
    expect((await get(auth.token, body)).json().state).toBe('uncertain');
    expect(await claimRemoteReviewJob(db, config, 'third')).toBe(null);
    await expect(
      completeRemoteReviewJob(db, config, authorization, current, reportFor(body)),
    ).rejects.toThrow('REMOTE_REVIEW_LEASE_LOST');
    expect(
      (await db.query('select source_ciphertext from client_review_jobs')).rows[0]
        .source_ciphertext,
    ).toBe(null);
  });
  it('fences only after model capacity admission and releases the reservation when reauthorization rejects the send', async () => {
    const auth = await key(),
      body = input();
    await submit(auth.token, body);
    const claim = (await claimRemoteReviewJob(db, config, 'worker'))!;
    const quota = randomUUID();
    const held = (
      await db.query('select reserve_model_request($1,$2,10,10,false,1) as id', [
        quota,
        randomUUID(),
      ])
    ).rows[0].id;
    const fetcher = vi.fn(async () => new Response('synthetic'));
    const request = () =>
      withModelBudget(
        {
          runKey: `remote:${claim.id}`,
          maxCalls: 2,
          wait: false,
          concurrency: 1,
          beforeSend: () => fenceRemoteReviewInvocation(db, config, authorization, claim),
        },
        () =>
          admittedFetch(
            db,
            quota,
            fetcher,
          )('https://fixture.invalid/responses', { method: 'POST', body: '{}' }),
      );
    await expect(request()).rejects.toBeInstanceOf(ModelCapacityError);
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      (await db.query('select invocation_started_at from client_review_jobs')).rows[0]
        .invocation_started_at,
    ).toBe(null);
    await db.query("select finish_model_request($1,'completed',null)", [held]);
    await db.query('update chat_account_assignments set enabled=false');
    await expect(request()).rejects.toThrow('REMOTE_REVIEW_ACCOUNT_DENIED');
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      (
        await db.query(
          "select count(*) from model_request_ledger where quota_key=$1 and state in ('reserved','sent')",
          [quota],
        )
      ).rows[0].count,
    ).toBe('0');
  });
  it('persists the send fence before fetch, commits an encrypted report atomically, and prevents completion after cancellation', async () => {
    const auth = await key(),
      body = input();
    await submit(auth.token, body);
    const claim = (await claimRemoteReviewJob(db, config, 'worker'))!;
    const fetcher = vi.fn(async () => {
      expect(
        (await db.query('select invocation_started_at from client_review_jobs')).rows[0]
          .invocation_started_at,
      ).not.toBe(null);
      return new Response('synthetic');
    });
    const result = await withModelBudget(
      {
        runKey: `remote:${claim.id}`,
        maxCalls: 2,
        wait: false,
        beforeSend: () => fenceRemoteReviewInvocation(db, config, authorization, claim),
      },
      () =>
        admittedFetch(
          db,
          randomUUID(),
          fetcher,
        )('https://fixture.invalid/responses', { method: 'POST', body: '{}' }),
    );
    await result.text();
    const wrong = reportFor(body);
    wrong.identity.source.hash = 'f'.repeat(64);
    await expect(completeRemoteReviewJob(db, config, authorization, claim, wrong)).rejects.toThrow(
      'REMOTE_REVIEW_RESULT_MISMATCH',
    );
    const wrongAccount = reportFor(body);
    wrongAccount.identity.executor.configHash = '0'.repeat(64);
    await expect(
      completeRemoteReviewJob(db, config, authorization, claim, wrongAccount),
    ).rejects.toThrow('REMOTE_REVIEW_RESULT_MISMATCH');
    const wrongContext = reportFor(body);
    wrongContext.identity.context.hash = '0'.repeat(64);
    await expect(
      completeRemoteReviewJob(db, config, authorization, claim, wrongContext),
    ).rejects.toThrow('REMOTE_REVIEW_RESULT_MISMATCH');
    const report = reportFor(body);
    await completeRemoteReviewJob(db, config, authorization, claim, report);
    expect((await get(auth.token, body, 'result')).json().report).toEqual(report);
    expect(
      (await db.query('select source_ciphertext,lease_until from client_review_jobs')).rows[0],
    ).toEqual({ source_ciphertext: null, lease_until: null });
    expect(await claimRemoteReviewJob(db, config, 'other')).toBe(null);
    const next = input();
    await submit(auth.token, next);
    const second = (await claimRemoteReviewJob(db, config, 'worker'))!;
    await fenceRemoteReviewInvocation(db, config, authorization, second);
    await cancel(auth.token, next);
    await expect(
      completeRemoteReviewJob(db, config, authorization, second, reportFor(next)),
    ).rejects.toThrow('REMOTE_REVIEW_LEASE_LOST');
  });
  it('defers only a live pre-send owner and respects the scheduled retry time', async () => {
    const auth = await key();
    await submit(auth.token);
    const claim = (await claimRemoteReviewJob(db, config, 'worker'))!;
    expect(await deferRemoteReviewJob(db, claim, new Date(Date.now() + 60000))).toBe(true);
    expect(await claimRemoteReviewJob(db, config, 'other')).toBe(null);
    await expect(heartbeatRemoteReviewJob(db, config, authorization, claim)).rejects.toThrow(
      'REMOTE_REVIEW_LEASE_LOST',
    );
    await db.query(
      "update client_review_jobs set next_attempt_at=clock_timestamp()-interval '1 second'",
    );
    expect(await claimRemoteReviewJob(db, config, 'other')).not.toBe(null);
  });
  it('runs the real worker loop from HTTP admission through registered provider tools to encrypted result', async () => {
    const fixture = await providerFixture(reviewHandler),
      stop = new AbortController();
    const auth = await key(),
      body = input();
    const binding = new TrustedCentralBinding({
      serverUrl: origin,
      allowLoopbackHttp: true,
      audience: body.payload.audience,
      trustedKeys: new Map([['fixture', generateKeyPairSync('ed25519').publicKey]]),
    });
    const client = new KnowledgeHttpTransport(binding, {
      bindingId: binding.id,
      readToken: async () => auth.token,
    });
    const handle = prepareRemoteReviewHandle(body);
    expect((await client.submitRemoteReview(body, stop.signal)).state).toBe('queued');
    const running = runWorker(fixture.settings, { signal: stop.signal });
    try {
      await until(async () => {
        try {
          return (await client.remoteReviewStatus(handle, stop.signal)).state === 'completed';
        } catch (error) {
          if (error instanceof RemoteReviewDeliveryError && error.statusCode === 409) return false;
          throw error;
        }
      });
      const result = await client.remoteReviewResult(handle, stop.signal);
      expect(result.report.status).toBe('completed');
      expect(result.report.identity.context.hash).toBe(remoteReviewContextHash(body.payload));
      expect(fixture.requests).toHaveLength(2);
      expect((await client.submitRemoteReview(body, stop.signal)).state).toBe('completed');
      expect((await db.query('select count(*) from client_review_jobs')).rows[0].count).toBe('1');
      expect(
        (
          await db.query(
            "select count(*) from model_request_ledger where quota_key=$1 and state='completed'",
            [fixture.quota],
          )
        ).rows[0].count,
      ).toBe('2');
    } finally {
      stop.abort();
      await running;
      await fixture.close();
    }
  }, 15000);
  it('defers capacity before any send and later completes the same request without re-reserving admission', async () => {
    const fixture = await providerFixture(reviewHandler);
    try {
      const auth = await key(),
        body = input();
      await submit(auth.token, body);
      const held = (
        await db.query('select reserve_model_request($1,$2,2,1,false,1) as id', [
          fixture.quota,
          'held-' + randomUUID(),
        ])
      ).rows[0].id;
      const first = (await claimRemoteReviewJob(db, config, 'worker'))!;
      expect(
        await executeRemoteReviewJob(db, config, authorization, fixture.artifacts, first),
      ).toBe('deferred');
      expect(fixture.requests).toHaveLength(0);
      expect(
        (
          await db.query(
            'select state,invocation_started_at,reserved_model_calls from client_review_jobs',
          )
        ).rows[0],
      ).toEqual({ state: 'queued', invocation_started_at: null, reserved_model_calls: 2 });
      await db.query("select finish_model_request($1,'completed',null)", [held]);
      await db.query('update client_review_jobs set next_attempt_at=clock_timestamp()');
      const second = (await claimRemoteReviewJob(db, config, 'worker'))!;
      expect(second.id).toBe(first.id);
      expect(
        await executeRemoteReviewJob(db, config, authorization, fixture.artifacts, second),
      ).toBe('completed');
      expect(fixture.requests).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  }, 15000);
  it.each(['cancel', 'revoke'] as const)(
    'aborts a live registered HTTP stream after %s',
    async (action) => {
      let entered = false,
        disconnected = false;
      const fixture = await providerFixture(async (_body, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
        reply.raw.write(': pending\n\n');
        reply.raw.on('close', () => {
          disconnected = true;
        });
        entered = true;
      });
      try {
        const auth = await key(),
          body = input();
        await submit(auth.token, body);
        const claim = (await claimRemoteReviewJob(db, config, 'worker'))!;
        const running = executeRemoteReviewJob(db, config, authorization, fixture.artifacts, claim);
        await until(() => entered);
        if (action === 'cancel') await cancel(auth.token, body);
        else
          await db.query('update client_api_keys set revoked_at=clock_timestamp() where id=$1', [
            auth.id,
          ]);
        expect(await running).toBe(action === 'cancel' ? 'cancelled' : 'failed');
        await until(() => disconnected);
        expect(
          (await db.query('select reason,source_ciphertext from client_review_jobs')).rows[0],
        ).toEqual({
          reason: action === 'cancel' ? 'cancelled' : 'authorization-revoked',
          source_ciphertext: null,
        });
        expect(await claimRemoteReviewJob(db, config, 'other')).toBeNull();
      } finally {
        await fixture.close();
      }
    },
    15000,
  );
  it.each(['interrupted', 'invalid-output'] as const)(
    'settles a provider %s without starting the job again',
    async (mode) => {
      const fixture = await providerFixture(async (_body, reply) =>
        mode === 'invalid-output'
          ? completeStream('not-json')
          : reply.send(event({ type: 'response.output_text.delta', delta: 'unfinished' })),
      );
      try {
        const auth = await key(),
          body = input();
        await submit(auth.token, body);
        const claim = (await claimRemoteReviewJob(db, config, 'worker'))!;
        expect(
          await executeRemoteReviewJob(db, config, authorization, fixture.artifacts, claim),
        ).toBe(mode === 'interrupted' ? 'uncertain' : 'failed');
        expect((await get(auth.token, body)).json().reason).toBe(
          mode === 'interrupted' ? 'execution-lost' : 'invalid-output',
        );
        expect(fixture.requests).toHaveLength(1);
        expect(await claimRemoteReviewJob(db, config, 'other')).toBeNull();
      } finally {
        await fixture.close();
      }
    },
    15000,
  );
  it('fails expired approved context before loading a model or sending source', async () => {
    const fixture = await providerFixture(reviewHandler);
    try {
      const auth = await key(),
        body = input();
      body.payload.context.resolved!.validUntil = '2020-01-01T00:00:00.000Z';
      expect((await submit(auth.token, approve(body))).statusCode).toBe(201);
      const claim = (await claimRemoteReviewJob(db, config, 'worker'))!;
      const resolver = vi.fn(resolveChatAccountSelection);
      expect(
        await executeRemoteReviewJob(db, config, authorization, fixture.artifacts, claim, {
          resolveAccount: resolver,
        }),
      ).toBe('failed');
      expect(resolver).not.toHaveBeenCalled();
      expect(fixture.requests).toHaveLength(0);
      expect((await get(auth.token, body)).json().reason).toBe('context-unavailable');
    } finally {
      await fixture.close();
    }
  });
  it('enforces the approved model-turn limit without a whole-job retry', async () => {
    const fixture = await providerFixture(reviewHandler);
    try {
      const auth = await key(),
        body = input();
      body.payload.budget.modelCalls = 1;
      await submit(auth.token, approve(body));
      const claim = (await claimRemoteReviewJob(db, config, 'worker'))!;
      expect(
        await executeRemoteReviewJob(db, config, authorization, fixture.artifacts, claim),
      ).toBe('failed');
      expect((await get(auth.token, body)).json().reason).toBe('budget-exhausted');
      expect(fixture.requests).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });
  it('defers shutdown before any provider send and returns the same queued request', async () => {
    const fixture = await providerFixture(reviewHandler);
    try {
      const auth = await key(),
        body = input();
      await submit(auth.token, body);
      const claim = (await claimRemoteReviewJob(db, config, 'worker'))!,
        stop = new AbortController();
      stop.abort();
      expect(
        await executeRemoteReviewJob(db, config, authorization, fixture.artifacts, claim, {
          signal: stop.signal,
        }),
      ).toBe('deferred');
      expect(fixture.requests).toHaveLength(0);
      expect((await get(auth.token, body)).json().state).toBe('queued');
    } finally {
      await fixture.close();
    }
  });
  it('retains uncertainty when a timed-out model dependency does not finish cleanup', async () => {
    const fixture = await providerFixture(reviewHandler);
    let release!: () => void,
      returned = false;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const auth = await key(),
        body = input();
      body.payload.budget.durationMs = 1000;
      await submit(auth.token, approve(body));
      const claim = (await claimRemoteReviewJob(db, config, 'worker'))!;
      const resolveAccount: typeof resolveChatAccountSelection = async (...args) => {
        const selection = await resolveChatAccountSelection(...args);
        if (!selection) throw Error('fixture');
        return {
          ...selection,
          model: {
            name: selection.modelName,
            generate: (request) => selection.model.generate(request),
            turn: async (request) => {
              const result = await selection.model.turn!(request);
              await blocked;
              returned = true;
              return result;
            },
          },
        };
      };
      expect(
        await executeRemoteReviewJob(db, config, authorization, fixture.artifacts, claim, {
          resolveAccount,
        }),
      ).toBe('uncertain');
      expect(returned).toBe(false);
      expect(fixture.requests).toHaveLength(1);
      expect((await get(auth.token, body)).json().reason).toBe('execution-lost');
      expect(await claimRemoteReviewJob(db, config, 'other')).toBeNull();
    } finally {
      release();
      await until(() => returned);
      await fixture.close();
    }
  }, 15000);
  it('decrypts a completed fixture report, detects substitution and purges expired results', async () => {
    const auth = await key(),
      body = input();
    await submit(auth.token, body);
    const row = (await db.query('select * from client_review_jobs')).rows[0];
    const report = reportFor(body);
    const encrypted = encryptCredential(
      canonicalJson(report),
      encryptionKey,
      remoteReviewEncryptionPurpose(row.id, row.payload_hash, 'result'),
    );
    await db.query(
      "update client_review_jobs set state='completed',report_hash=$1,result_ciphertext=$2,result_iv=$3,result_tag=$4,source_ciphertext=null,source_iv=null,source_tag=null",
      [
        contentHash(report),
        encrypted.credentialCiphertext,
        encrypted.credentialIv,
        encrypted.credentialAuthTag,
      ],
    );
    const result = await get(auth.token, body, 'result');
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().report).toEqual(report);
    await db.query('update client_review_jobs set report_hash=$1', ['0'.repeat(64)]);
    expect((await get(auth.token, body, 'result')).statusCode).toBe(503);
    await db.query(
      "update client_review_jobs set received_at=clock_timestamp()-interval '3 hours',source_expires_at=clock_timestamp()-interval '2 hours',result_expires_at=clock_timestamp()-interval '1 hour'",
    );
    expect(await expireRemoteReviewJobs(db)).toBe(1);
    expect((await get(auth.token, body, 'result')).statusCode).toBe(410);
    expect((await get(auth.token, body)).json().reason).toBe('result-expired');
    expect(
      (await db.query('select result_ciphertext,result_iv,result_tag from client_review_jobs'))
        .rows[0],
    ).toEqual({ result_ciphertext: null, result_iv: null, result_tag: null });
  });
});
