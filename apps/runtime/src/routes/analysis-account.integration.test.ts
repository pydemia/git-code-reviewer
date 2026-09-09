import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { composeReviewSystemPrompt, loadBuiltInReviewSkills } from '@gcr/analysis-engine';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../auth/index.js';
import { loadConfig } from '../config.js';
import {
  createChatAccount,
  findAnalysisChatAccount,
  listAvailableChatAccounts,
  resolveChatAccountSelection,
} from '../services/account-registry.js';
import { createReviewModel, resolveAnalysisProvider } from '../services/analysis-provider.js';
import { AuthorizationService } from '../services/authorization.js';
import { registerAdminRoutes } from './admin.js';

const databaseUrl = process.env.GCR_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl).sequential('registered account batch review with PostgreSQL', () => {
  const schema = `gcr_analysis_test_${randomUUID().replaceAll('-', '')}`;
  let root: Database, database: Database, app: FastifyInstance;
  let admin: AuthUser, tenantId: string, accountId: string, providerId: string;
  let role: 'administrator' | 'reviewer' = 'administrator';
  const fetcher = vi.fn();
  const config = loadConfig({
    DATABASE_URL: 'postgresql://localhost/unused',
    AUTH_MODE: 'development',
    MODEL_ADMIN_ENABLED: 'true',
    CREDENTIAL_REGISTRY_ENABLED: 'true',
    CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  });
  const input = () => ({
    mode: 'chatgpt-account',
    chatAccountId: accountId,
    modelName: 'synthetic-review-model',
    reasoningEffort: 'high',
    timeoutMs: 30000,
  });

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw Error('Use an isolated local test PostgreSQL');
    root = createDatabase(url.toString());
    await root.query(`create schema ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    database = createDatabase(url.toString());
    await runMigrations(database, path.resolve('packages/db/migrations'));
    tenantId = (await database.query("select id from tenants where slug = 'default'")).rows[0].id;
    const user = (
      await database.query(
        "insert into users(oidc_subject, display_name, role) values ('synthetic:admin', '검증 관리자', 'administrator') returning id",
      )
    ).rows[0];
    admin = {
      id: user.id,
      subject: 'synthetic:admin',
      displayName: '검증 관리자',
      role: 'administrator',
      enabled: true,
      groups: [],
      tenantIds: [tenantId],
      tenants: [],
    };
    const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.synthetic`;
    accountId = await createChatAccount(database, config, admin.id, {
      displayName: '검증용 account',
      endpoint: 'https://chatgpt.example.test/backend-api/codex/',
      authJson: JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: token, refresh_token: 'synthetic-refresh' },
        last_refresh: new Date().toISOString(),
      }),
      models: [
        {
          id: 'synthetic-review-model',
          displayName: '검증 모델',
          allowedEfforts: ['low', 'high'],
          defaultEffort: 'low',
        },
      ],
      assignments: [{ scopeType: 'tenant', scopeId: tenantId }],
    });
    vi.stubGlobal('fetch', fetcher);
    app = Fastify();
    // 실제 Server의 공통 ZodError → 400 처리와 같은 검증 경계다.
    app.setErrorHandler((error, _request, reply) =>
      error instanceof ZodError
        ? reply.code(400).send({ code: 'INVALID_REQUEST' })
        : reply.send(error),
    );
    app.addHook('onRequest', async (request) => {
      request.user = { ...admin, role };
    });
    await registerAdminRoutes(app, database, new AuthorizationService(config), config);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await app?.close();
    await database?.end();
    if (root) {
      await root.query(`drop schema if exists ${schema} cascade`);
      await root.end();
    }
  });

  it('uses the same tenant access for account listing and selection, including administrators', async () => {
    expect(
      (await listAvailableChatAccounts(database, admin.id)).map((account) => account.id),
    ).toContain(accountId);
    expect(
      await resolveChatAccountSelection(
        database,
        config,
        admin.id,
        accountId,
        'synthetic-review-model',
        'high',
      ),
    ).not.toBeNull();
    const reviewerId = (
      await database.query(
        "insert into users(oidc_subject, display_name, role) values ('synthetic:isolated', 'Reviewer', 'reviewer') returning id",
      )
    ).rows[0].id;
    expect(await listAvailableChatAccounts(database, reviewerId)).toEqual([]);
    expect(
      await resolveChatAccountSelection(
        database,
        config,
        reviewerId,
        accountId,
        'synthetic-review-model',
        'high',
      ),
    ).toBeNull();
    await database.query('insert into tenant_memberships(tenant_id,user_id) values ($1,$2)', [
      tenantId,
      reviewerId,
    ]);
    expect(
      (await listAvailableChatAccounts(database, reviewerId)).map((account) => account.id),
    ).toContain(accountId);
    expect(
      await resolveChatAccountSelection(
        database,
        config,
        reviewerId,
        accountId,
        'synthetic-review-model',
        'high',
      ),
    ).not.toBeNull();
    await database.query('update tenant_memberships set enabled=false where user_id=$1', [
      reviewerId,
    ]);
    expect(await listAvailableChatAccounts(database, reviewerId)).toEqual([]);
  });

  it('stores an immutable account/model/effort version without copying credentials', async () => {
    const saved = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/analysis-provider/versions',
      payload: input(),
    });
    expect(saved.statusCode, saved.body).toBe(201);
    providerId = saved.json().id;
    const row = (
      await database.query('select * from analysis_provider_versions where id = $1', [providerId])
    ).rows[0];
    expect(row).toMatchObject({
      mode: 'chatgpt-account',
      chat_account_id: accountId,
      reasoning_effort: 'high',
      concurrency: 4,
      endpoint: null,
      credential_ciphertext: null,
    });
    const settings = await app.inject('/api/v1/admin/analysis-provider');
    expect(settings.json().effective).toMatchObject({
      chatAccountId: accountId,
      reasoningEffort: 'high',
      concurrency: 4,
    });
    expect(settings.body).not.toContain('synthetic-refresh');
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/analysis-provider/versions',
      payload: input(),
    });
    expect(duplicate.json().id).toBe(providerId);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/analysis-provider/versions',
      payload: { ...input(), reasoningEffort: 'low', concurrency: 2 },
    });
    expect(changed.json().id).not.toBe(providerId);
    expect((await resolveAnalysisProvider(database, config, changed.json().id)).concurrency).toBe(
      2,
    );
    expect((await resolveAnalysisProvider(database, config, providerId)).concurrency).toBe(4);
    await expect(
      database.query('update analysis_provider_versions set concurrency=1 where id=$1', [
        providerId,
      ]),
    ).rejects.toThrow('immutable');
    for (const concurrency of [0, 5, 1.5]) {
      const invalid = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/analysis-provider/versions',
        payload: { ...input(), concurrency },
      });
      expect(invalid.statusCode).toBe(400);
    }
    expect((await resolveAnalysisProvider(database, config, providerId)).reasoningEffort).toBe(
      'high',
    );
  });

  it('calls the selected model and effort, preserving Korean comments and file summaries', async () => {
    const review = {
      summary: '문자열 column 변경을 검토했습니다.',
      grade: 'adequate',
      file_comments: [
        {
          file: 'migration.py',
          line: 2,
          priority: 'P2',
          category: 'compatibility',
          comment: 'Downgrade에서 숫자 외 문자열을 처리해야 합니다.',
        },
      ],
      per_file_summaries: [
        {
          file: 'migration.py',
          summary: 'varchar로 변경합니다.',
          priority: 'P2',
          blocking: false,
          grade: 'adequate',
        },
      ],
    };
    fetcher.mockImplementation(
      async () =>
        new Response(
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: JSON.stringify(review) })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const provider = await resolveAnalysisProvider(database, config, providerId);
    const model = createReviewModel(provider, { database, config, tenantId })!;
    const result = await model.review(
      '@@ -1 +1 @@\n+value',
      ['migration.py'],
      '호환성을 확인하세요.',
    );
    expect(result.report.review.per_file_summaries?.[0]?.summary).toBe('varchar로 변경합니다.');
    const sent = JSON.parse(fetcher.mock.calls.at(-1)![1].body);
    expect(sent).toMatchObject({
      model: 'synthetic-review-model',
      reasoning: { effort: 'high' },
      store: false,
    });
    expect(sent.instructions).toContain('호환성을 확인하세요.');
  });

  it('uses the shared Skill prompt contract for all stages with the pinned model and effort', async () => {
    const skills = loadBuiltInReviewSkills();
    const response = JSON.stringify({
      summary: '검증용 요약입니다.',
      grade: 'adequate',
      file_comments: [],
    });
    fetcher.mockImplementation(
      async () =>
        new Response(
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: response })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const provider = await resolveAnalysisProvider(database, config, providerId);
    const model = createReviewModel(provider, { database, config, tenantId })!;
    for (const stage of ['unit-comment-block', 'overall-summary', 'total-summary'] as const) {
      const context = { stage, skills };
      await model.review('Synthetic stage input', ['a.ts'], 'Tenant review guidance', context);
      const sent = JSON.parse(fetcher.mock.calls.at(-1)![1].body);
      expect(sent.instructions).toBe(composeReviewSystemPrompt('Tenant review guidance', context));
      expect(sent.model).toBe('synthetic-review-model');
      expect(sent.reasoning.effort).toBe('high');
      expect(sent.store).toBe(false);
    }
  });

  it('rejects cross-tenant use, user-only grants, disabled accounts, and unsupported efforts', async () => {
    const provider = await resolveAnalysisProvider(database, config, providerId);
    const before = fetcher.mock.calls.length;
    await expect(
      createReviewModel(provider, { database, config, tenantId: randomUUID() })!.review(
        'private diff',
        ['a.ts'],
      ),
    ).rejects.toThrow('tenant');
    expect(fetcher.mock.calls.length).toBe(before);
    expect(
      await findAnalysisChatAccount(database, accountId, 'synthetic-review-model', 'medium', {
        tenantId,
      }),
    ).toBeNull();
    await database.query(
      "update chat_account_assignments set scope_type = 'user', scope_id = $2 where account_id = $1",
      [accountId, admin.id],
    );
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/analysis-provider/versions',
      payload: input(),
    });
    expect(invalid.statusCode).toBe(400);
    expect(
      await findAnalysisChatAccount(database, accountId, 'synthetic-review-model', 'high', {
        tenantId,
      }),
    ).toBeNull();
    await database.query(
      "update chat_account_assignments set scope_type = 'tenant', scope_id = $2 where account_id = $1",
      [accountId, tenantId],
    );
    await database.query('update chat_accounts set enabled = false where id = $1', [accountId]);
    await expect(
      createReviewModel(provider, { database, config, tenantId })!.review('private diff', ['a.ts']),
    ).rejects.toThrow('tenant');
    await database.query('update chat_accounts set enabled = true where id = $1', [accountId]);
  });

  it('tests without source data and prevents reviewer administration', async () => {
    fetcher.mockImplementation(
      async () =>
        new Response(
          'data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const tested = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/analysis-provider/test',
      payload: input(),
    });
    expect(tested.statusCode, tested.body).toBe(200);
    const sent = JSON.parse(fetcher.mock.calls.at(-1)![1].body);
    expect(JSON.stringify(sent.input)).toContain('Reply with OK.');
    expect(JSON.stringify(sent)).not.toContain('migration.py');
    role = 'reviewer';
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/analysis-provider/versions',
          payload: input(),
        })
      ).statusCode,
    ).toBe(404);
    role = 'administrator';
  });
});
