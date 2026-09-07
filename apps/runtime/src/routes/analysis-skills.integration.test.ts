import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createReviewSkillBundle, loadBuiltInReviewSkills } from '@gcr/analysis-engine';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthUser } from '../auth/index.js';
import { loadConfig } from '../config.js';
import {
  getEffectiveReviewSkills,
  resolvePinnedReviewSkills,
} from '../services/analysis-skills.js';
import { AuthorizationService } from '../services/authorization.js';
import { registerAnalysisSkillRoutes } from './analysis-skills.js';

const databaseUrl = process.env.GCR_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl).sequential('immutable analysis Skills with PostgreSQL', () => {
  const schema = `gcr_skills_test_${randomUUID().replaceAll('-', '')}`;
  const builtin = loadBuiltInReviewSkills();
  let root: Database, database: Database, app: FastifyInstance, admin: AuthUser;
  let role: 'administrator' | 'reviewer' = 'administrator';
  let firstId: string;
  const documents = (suffix = '') => builtin.skills.map((skill) => skill.markdown + suffix);
  const save = (suffix = '') =>
    app.inject({
      method: 'POST',
      url: '/api/v1/admin/analysis-skills/versions',
      payload: { documents: documents(suffix) },
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
    const user = (
      await database.query(
        "insert into users(oidc_subject, display_name, role) values ('synthetic:skills-admin', '검증 관리자', 'administrator') returning id",
      )
    ).rows[0];
    admin = {
      id: user.id,
      subject: 'synthetic:skills-admin',
      displayName: '검증 관리자',
      role: 'administrator',
      enabled: true,
      groups: [],
      tenantIds: [],
      tenants: [],
    };
    app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.user = { ...admin, role };
    });
    await registerAnalysisSkillRoutes(
      app,
      database,
      new AuthorizationService(
        loadConfig({ DATABASE_URL: 'postgresql://localhost/unused', AUTH_MODE: 'development' }),
      ),
    );
  });
  afterAll(async () => {
    await app?.close();
    await database?.end();
    if (root) {
      await root.query(`drop schema if exists ${schema} cascade`);
      await root.end();
    }
  });

  it('returns packaged defaults and persists a canonical immutable version with idempotent save', async () => {
    const initial = await app.inject('/api/v1/admin/analysis-skills');
    expect(initial.statusCode).toBe(200);
    expect(initial.json().effective).toMatchObject({
      versionId: null,
      source: 'builtin',
      bundle: { hash: builtin.hash },
    });
    const created = await save();
    expect(created.statusCode, created.body).toBe(201);
    firstId = created.json().id;
    expect((await save()).json().id).toBe(firstId);
    const effective = await getEffectiveReviewSkills(database);
    expect(effective.bundle).toEqual(builtin); // JSONB key order must not break validation.
    expect(effective.version).toBe(1);
    const row = (
      await database.query('select * from analysis_skill_versions where id = $1', [firstId])
    ).rows[0];
    expect(row.bundle.hash).toBe(row.content_hash);
    await expect(
      database.query("update analysis_skill_versions set bundle = '{}' where id = $1", [firstId]),
    ).rejects.toThrow('immutable');
    await expect(
      database.query('delete from analysis_skill_versions where id = $1', [firstId]),
    ).rejects.toThrow('cannot be deleted');
  });

  it('serializes concurrent saves and keeps a pinned bundle after activation/reset', async () => {
    const pinned = await getEffectiveReviewSkills(database);
    const results = await Promise.all([save('\n새 관점 A\n'), save('\n새 관점 B\n')]);
    expect(results.map((result) => result.statusCode)).toEqual([201, 201]);
    expect(
      (
        await database.query(
          'select count(*)::integer as count from analysis_skill_versions where active',
        )
      ).rows[0].count,
    ).toBe(1);
    const history = await app.inject('/api/v1/admin/analysis-skills');
    expect(history.json().items.map((item: { version: number }) => item.version)).toEqual([
      3, 2, 1,
    ]);
    expect(resolvePinnedReviewSkills(pinned.bundle, pinned.bundle.hash)).toEqual(builtin);
    const activated = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/analysis-skills/versions/${firstId}/activate`,
    });
    expect(activated.statusCode).toBe(200);
    expect((await getEffectiveReviewSkills(database)).versionId).toBe(firstId);
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/admin/analysis-skills/reset' })).statusCode,
    ).toBe(200);
    expect((await getEffectiveReviewSkills(database)).source).toBe('builtin');
    expect(resolvePinnedReviewSkills(pinned.bundle, pinned.bundle.hash)).toEqual(builtin);
    expect(() => resolvePinnedReviewSkills(pinned.bundle, '0'.repeat(64))).toThrow('hash');
    expect(resolvePinnedReviewSkills(null, null)).toBeUndefined();
  });

  it('preserves the current version on invalid input and missing activation', async () => {
    await save();
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/analysis-skills/versions',
      payload: { documents: documents().slice(1) },
    });
    // Remove correctness only: this remains valid because other perspectives are enabled.
    expect(invalid.statusCode).toBe(201);
    const current = await getEffectiveReviewSkills(database);
    const noForm = builtin.skills
      .filter((skill) => skill.name !== 'overall-summary')
      .map((skill) => skill.markdown);
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/analysis-skills/versions',
      payload: { documents: noForm },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe('INVALID_REVIEW_SKILLS');
    expect((await getEffectiveReviewSkills(database)).versionId).toBe(current.versionId);
    const absent = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/analysis-skills/versions/${randomUUID()}/activate`,
    });
    expect(absent.statusCode).toBe(404);
    expect((await getEffectiveReviewSkills(database)).versionId).toBe(current.versionId);
  });

  it('accepts a new perspective and does not write Skill text to audit metadata', async () => {
    const newSkill = builtin.skills
      .find((skill) => skill.name === 'correctness')!
      .markdown.replace('name: correctness', 'name: api-compatibility');
    const custom = [...documents(), newSkill];
    const saved = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/analysis-skills/versions',
      payload: { documents: custom },
    });
    expect(saved.statusCode).toBe(201);
    expect((await getEffectiveReviewSkills(database)).bundle.hash).toBe(
      createReviewSkillBundle(custom).hash,
    );
    const audit = await database.query(
      "select metadata from audit_events where resource_type = 'analysis_skill'",
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows.every((row) => Object.keys(row.metadata).join(',') === 'contentHash')).toBe(
      true,
    );
  });

  it('hides Skill content and write endpoints from reviewers', async () => {
    role = 'reviewer';
    expect((await app.inject('/api/v1/admin/analysis-skills')).statusCode).toBe(404);
    expect((await save()).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/admin/analysis-skills/reset' })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/admin/analysis-skills/versions/${firstId}/activate`,
        })
      ).statusCode,
    ).toBe(404);
    role = 'administrator';
  });
});
