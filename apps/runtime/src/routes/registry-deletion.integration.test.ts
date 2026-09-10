import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { AuthUser } from '../auth/index.js';
import { loadConfig } from '../config.js';
import { createChatAccount, resolveChatAccountSelection } from '../services/account-registry.js';
import { deleteRegistryEntry } from '../services/registry-deletion.js';
import { getAnalysisProviderRow } from '../services/analysis-provider.js';
import { AuthorizationService } from '../services/authorization.js';
import { registerAccountRegistryRoutes } from './account-registry.js';
import { registerAdminRoutes } from './admin.js';

const databaseUrl = process.env.GCR_TEST_DATABASE_URL;
describe
  .skipIf(!databaseUrl)
  .sequential('inactive registry deletion and permission-scoped chat presets', () => {
    const schema = `gcr_registry_${randomUUID().replaceAll('-', '')}`;
    let root: Database, database: Database, app: FastifyInstance, admin: AuthUser;
    let accountId: string, providerId: string;
    let reviewer = false;
    const config = loadConfig({
      DATABASE_URL: 'postgresql://localhost/unused',
      AUTH_MODE: 'development',
      MODEL_ADMIN_ENABLED: 'true',
      CREDENTIAL_REGISTRY_ENABLED: 'true',
      CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    const authJson = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'synthetic-only', refresh_token: 'synthetic-refresh' },
    });
    const accountInput = () => ({
      displayName: '삭제 검증 account',
      authJson,
      models: [
        {
          id: 'test-model',
          displayName: '검증 모델',
          allowedEfforts: ['low', 'high'],
          defaultEffort: 'low',
        },
      ],
      assignments: [{ scopeType: 'all' as const, scopeId: '*' }],
    });
    const providerInput = () => ({
      mode: 'chatgpt-account',
      chatAccountId: accountId,
      modelName: 'test-model',
      reasoningEffort: 'high',
      timeoutMs: 30000,
      concurrency: 4,
    });
    const removeAccount = (confirmation = accountInput().displayName) =>
      app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/chat-accounts/${accountId}`,
        payload: { confirmation },
      });
    const removeProvider = () =>
      app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/analysis-provider/versions/${providerId}`,
        payload: { confirmation: 'v1' },
      });
    beforeAll(async () => {
      const url = new URL(databaseUrl!);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw Error('Local isolated PostgreSQL only');
      root = createDatabase(url.href);
      await root.query(`create schema ${schema}`);
      url.searchParams.set('options', `-c search_path=${schema}`);
      database = createDatabase(url.href);
      await runMigrations(database, path.resolve('packages/db/migrations'));
      const row = (
        await database.query(
          "insert into users(oidc_subject,display_name,role) values('registry-admin','Admin','administrator') returning id",
        )
      ).rows[0];
      admin = {
        id: row.id,
        subject: 'registry-admin',
        displayName: 'Admin',
        role: 'administrator',
        enabled: true,
        groups: [],
        tenants: [],
      };
      accountId = await createChatAccount(database, config, admin.id, accountInput());
      app = Fastify();
      app.setErrorHandler((error, _request, reply) =>
        error instanceof ZodError ? reply.code(400).send({ error: 'invalid' }) : reply.send(error),
      );
      app.addHook('onRequest', async (request) => {
        request.user = { ...admin, role: reviewer ? 'reviewer' : 'administrator' };
      });
      await registerAccountRegistryRoutes(app, database, config);
      await registerAdminRoutes(app, database, new AuthorizationService(config), config);
      const provider = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/analysis-provider/versions',
        payload: providerInput(),
      });
      expect(provider.statusCode).toBe(201);
      providerId = provider.json().id;
    });
    afterAll(async () => {
      await app?.close();
      await database?.end();
      if (root) {
        await root.query(`drop schema ${schema} cascade`);
        await root.end();
      }
    });
    it('publishes only presets whose account/model/effort are assigned to the user, without credentials', async () => {
      const response = await app.inject('/api/v1/chat-accounts');
      expect(response.json().analysisPresets).toMatchObject([
        { id: providerId, modelName: 'test-model', reasoningEffort: 'high' },
      ]);
      expect(response.body).not.toMatch(/credential|ciphertext|authJson|synthetic-only|endpoint/);
      await database.query(
        'update chat_account_assignments set enabled=false where account_id=$1',
        [accountId],
      );
      expect((await app.inject('/api/v1/chat-accounts')).json().analysisPresets).toEqual([]);
      expect(
        await resolveChatAccountSelection(
          database,
          config,
          admin.id,
          accountId,
          'test-model',
          'high',
        ),
      ).toBeNull();
      await database.query('update chat_account_assignments set enabled=true where account_id=$1', [
        accountId,
      ]);
    });
    it('rejects active entries, non-admin deletion and wrong confirmation without mutation', async () => {
      expect((await removeAccount()).statusCode).toBe(409);
      expect((await removeProvider()).statusCode).toBe(409);
      expect((await removeAccount('다른 이름')).statusCode).toBe(409);
      reviewer = true;
      expect((await removeAccount()).statusCode).toBe(404);
      expect((await removeProvider()).statusCode).toBe(404);
      reviewer = false;
      expect(
        (
          await database.query('select count(*)::int as n from audit_events where action like $1', [
            '%.delete',
          ])
        ).rows[0].n,
      ).toBe(0);
    });
    it('blocks removing an account still referenced by the active provider', async () => {
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/chat-accounts/${accountId}`,
        payload: { enabled: false },
      });
      expect((await removeAccount()).json().error.message).toContain('활성 Provider');
      await app.inject({ method: 'POST', url: '/api/v1/admin/analysis-provider/reset' });
    });
    it('deletes inactive provider from selection but preserves immutable pinned configuration', async () => {
      const before = await getAnalysisProviderRow(database, providerId);
      expect((await removeProvider()).statusCode).toBe(200);
      const after = await getAnalysisProviderRow(database, providerId);
      expect(after?.configurationHash).toBe(before?.configurationHash);
      expect(after?.deletedAt).toBeTruthy();
      expect((await app.inject('/api/v1/admin/analysis-provider')).json().items).toEqual([]);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/admin/analysis-provider/versions/${providerId}/activate`,
          })
        ).statusCode,
      ).toBe(404);
      expect((await removeProvider()).statusCode).toBe(404);
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/chat-accounts/${accountId}`,
        payload: { enabled: true },
      });
      const replacement = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/analysis-provider/versions',
        payload: providerInput(),
      });
      expect(replacement.statusCode).toBe(201);
      expect(replacement.json().id).not.toBe(providerId);
      expect(replacement.json().configurationHash).toBe(before?.configurationHash);
      await app.inject({ method: 'POST', url: '/api/v1/admin/analysis-provider/reset' });
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/chat-accounts/${accountId}`,
        payload: { enabled: false },
      });
    });
    it('rolls back deletion and credential removal if audit insertion fails', async () => {
      await database.query(`create function reject_registry_audit() returns trigger language plpgsql as $$ begin
      if new.action='chat_account.delete' then raise exception 'synthetic audit failure'; end if; return new; end $$`);
      await database.query(
        'create trigger reject_registry_audit before insert on audit_events for each row execute function reject_registry_audit()',
      );
      expect((await removeAccount()).statusCode).toBe(500);
      const row = (
        await database.query(
          'select deleted_at,credential_ciphertext is not null as credential from chat_accounts where id=$1',
          [accountId],
        )
      ).rows[0];
      expect(row).toMatchObject({ deleted_at: null, credential: true });
      await database.query('drop trigger reject_registry_audit on audit_events');
    });
    it('handles concurrent deletion once, erases auth and prevents resurrection', async () => {
      const outcomes = await Promise.all([removeAccount(), removeAccount()]);
      expect(outcomes.map((item) => item.statusCode).sort()).toEqual([200, 404]);
      const row = (
        await database.query(
          'select deleted_at,credential_ciphertext,credential_iv,credential_auth_tag from chat_accounts where id=$1',
          [accountId],
        )
      ).rows[0];
      expect(row.deleted_at).toBeTruthy();
      expect(row.credential_ciphertext).toBeNull();
      expect(row.credential_iv).toBeNull();
      expect(row.credential_auth_tag).toBeNull();
      expect((await app.inject('/api/v1/admin/chat-accounts')).json().items).toEqual([]);
      expect((await app.inject('/api/v1/chat-accounts')).json().items).toEqual([]);
      for (const payload of [{ enabled: true }, { authJson }])
        expect(
          (
            await app.inject({
              method: 'PATCH',
              url: `/api/v1/admin/chat-accounts/${accountId}`,
              payload,
            })
          ).statusCode,
        ).toBe(404);
      expect(
        (
          await database.query(
            "select count(*)::int as n from audit_events where action='chat_account.delete'",
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        await deleteRegistryEntry(
          database,
          'chat_account',
          randomUUID(),
          'missing',
          admin.subject,
          'test',
        ),
      ).toBe('not-found');
    });
    it('allows re-registering a deleted account name with a new identity', async () => {
      const next = await createChatAccount(database, config, admin.id, accountInput());
      expect(next).not.toBe(accountId);
      expect((await database.query('select count(*)::int as n from chat_accounts')).rows[0].n).toBe(
        2,
      );
    });
  });
