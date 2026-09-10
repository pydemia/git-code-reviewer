import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { profileSchema, userSchema } from '@gcr/contracts';
import { registerProfileRoutes } from './profile.js';
import { readPersonalPrompt } from '../services/personal-prompt.js';
import type { AuthUser } from '../auth/index.js';
import type { AppConfig } from '../config.js';

const databaseUrl = process.env.GCR_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl).sequential('personal Prompt persistence and user isolation', () => {
  const schema = `gcr_personal_prompt_${randomUUID().replaceAll('-', '')}`;
  let root: Database, database: Database, app: FastifyInstance;
  let users: AuthUser[];
  let actor: AuthUser;
  const save = (personalPrompt: string) =>
    app.inject({ method: 'PUT', url: '/api/v1/profile/prompt', payload: { personalPrompt } });

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw Error('Use an isolated local test PostgreSQL');
    root = createDatabase(url.toString());
    await root.query(`create schema ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    database = createDatabase(url.toString());
    await runMigrations(database, path.resolve('packages/db/migrations'));
    await runMigrations(database, path.resolve('packages/db/migrations'));
    users = [];
    for (const role of ['reviewer', 'administrator'] as const) {
      const subject = `synthetic:${role}`;
      const result = await database.query(
        'insert into users(oidc_subject, display_name, role) values ($1, $2, $3) returning id',
        [subject, '검증 사용자', role],
      );
      users.push({
        id: result.rows[0].id,
        subject,
        displayName: '검증 사용자',
        role,
        enabled: true,
        groups: [],
        tenants: [],
      });
    }
    actor = users[0]!;
    app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.user = actor;
    });
    app.setErrorHandler((error, _request, reply) =>
      reply.code(error instanceof ZodError ? 400 : 500).send({ error: error.message }),
    );
    await registerProfileRoutes(app, database, { AUTH_MODE: 'oidc' } as AppConfig);
  });

  afterAll(async () => {
    await app?.close();
    await database?.end();
    if (root) {
      await root.query(`drop schema if exists ${schema} cascade`);
      await root.end();
    }
  });

  it('defaults to empty and persists distinct reviewer/admin preferences after reconnect', async () => {
    for (const user of users) {
      actor = user;
      expect(profileSchema.parse((await app.inject('/api/v1/profile')).json()).personalPrompt).toBe(
        '',
      );
      expect((await save(`  ${user.role} 개인 지침\n예시 포함  `)).statusCode).toBe(200);
    }
    for (const user of users) {
      actor = user;
      const profile = profileSchema.parse((await app.inject('/api/v1/profile')).json());
      expect(profile.personalPrompt).toBe(`${user.role} 개인 지침\n예시 포함`);
      expect(userSchema.parse(profile)).not.toHaveProperty('personalPrompt');
      const fresh = createDatabase(database.options.connectionString!);
      try {
        expect(await readPersonalPrompt(fresh, user.id)).toBe(profile.personalPrompt);
      } finally {
        await fresh.end();
      }
    }
  });

  it('does not accept another user id and does not leak Prompt content into audit', async () => {
    actor = users[0]!;
    const before = await readPersonalPrompt(database, users[1]!.id);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/profile/prompt',
          payload: { personalPrompt: '타 사용자 변경 시도', userId: users[1]!.id },
        })
      ).statusCode,
    ).toBe(400);
    expect(await readPersonalPrompt(database, users[1]!.id)).toBe(before);
    const audit = await database.query(
      "select * from audit_events where action = 'user.prompt.update'",
    );
    expect(audit.rows).toHaveLength(3);
    expect(JSON.stringify(audit.rows)).not.toContain('개인 지침');
    expect(JSON.stringify(audit.rows)).not.toContain('타 사용자 변경 시도');
  });

  it('supports the maximum length and removes only the current user preference', async () => {
    actor = users[0]!;
    expect((await save('가'.repeat(4000))).statusCode).toBe(200);
    expect((await save('가'.repeat(4001))).statusCode).toBe(400);
    expect((await save(' \n ')).json().personalPrompt).toBe('');
    expect(await readPersonalPrompt(database, actor.id)).toBe('');
    expect(await readPersonalPrompt(database, users[1]!.id)).toBe(
      'administrator 개인 지침\n예시 포함',
    );
    await expect(
      database.query('update users set personal_prompt = $2 where id = $1', [
        actor.id,
        'x'.repeat(4001),
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
