import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { analysisPromptListSchema, reviewSeverityLevelSchema } from '@gcr/contracts';
import { registerAdminRoutes } from './admin.js';
import { loadConfig } from '../config.js';
import { AuthorizationService } from '../services/authorization.js';

const databaseUrl = process.env.GCR_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl).sequential('versioned analysis Prompt Severity Level', () => {
  const schema = `gcr_prompt_test_${randomUUID().replaceAll('-', '')}`;
  let root: Database, database: Database, app: FastifyInstance, tenantId: string, firstId: string;
  let role: 'administrator' | 'reviewer' = 'administrator';
  const route = () => `/api/v1/admin/tenants/${tenantId}/analysis-prompts`;
  const save = (payload: object) => app.inject({ method: 'POST', url: route(), payload });
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw Error('Use an isolated local test PostgreSQL');
    root = createDatabase(url.toString());
    await root.query(`create schema ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    database = createDatabase(url.toString());
    await runMigrations(database, path.resolve('packages/db/migrations'));
    const userId = (
      await database.query(
        "insert into users(oidc_subject,display_name,role) values ('synthetic:prompt','검증 관리자','administrator') returning id",
      )
    ).rows[0].id;
    tenantId = (
      await database.query(
        "insert into tenants(slug,display_name) values ('test-prompt','검증 Tenant') returning id",
      )
    ).rows[0].id;
    const config = loadConfig({ DATABASE_URL: url.toString(), AUTH_MODE: 'development' });
    app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.user = {
        id: userId,
        subject: 'synthetic:prompt',
        displayName: '검증 관리자',
        role,
        enabled: true,
        groups: [],
        tenantIds: [],
        tenants: [],
      };
    });
    app.setErrorHandler((error, _request, reply) =>
      reply.code(error instanceof ZodError ? 400 : 500).send({ error: error.message }),
    );
    await registerAdminRoutes(app, database, new AuthorizationService(config), config);
  });
  afterAll(async () => {
    await app?.close();
    await database?.end();
    if (root) {
      await root.query(`drop schema if exists ${schema} cascade`);
      await root.end();
    }
  });

  it.each(reviewSeverityLevelSchema.options)(
    'saves %s without instructions, hashes the level, and reloads it',
    async (severityLevel) => {
      const response = await save({ instructions: '', severityLevel });
      expect(response.statusCode, response.body).toBe(201);
      if (severityLevel === 'lean') firstId = response.json().id;
      const duplicate = await save({ instructions: ' \r\n ', severityLevel });
      expect(duplicate.json().id).toBe(response.json().id);
      const data = analysisPromptListSchema.parse((await app.inject(route())).json());
      expect(data.active).toMatchObject({
        instructions: '',
        severityLevel,
        contentHash: response.json().contentHash,
      });
      expect(new Set(data.items.map((item) => item.contentHash)).size).toBe(data.items.length);
    },
  );

  it('keeps previous content immutable and restores its level on activation/reset', async () => {
    await expect(
      database.query("update analysis_prompt_versions set severity_level='severe' where id=$1", [
        firstId,
      ]),
    ).rejects.toThrow('immutable');
    await expect(
      database.query("update analysis_prompt_versions set instructions='changed' where id=$1", [
        firstId,
      ]),
    ).rejects.toThrow('immutable');
    const activated = await app.inject({ method: 'POST', url: `${route()}/${firstId}/activate` });
    expect(activated.statusCode).toBe(200);
    expect((await app.inject(route())).json().active.severityLevel).toBe('lean');
    expect((await app.inject({ method: 'POST', url: `${route()}/reset` })).statusCode).toBe(200);
    const reset = (await app.inject(route())).json();
    expect(reset.active).toBeNull();
    expect(reset.items).toHaveLength(5);
    expect((await save({ instructions: 'Legacy client' })).statusCode).toBe(201);
    expect((await app.inject(route())).json().active.severityLevel).toBe('moderate');
  });

  it('rejects invalid levels and unauthorized writes without changing active policy', async () => {
    const active = (await app.inject(route())).json().active.id;
    expect((await save({ instructions: '', severityLevel: 'xhigh' })).statusCode).toBe(400);
    expect(
      (await save({ instructions: 'x'.repeat(12001), severityLevel: 'severe' })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: `${route()}/${randomUUID()}/activate` })).statusCode,
    ).toBe(404);
    role = 'reviewer';
    expect((await save({ instructions: '', severityLevel: 'lean' })).statusCode).toBe(404);
    role = 'administrator';
    expect((await app.inject(route())).json().active.id).toBe(active);
  });
});
