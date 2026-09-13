import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import {
  criterionCreateSchema,
  criterionDetailSchema,
  criterionListSchema,
  criterionSourceListSchema,
  criterionGenerationListSchema,
  criterionRoleListSchema,
  type CriterionDetail,
} from '@gcr/contracts';
import { ZodError } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { createServer } from '../../../web/src/review-criteria-test-server.js';
import type { AuthUser } from '../auth/index.js';
import { loadConfig, type AppConfig } from '../config.js';
import {
  claimCriterionGeneration,
  executeCriterionGeneration,
  type CriterionModelResolver,
} from '../services/criterion-generation.js';
import { AuthorizationService } from '../services/authorization.js';
import { criteriaHash } from '../services/review-criteria.js';
import { registerReviewCriteriaRoutes } from './review-criteria.js';

const databaseUrl = process.env.GCR_TEST_DATABASE_URL;
const fixture = () =>
  criterionCreateSchema.parse({
    document: {
      title: '테넌트별 캐시 분리',
      topicKey: 'cache.tenant-isolation',
      requirement: '테넌트마다 캐시 키를 분리한다.',
      rationale: '다른 테넌트의 값을 반환하지 않도록 한다.',
      severity: 'P2',
      appliesTo: { languages: ['Python'], filePaths: ['cache.py'] },
      counterEvidence: ['호출부에서 이미 테넌트별 캐시를 분리하면 성립하지 않는다.'],
      reviewSteps: ['키 생성과 실제 캐시 조회 호출부를 확인한다.'],
    },
    decision: {
      outcome: 'defect',
      reasoning: '합성 예제의 두 테넌트가 같은 키를 사용했다.',
      sources: [
        { kind: 'manual', content: 'Synthetic review: get(key) returned another tenant value.' },
      ],
    },
  });
const evaluation = () => ({
  note: 'Synthetic manual evaluation record; no model was invoked.',
  cases: [
    {
      kind: 'defect',
      name: '테넌트가 빠진 키',
      source: 'cache[key]',
      observed: 'finding',
      evidence: 'A와 B의 같은 key가 충돌한다.',
    },
    {
      kind: 'fixed',
      name: '복합 키',
      source: 'cache[(tenant, key)]',
      observed: 'clear',
      evidence: 'tenant가 키에 포함된다.',
    },
    {
      kind: 'normal',
      name: '테넌트별 인스턴스',
      source: 'tenant_caches[tenant][key]',
      observed: 'clear',
      evidence: '인스턴스가 테넌트별로 분리된다.',
    },
    {
      kind: 'counter-evidence',
      name: '호출부의 분리',
      source: 'cache = tenant_caches[tenant]\ncache[key]',
      observed: 'clear',
      evidence: '실제 호출부가 테넌트 범위를 한정한다.',
    },
  ],
});

describe.skipIf(!databaseUrl).sequential('repository review criteria workflow', () => {
  const schema = `gcr_criteria_test_${randomUUID().replaceAll('-', '')}`;
  const actors = new Map<string, AuthUser>();
  let root: Database, database: Database, app: FastifyInstance;
  let config: AppConfig;
  let modelAccountId: string;
  let tenantId: string,
    repositoryId: string,
    otherRepositoryId: string,
    personalMemoryId: string,
    collectiveMemoryId: string;
  const base = () => `/api/v1/repositories/${repositoryId}/review-criteria`;
  const headers = (key = 'maintainer') => ({ 'x-test-actor': key });
  const create = async (input = fixture(), actor = 'maintainer') => {
    const response = await app.inject({
      method: 'POST',
      url: base(),
      headers: headers(actor),
      payload: input,
    });
    expect(response.statusCode, response.body).toBe(201);
    return criterionDetailSchema.parse(response.json());
  };
  const action = (rule: CriterionDetail, action: string, actor = 'maintainer') =>
    app.inject({
      method: 'POST',
      url: `${base()}/${rule.criterion.id}/actions`,
      headers: headers(actor),
      payload: {
        expectedVersion: rule.criterion.version,
        action,
        note: 'Synthetic reviewer decision',
      },
    });
  const recordEvaluation = async (rule: CriterionDetail, data = evaluation()) => {
    const response = await app.inject({
      method: 'POST',
      url: `${base()}/${rule.criterion.id}/evaluations`,
      headers: headers(),
      payload: { expectedVersion: rule.criterion.version, ...data },
    });
    expect(response.statusCode, response.body).toBe(201);
    return criterionDetailSchema.parse(response.json());
  };
  const transition = async (rule: CriterionDetail, command: string, actor = 'maintainer') => {
    const response = await action(rule, command, actor);
    expect(response.statusCode, response.body).toBe(200);
    return criterionDetailSchema.parse(response.json());
  };

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw Error('Use an isolated local PostgreSQL');
    root = createDatabase(url.toString());
    await root.query(`create schema ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    database = createDatabase(url.toString());
    await runMigrations(database, path.resolve('packages/db/migrations'));
    tenantId = (
      await database.query(
        "insert into tenants(slug, display_name) values('criteria-test','Criteria test') returning id",
      )
    ).rows[0].id;
    for (const key of ['maintainer', 'reader', 'owner', 'outsider', 'admin']) {
      const role = key === 'admin' ? 'administrator' : 'reviewer';
      const id = (
        await database.query(
          'insert into users(oidc_subject, display_name, role) values($1,$2,$3) returning id',
          [`synthetic:${key}`, key, role],
        )
      ).rows[0].id;
      actors.set(key, {
        id,
        subject: `synthetic:${key}`,
        displayName: key,
        role,
        enabled: true,
        groups: [],
        tenantIds: key === 'outsider' ? [] : [tenantId],
        tenants: [{ id: tenantId, slug: 'criteria-test', displayName: 'Criteria test' }],
      });
      if (key !== 'outsider')
        await database.query('insert into tenant_memberships(tenant_id, user_id) values($1,$2)', [
          tenantId,
          id,
        ]);
    }
    const instanceId = (
      await database.query(
        "insert into github_instances(name, api_base_url, web_base_url) values('criteria','https://github.example/api/v3/','https://github.example/') returning id",
      )
    ).rows[0].id;
    for (const [githubId, name] of [
      [1, 'criteria'],
      [2, 'other'],
    ] as const) {
      const id = (
        await database.query(
          "insert into repositories(tenant_id, instance_id, github_id, installation_id, owner, name) values($1,$2,$3,1,'synthetic',$4) returning id",
          [tenantId, instanceId, githubId, name],
        )
      ).rows[0].id;
      if (name === 'criteria') repositoryId = id;
      else otherRepositoryId = id;
    }
    for (const [key, actor] of actors) {
      if (key !== 'outsider')
        await database.query(
          "insert into repository_grants(repository_id, subject_or_group, role) values($1,$2,'reviewer')",
          [repositoryId, actor.subject],
        );
    }
    await database.query(
      "insert into review_criteria_roles(repository_id,user_id,role,granted_by) values($1,$2,'maintainer',$4),($1,$3,'security-owner',$4)",
      [
        repositoryId,
        actors.get('maintainer')!.id,
        actors.get('owner')!.id,
        actors.get('admin')!.id,
      ],
    );
    for (const scope of ['personal', 'collective']) {
      const id = (
        await database.query(
          `insert into review_memories(tenant_id, repository_id, scope, owner_user_id, kind, state, summary, search_text, aggregation_key, source_kind, content_hash)
        values($1,$2,$3,$4,'decision','candidate',$5,$5,$6,'manual',$6) returning id`,
          [
            tenantId,
            repositoryId,
            scope,
            scope === 'personal' ? actors.get('reader')!.id : null,
            `${scope} source`,
            'a'.repeat(64),
          ],
        )
      ).rows[0].id;
      if (scope === 'personal') personalMemoryId = id;
      else collectiveMemoryId = id;
    }
    modelAccountId = (
      await database.query(
        `insert into chat_accounts(display_name,provider_type,credential_ciphertext,credential_iv,credential_auth_tag,credential_fingerprint,created_by)
      values('Synthetic criteria model','chatgpt-account',$1,$1,$1,$2,$3) returning id`,
        [Buffer.from('synthetic-not-used'), 'b'.repeat(64), actors.get('admin')!.id],
      )
    ).rows[0].id;
    await database.query(
      "insert into chat_account_assignments(account_id,scope_type,scope_id,created_by) values($1,'all','*',$2)",
      [modelAccountId, actors.get('admin')!.id],
    );
    await database.query(
      "insert into chat_account_models(account_id,model_id,display_name,allowed_efforts,default_effort) values($1,'synthetic-model','Synthetic model',array['xhigh'],'xhigh')",
      [modelAccountId],
    );
    config = loadConfig({
      DATABASE_URL: url.toString(),
      AUTH_MODE: 'development',
      CREDENTIAL_REGISTRY_ENABLED: 'true',
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    });
    app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.user = actors.get(String(request.headers['x-test-actor'])) ?? null;
    });
    app.setErrorHandler((error, _request, reply) =>
      reply
        .code(error instanceof ZodError ? 400 : (error.statusCode ?? 500))
        .send({ error: { message: error.message } }),
    );
    // Only bootstrap identity/catalog are synthetic. Browser mutations use the
    // production criteria routes, services, migrations and a real PostgreSQL DB.
    app.get('/api/v1/me', async (request) => ({ schemaVersion: 1, ...request.user }));
    app.get('/api/v1/chat-accounts', async () => ({
      schemaVersion: 1,
      enabled: true,
      items: [
        {
          id: modelAccountId,
          displayName: 'Synthetic criteria model',
          health: 'ready',
          models: [
            {
              id: 'synthetic-model',
              displayName: 'Synthetic model',
              allowedEfforts: ['xhigh'],
              defaultEffort: 'xhigh',
            },
          ],
        },
      ],
    }));
    app.get('/api/v1/repositories', async () => ({
      schemaVersion: 1,
      nextCursor: null,
      items: [
        {
          id: repositoryId,
          tenantId,
          instanceId,
          owner: 'synthetic',
          name: 'criteria',
          githubId: '1',
          tenantSlug: 'criteria-test',
          tenantName: 'Criteria test',
          webBaseUrl: 'https://github.example/',
          lastPolledAt: null,
          nextPollAt: null,
          pollOutcome: null,
          pollError: null,
        },
      ],
    }));
    await registerReviewCriteriaRoutes(app, database, new AuthorizationService(config), config);
    await app.ready();
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    await database?.end();
    if (root) {
      await root.query(`drop schema if exists ${schema} cascade`);
      await root.end();
    }
  });

  it('requires repository access and delegated management', async () => {
    expect((await app.inject({ url: base() })).statusCode).toBe(401);
    expect((await app.inject({ url: base(), headers: headers('outsider') })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: base(),
          headers: headers('reader'),
          payload: fixture(),
        })
      ).statusCode,
    ).toBe(403);
    const read = criterionListSchema.parse(
      (await app.inject({ url: base(), headers: headers('reader') })).json(),
    );
    expect(read.capabilities).toEqual({ manage: false, approveOwner: false, delegate: false });
  });
  it('creates a distinct decision and immutable draft without rewriting memory state or inventing contributors', async () => {
    const input = fixture();
    input.decision.sources = [
      { kind: 'memory', id: collectiveMemoryId, contentHash: 'a'.repeat(64) },
    ];
    const result = await create(input);
    expect(result.criterion.state).toBe('draft');
    expect(result.revisions[0]!.decision.sources[0]!.content).toBe('collective source');
    expect(result.revisions[0]!.decision.sourceHash).toBe(
      criteriaHash(result.revisions[0]!.decision.sources),
    );
    const memory = (
      await database.query('select state, contributor_count from review_memories where id = $1', [
        collectiveMemoryId,
      ])
    ).rows[0];
    expect(memory).toEqual({ state: 'candidate', contributor_count: 1 });
    const second = await create(input);
    expect(second.criterion.id).not.toBe(result.criterion.id);
    expect(second.criterion.contentHash).toBe(result.criterion.contentHash);
  });
  it('never projects or promotes personal memory into a shared criterion', async () => {
    const sources = criterionSourceListSchema.parse(
      (await app.inject({ url: `${base()}/sources`, headers: headers() })).json(),
    );
    expect(sources.items.map(({ id }) => id)).toContain(collectiveMemoryId);
    expect(sources.items.map(({ id }) => id)).not.toContain(personalMemoryId);
    const input = fixture();
    input.decision.sources = [
      { kind: 'memory', id: personalMemoryId, contentHash: 'a'.repeat(64) },
    ];
    expect(
      (await app.inject({ method: 'POST', url: base(), headers: headers('admin'), payload: input }))
        .statusCode,
    ).toBe(404);
  });
  it('rejects changed source hashes and rolls back partial candidate creation', async () => {
    const before = (await database.query('select count(*)::int as count from review_rules')).rows[0]
      .count;
    const input = fixture();
    input.decision.sources = [
      { kind: 'memory', id: collectiveMemoryId, contentHash: 'b'.repeat(64) },
    ];
    expect(
      (await app.inject({ method: 'POST', url: base(), headers: headers(), payload: input }))
        .statusCode,
    ).toBe(409);
    expect(
      (await database.query('select count(*)::int as count from review_rules')).rows[0].count,
    ).toBe(before);
  });
  it('does not promote model candidates or unresolved questions from confidence or missing evaluations', async () => {
    const input = fixture();
    input.origin = 'model-candidate';
    const candidate = await create(input);
    expect((await action(candidate, 'activate')).statusCode).toBe(409);
    expect((await action(candidate, 'evaluate')).statusCode).toBe(409);
    input.decision.outcome = 'open-question';
    const unresolved = await recordEvaluation(await create(input));
    expect((await action(unresolved, 'evaluate')).statusCode).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: base(),
          headers: headers(),
          payload: { ...input, confidence: 1, verified: true },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('requires all four distinct cases and rejects the latest failed or incomplete evaluation', async () => {
    let candidate = await create();
    const incomplete = evaluation();
    incomplete.cases[3]!.observed = 'needs-context';
    candidate = await recordEvaluation(candidate, incomplete);
    expect(candidate.evaluations[0]!.passed).toBe(false);
    expect((await action(candidate, 'evaluate')).statusCode).toBe(409);
    candidate = await recordEvaluation(candidate);
    const failed = evaluation();
    failed.cases[2]!.observed = 'finding';
    candidate = await recordEvaluation(candidate, failed);
    expect((await action(candidate, 'evaluate')).statusCode).toBe(409);
    const duplicates = evaluation();
    duplicates.cases[3]!.kind = 'normal';
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${base()}/${candidate.criterion.id}/evaluations`,
          headers: headers(),
          payload: { ...duplicates, expectedVersion: candidate.criterion.version },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('supports evaluation, shadow, activation, revision and retirement while preserving the old bytes', async () => {
    let rule = await create();
    const first = rule.revisions[0]!;
    rule = await transition(await recordEvaluation(rule), 'evaluate');
    rule = await transition(rule, 'shadow');
    rule = await transition(rule, 'activate');
    const input = fixture();
    input.document.requirement = '호출부의 캐시 인스턴스까지 확인한다.';
    const changed = await app.inject({
      method: 'POST',
      url: `${base()}/${rule.criterion.id}/revisions`,
      headers: headers(),
      payload: { ...input, expectedVersion: rule.criterion.version },
    });
    expect(changed.statusCode, changed.body).toBe(201);
    rule = criterionDetailSchema.parse(changed.json());
    expect(rule.criterion.state).toBe('draft');
    expect(rule.criterion.revision).toBe(2);
    expect(rule.revisions[1]).toEqual(first);
    expect(rule.revisions[0]!.supersedes).toBe(1);
    expect(rule.criterion.contentHash).not.toBe(first.contentHash);
    expect((await action(rule, 'evaluate')).statusCode).toBe(409);
    rule = await transition(rule, 'retire');
    expect(rule.criterion.state).toBe('retired');
    expect((await action(rule, 'activate')).statusCode).toBe(409);
  });
  it('rejects concurrent edits and approvals made against the same version', async () => {
    const candidate = await create();
    const responses = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: 'POST',
          url: `${base()}/${candidate.criterion.id}/revisions`,
          headers: headers(),
          payload: { ...fixture(), expectedVersion: candidate.criterion.version },
        }),
      ),
    );
    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409]);
    const evaluated = await transition(await recordEvaluation(await create()), 'evaluate');
    const approvals = await Promise.all([action(evaluated, 'shadow'), action(evaluated, 'shadow')]);
    expect(approvals.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
  });
  it('requires an independent delegated owner for high risk criteria and rechecks revoked approval roles', async () => {
    const input = fixture();
    input.document.severity = 'P1';
    let rule = await transition(await recordEvaluation(await create(input)), 'evaluate');
    expect((await action(rule, 'shadow')).statusCode).toBe(409);
    expect((await action(rule, 'approve-owner', 'admin')).statusCode).toBe(403);
    rule = await transition(rule, 'approve-owner', 'owner');
    await database.query(
      "delete from review_criteria_roles where repository_id=$1 and user_id=$2 and role='security-owner'",
      [repositoryId, actors.get('owner')!.id],
    );
    expect((await action(rule, 'shadow')).statusCode).toBe(409);
    await database.query(
      "insert into review_criteria_roles(repository_id,user_id,role,granted_by) values($1,$2,'security-owner',$3)",
      [repositoryId, actors.get('owner')!.id, actors.get('admin')!.id],
    );
    rule = await transition(rule, 'shadow');
    expect(rule.criterion.state).toBe('shadow');
    const ownInput = fixture();
    await database.query(
      "insert into review_criteria_roles(repository_id,user_id,role,granted_by) values($1,$2,'security-owner',$3)",
      [repositoryId, actors.get('maintainer')!.id, actors.get('admin')!.id],
    );
    const self = await transition(await recordEvaluation(await create(ownInput)), 'evaluate');
    expect((await action(self, 'approve-owner')).statusCode).toBe(409);
    await database.query(
      "delete from review_criteria_roles where repository_id=$1 and user_id=$2 and role='security-owner'",
      [repositoryId, actors.get('maintainer')!.id],
    );
  });
  it('limits delegation and immediately removes editing capability on revocation', async () => {
    const input = { userId: actors.get('reader')!.id, role: 'maintainer', enabled: true };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `${base()}/roles`,
          headers: headers(),
          payload: input,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `${base()}/roles`,
          headers: headers('admin'),
          payload: input,
        })
      ).statusCode,
    ).toBe(200);
    await create(fixture(), 'reader');
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `${base()}/roles`,
          headers: headers('admin'),
          payload: { ...input, enabled: false },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: base(),
          headers: headers('reader'),
          payload: fixture(),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `${base()}/roles`,
          headers: headers('admin'),
          payload: { ...input, userId: actors.get('outsider')!.id },
        })
      ).statusCode,
    ).toBe(404);
  });
  it('honors group repository grants when delegating and validating an owner approval', async () => {
    const owner = actors.get('owner')!;
    owner.groups = ['criteria-security'];
    await database.query('update users set groups_json=$2::jsonb where id=$1', [
      owner.id,
      JSON.stringify(owner.groups),
    ]);
    await database.query(
      'delete from repository_grants where repository_id=$1 and subject_or_group=$2',
      [repositoryId, owner.subject],
    );
    await database.query(
      "insert into repository_grants(repository_id,subject_or_group,role) values($1,'group:criteria-security','reviewer')",
      [repositoryId],
    );
    try {
      const delegated = await app.inject({
        method: 'PUT',
        url: `${base()}/roles`,
        headers: headers('admin'),
        payload: { userId: owner.id, role: 'security-owner', enabled: true },
      });
      expect(delegated.statusCode, delegated.body).toBe(200);
      const input = fixture();
      input.document.severity = 'P1';
      let rule = await transition(await recordEvaluation(await create(input)), 'evaluate');
      rule = await transition(rule, 'approve-owner', 'owner');
      rule = await transition(rule, 'shadow');
      expect(rule.criterion.state).toBe('shadow');
    } finally {
      owner.groups = [];
      await database.query("update users set groups_json='[]'::jsonb where id=$1", [owner.id]);
      await database.query(
        "delete from repository_grants where repository_id=$1 and subject_or_group='group:criteria-security'",
        [repositoryId],
      );
      await database.query(
        "insert into repository_grants(repository_id,subject_or_group,role) values($1,$2,'reviewer')",
        [repositoryId, owner.subject],
      );
    }
  });
  it('keeps repository identity authoritative even for administrators', async () => {
    const rule = await create();
    const response = await app.inject({
      url: `/api/v1/repositories/${otherRepositoryId}/review-criteria/${rule.criterion.id}`,
      headers: headers('admin'),
    });
    expect(response.statusCode).toBe(404);
  });
  it('rejects direct history changes at the database boundary', async () => {
    const rule = await recordEvaluation(await create());
    await expect(
      database.query("update review_rule_revisions set document = '{}' where rule_id=$1", [
        rule.criterion.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.query("update review_decisions set reasoning = 'rewritten' where id=$1", [
        rule.revisions[0]!.decision.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.query('delete from review_rule_events where rule_id=$1', [rule.criterion.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.query('update review_rule_evaluations set passed=false where rule_id=$1', [
        rule.criterion.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('accepts reader corrections without changing the criterion and records an immutable acknowledgement', async () => {
    const original = await create();
    const response = await app.inject({
      method: 'POST',
      url: `${base()}/${original.criterion.id}/feedback`,
      headers: headers('reader'),
      payload: {
        expectedVersion: original.criterion.version,
        request: {
          kind: 'correction',
          message: '현재 호출부는 이미 테넌트별 인스턴스를 사용합니다.',
        },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const requested = criterionDetailSchema.parse(response.json());
    expect(requested.criterion.contentHash).toBe(original.criterion.contentHash);
    expect(requested.criterion.revision).toBe(1);
    const url = `${base()}/${original.criterion.id}/feedback/${requested.feedback[0]!.id}/resolution`;
    const payload = {
      expectedVersion: requested.criterion.version,
      action: 'acknowledge',
      note: '호출부를 확인하고 필요한 경우 새 버전으로 수정합니다.',
    };
    expect(
      (await app.inject({ method: 'POST', url, headers: headers('reader'), payload })).statusCode,
    ).toBe(403);
    const resolved = await app.inject({ method: 'POST', url, headers: headers(), payload });
    expect(resolved.statusCode, resolved.body).toBe(200);
    const detail = criterionDetailSchema.parse(resolved.json());
    expect(detail.feedback[0]!.resolution?.action).toBe('acknowledge');
    expect(detail.criterion.contentHash).toBe(original.criterion.contentHash);
    await expect(
      database.query('delete from review_rule_feedback where id=$1', [requested.feedback[0]!.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('approves scoped exceptions independently and preserves expiration, revocation and revision boundaries', async () => {
    let rule = await transition(
      await transition(
        await transition(await recordEvaluation(await create()), 'evaluate'),
        'shadow',
      ),
      'activate',
    );
    const originalHash = rule.criterion.contentHash;
    const terms = {
      appliesTo: { filePaths: ['legacy/cache.py'], branches: ['release/1'] },
      startsAt: new Date(Date.now() - 3600000).toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    const propose = async (actor = 'reader', overrides = {}) => {
      const response = await app.inject({
        method: 'POST',
        url: `${base()}/${rule.criterion.id}/feedback`,
        headers: headers(actor),
        payload: {
          expectedVersion: rule.criterion.version,
          request: {
            kind: 'exception',
            message: '레거시 소비자 전환 기간에 한정합니다.',
            terms: { ...terms, ...overrides },
          },
        },
      });
      if (response.statusCode === 201) rule = criterionDetailSchema.parse(response.json());
      return response;
    };
    const resolve = (
      actor: string,
      requestId = rule.feedback[0]!.id,
      version = rule.criterion.version,
    ) =>
      app.inject({
        method: 'POST',
        url: `${base()}/${rule.criterion.id}/feedback/${requestId}/resolution`,
        headers: headers(actor),
        payload: {
          expectedVersion: version,
          action: 'approve-exception',
          note: '지정 범위·기간 및 보완 통제를 확인했습니다.',
        },
      });
    expect((await propose('reader', { appliesTo: {} })).statusCode).toBe(400);
    expect((await propose('reader', { expiresAt: terms.startsAt })).statusCode).toBe(400);
    expect((await propose('outsider')).statusCode).toBe(404);
    expect((await propose('owner')).statusCode).toBe(201);
    expect((await resolve('owner')).statusCode).toBe(409);
    expect((await propose()).statusCode).toBe(201);
    expect((await resolve('reader')).statusCode).toBe(403);
    expect((await resolve('maintainer')).statusCode).toBe(403);
    const approvals = await Promise.all([resolve('owner'), resolve('owner')]);
    expect(approvals.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    rule = criterionDetailSchema.parse(
      approvals.find((response) => response.statusCode === 200)!.json(),
    );
    expect(rule.exceptions).toHaveLength(1);
    expect(rule.exceptions[0]).toMatchObject({
      status: 'active',
      revision: 1,
      appliesTo: { filePaths: ['legacy/cache.py'] },
    });
    expect(rule.criterion.contentHash).toBe(originalHash);
    const exceptionId = rule.exceptions[0]!.id;
    const revokeUrl = `${base()}/${rule.criterion.id}/exceptions/${exceptionId}/revocation`;
    const revokePayload = {
      expectedVersion: rule.criterion.version,
      note: '소비자 전환을 마쳐 예외를 철회합니다.',
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: revokeUrl,
          headers: headers('reader'),
          payload: revokePayload,
        })
      ).statusCode,
    ).toBe(403);
    const revoked = await app.inject({
      method: 'POST',
      url: revokeUrl,
      headers: headers(),
      payload: revokePayload,
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    rule = criterionDetailSchema.parse(revoked.json());
    expect(rule.exceptions[0]!.status).toBe('revoked');
    await expect(
      database.query("update review_rule_exceptions set reason='changed' where id=$1", [
        exceptionId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      (
        await propose('reader', {
          startsAt: new Date(Date.now() - 7200000).toISOString(),
          expiresAt: new Date(Date.now() - 3600000).toISOString(),
        })
      ).statusCode,
    ).toBe(201);
    expect((await resolve('owner')).statusCode).toBe(409);
    expect(
      (await propose('reader', { startsAt: new Date(Date.now() + 3600000).toISOString() }))
        .statusCode,
    ).toBe(201);
    rule = criterionDetailSchema.parse((await resolve('owner')).json());
    expect(rule.exceptions[0]!.status).toBe('scheduled');
    expect((await propose()).statusCode).toBe(201);
    const pending = rule.feedback[0]!.id;
    const revised = await app.inject({
      method: 'POST',
      url: `${base()}/${rule.criterion.id}/revisions`,
      headers: headers(),
      payload: { ...fixture(), expectedVersion: rule.criterion.version },
    });
    expect(revised.statusCode, revised.body).toBe(201);
    rule = criterionDetailSchema.parse(revised.json());
    expect(rule.exceptions.map((item) => item.status)).toEqual(['superseded', 'revoked']);
    expect((await resolve('owner', pending)).statusCode).toBe(409);
  });
  it('allows repository deletion to cascade through immutable criterion history', async () => {
    const repository = (
      await database.query(
        `insert into repositories(tenant_id, instance_id, github_id, installation_id, owner, name)
      select tenant_id, instance_id, 99999, installation_id, owner, 'deletion-fixture' from repositories where id=$1 returning id`,
        [repositoryId],
      )
    ).rows[0].id;
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/repositories/${repository}/review-criteria`,
      headers: headers('admin'),
      payload: fixture(),
    });
    expect(response.statusCode, response.body).toBe(201);
    const rule = criterionDetailSchema.parse(response.json());
    await database.query('delete from repositories where id=$1', [repository]);
    expect(
      (await database.query('select id from review_rules where id=$1', [rule.criterion.id]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await database.query('select id from review_decisions where id=$1', [
          rule.revisions[0]!.decision.id,
        ])
      ).rowCount,
    ).toBe(0);
  });
  const generationInput = () => ({
    requestId: randomUUID(),
    accountId: modelAccountId,
    modelName: 'synthetic-model',
    reasoningEffort: 'xhigh',
    focus: '테넌트 캐시 분리 조건을 정리해 주세요.',
    sources: fixture().decision.sources,
  });
  const generation = async (input = generationInput(), actor = 'maintainer') =>
    app.inject({
      method: 'POST',
      url: `${base()}/generations`,
      headers: headers(actor),
      payload: input,
    });
  const generationState = async (id: string) =>
    criterionGenerationListSchema
      .parse((await app.inject({ url: `${base()}/generations`, headers: headers() })).json())
      .items.find((item) => item.id === id)!;
  const generated = () => {
    const input = fixture();
    return JSON.stringify({
      document: input.document,
      decision: { outcome: input.decision.outcome, reasoning: input.decision.reasoning },
    });
  };
  const resolver =
    (
      turn: NonNullable<import('../services/chat-model.js').ChatModel['turn']>,
    ): CriterionModelResolver =>
    async () => ({
      accountId: modelAccountId,
      accountName: 'Synthetic criteria model',
      modelName: 'synthetic-model',
      modelDisplayName: 'Synthetic model',
      reasoningEffort: 'xhigh',
      credentialVersion: 1,
      model: {
        name: 'synthetic-model',
        generate: async () => {
          throw Error('Unexpected legacy call');
        },
        turn,
      },
    });
  const modelResult = (content = generated()) => ({ content, output: [], calls: [], usage: null });
  it('enqueues a model request once, claims it once, and creates only an unevaluated model candidate', async () => {
    const input = generationInput();
    expect((await generation(input, 'reader')).statusCode).toBe(403);
    expect((await generation(input, 'outsider')).statusCode).toBe(404);
    expect((await generation({ ...input, accountId: randomUUID() })).statusCode).toBe(403);
    const requests = await Promise.all([generation(input), generation(input)]);
    expect(requests.map((item) => item.statusCode)).toEqual([202, 202]);
    expect((await generation({ ...input, focus: 'changed' })).statusCode).toBe(409);
    expect((await generation()).statusCode).toBe(409);
    const claims = await Promise.all([
      claimCriterionGeneration(database, 'one'),
      claimCriterionGeneration(database, 'two'),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    let calls = 0;
    await executeCriterionGeneration(
      database,
      config,
      claims.find(Boolean)!,
      resolver(async (request) => {
        calls++;
        expect(request.tools).toEqual([]);
        expect(request.reasoningEffort).toBe('xhigh');
        expect(JSON.stringify(request.input)).not.toContain('personal source');
        return modelResult();
      }),
    );
    const state = await generationState(input.requestId);
    expect(state.state).toBe('completed');
    expect(calls).toBe(1);
    const detail = criterionDetailSchema.parse(
      (await app.inject({ url: `${base()}/${state.ruleId}`, headers: headers() })).json(),
    );
    expect(detail.criterion).toMatchObject({ state: 'draft', origin: 'model-candidate' });
    expect(detail.evaluations).toHaveLength(0);
    expect(detail.generation?.modelName).toBe('synthetic-model');
    expect((await action(detail, 'evaluate')).statusCode).toBe(409);
    expect((await generation(input)).statusCode).toBe(202);
    expect(await claimCriterionGeneration(database, 'again')).toBeNull();
    expect(calls).toBe(1);
    const other = criterionGenerationListSchema.parse(
      (await app.inject({ url: `${base()}/generations`, headers: headers('admin') })).json(),
    );
    expect(other.items).toHaveLength(0);
  });
  it('rejects personal source inputs and discards generation when source or management access changes', async () => {
    const privateInput = {
      ...generationInput(),
      sources: [{ kind: 'memory', id: personalMemoryId, contentHash: 'a'.repeat(64) }],
    };
    expect((await generation(privateInput)).statusCode).toBe(404);
    const input = {
      ...generationInput(),
      sources: [{ kind: 'memory', id: collectiveMemoryId, contentHash: 'c'.repeat(64) }],
    };
    // Earlier source-version test changed this fixture's current hash.
    const hash = (
      await database.query('select content_hash from review_memories where id=$1', [
        collectiveMemoryId,
      ])
    ).rows[0].content_hash;
    input.sources[0]!.contentHash = hash;
    expect((await generation(input)).statusCode).toBe(202);
    const run = (await claimCriterionGeneration(database, 'source-change'))!;
    await executeCriterionGeneration(
      database,
      config,
      run,
      resolver(async () => {
        await database.query('update review_memories set content_hash=$2 where id=$1', [
          collectiveMemoryId,
          'd'.repeat(64),
        ]);
        return modelResult();
      }),
    );
    expect(await generationState(input.requestId)).toMatchObject({
      state: 'failed',
      ruleId: null,
      errorCode: 'GENERATION_SOURCE_CHANGED',
    });
    await database.query('update review_memories set content_hash=$2 where id=$1', [
      collectiveMemoryId,
      hash,
    ]);
    const revoked = generationInput();
    expect((await generation(revoked)).statusCode).toBe(202);
    const claimed = (await claimCriterionGeneration(database, 'revocation'))!;
    await executeCriterionGeneration(
      database,
      config,
      claimed,
      resolver(async () => {
        await database.query(
          "delete from review_criteria_roles where repository_id=$1 and user_id=$2 and role='maintainer'",
          [repositoryId, actors.get('maintainer')!.id],
        );
        return modelResult();
      }),
    );
    await database.query(
      "insert into review_criteria_roles(repository_id,user_id,role,granted_by) values($1,$2,'maintainer',$3)",
      [repositoryId, actors.get('maintainer')!.id, actors.get('admin')!.id],
    );
    expect(await generationState(revoked.requestId)).toMatchObject({
      state: 'failed',
      ruleId: null,
      errorCode: 'GENERATION_ACCESS_REVOKED',
    });
  });
  it('keeps malformed and lost model results out of criteria and never automatically replays them', async () => {
    for (const content of [
      'not JSON',
      JSON.stringify({ ...JSON.parse(generated()), approved: true }),
    ]) {
      const input = generationInput();
      expect((await generation(input)).statusCode).toBe(202);
      await executeCriterionGeneration(
        database,
        config,
        (await claimCriterionGeneration(database, 'invalid'))!,
        resolver(async () => modelResult(content)),
      );
      expect(await generationState(input.requestId)).toMatchObject({
        state: 'failed',
        ruleId: null,
        errorCode: 'MODEL_OUTPUT_INVALID',
      });
    }
    const input = generationInput();
    await generation(input);
    const lost = (await claimCriterionGeneration(database, 'lost'))!;
    await database.query(
      "update review_criterion_generations set deadline_at=clock_timestamp()-interval '1 second' where id=$1",
      [input.requestId],
    );
    expect(await claimCriterionGeneration(database, 'replacement')).toBeNull();
    let calls = 0;
    await executeCriterionGeneration(
      database,
      config,
      lost,
      resolver(async () => {
        calls++;
        return modelResult();
      }),
    );
    expect(calls).toBe(0);
    expect(await generationState(input.requestId)).toMatchObject({
      state: 'uncertain',
      ruleId: null,
      errorCode: 'EXECUTION_LOST',
    });
  });
  it('cancels queued and in-flight requests without creating a candidate and exposes delegated roles only to admins', async () => {
    expect((await app.inject({ url: `${base()}/roles`, headers: headers() })).statusCode).toBe(403);
    const roles = criterionRoleListSchema.parse(
      (await app.inject({ url: `${base()}/roles`, headers: headers('admin') })).json(),
    );
    expect(roles.users.find((user) => user.id === actors.get('maintainer')!.id)?.roles).toContain(
      'maintainer',
    );
    expect(roles.users.some((user) => user.id === actors.get('outsider')!.id)).toBe(false);
    const input = generationInput();
    await generation(input);
    const cancel = () =>
      app.inject({
        method: 'POST',
        url: `${base()}/generations/${input.requestId}/cancel`,
        headers: headers(),
        payload: {},
      });
    expect((await cancel()).statusCode).toBe(200);
    expect(await claimCriterionGeneration(database, 'cancelled')).toBeNull();
    const running = generationInput();
    await generation(running);
    const run = (await claimCriterionGeneration(database, 'cancel-running'))!;
    await executeCriterionGeneration(
      database,
      config,
      run,
      resolver(async () => {
        const response = await app.inject({
          method: 'POST',
          url: `${base()}/generations/${running.requestId}/cancel`,
          headers: headers(),
          payload: {},
        });
        expect(response.statusCode).toBe(200);
        return modelResult();
      }),
    );
    expect(await generationState(running.requestId)).toMatchObject({
      state: 'cancelled',
      ruleId: null,
    });
  });
  it('creates, evaluates, activates, edits and retires a criterion through Chrome and the real API', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw Error('Owned HTTP server required');
    const vite = await createServer({
      root: path.resolve('apps/web'),
      server: { host: '127.0.0.1', port: 0, proxy: { '/api': `http://127.0.0.1:${address.port}` } },
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const errors: string[] = [];
    try {
      await vite.listen();
      const webAddress = vite.httpServer!.address();
      if (!webAddress || typeof webAddress === 'string') throw Error('Owned Vite server required');
      browser = await chromium.launch({ channel: 'chrome', headless: true });
      const context = await browser.newContext({
        viewport: { width: 1360, height: 1050 },
        extraHTTPHeaders: headers(),
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${webAddress.port}/review-criteria`);
      await page.getByText('원문에서 모델 후보 생성', { exact: true }).click();
      await page.getByLabel('모델 계정', { exact: true }).selectOption(modelAccountId);
      await page.getByLabel('후보 생성 모델', { exact: true }).selectOption('synthetic-model');
      await page.getByLabel('검토 초점', { exact: true }).fill('Synthetic browser generation.');
      await page
        .getByLabel('모델에 전달할 수동 원문', { exact: true })
        .fill('Synthetic source: cache key must contain tenant.');
      await page.getByRole('button', { name: '후보 생성 요청', exact: true }).click();
      await page.getByText('대기 중', { exact: true }).waitFor();
      const previousCandidates = await page
        .getByRole('button', { name: '생성한 후보 보기', exact: true })
        .count();
      const generatedRun = await claimCriterionGeneration(database, 'browser');
      expect(generatedRun).not.toBeNull();
      const generatedBody = JSON.parse(generated());
      generatedBody.document.title = '모델 생성 브라우저 기준';
      await executeCriterionGeneration(
        database,
        config,
        generatedRun!,
        resolver(async () => modelResult(JSON.stringify(generatedBody))),
      );
      expect(await generationState(generatedRun!.id)).toMatchObject({ state: 'completed' });
      await expect
        .poll(() => page.getByRole('button', { name: '생성한 후보 보기', exact: true }).count(), {
          timeout: 10000,
        })
        .toBe(previousCandidates + 1);
      await page.getByRole('button', { name: '생성한 후보 보기', exact: true }).first().click();
      await page.getByRole('heading', { name: '모델 생성 브라우저 기준', exact: true }).waitFor();
      await page
        .getByText('최초 후보 생성 모델: synthetic-model · xhigh', { exact: true })
        .waitFor();
      await context.setExtraHTTPHeaders(headers('admin'));
      await page.reload();
      await page.getByText('저장소 유지관리자·책임자 지정', { exact: true }).click();
      const readerRole = page.getByRole('checkbox', { name: 'reader 유지관리자', exact: true });
      const grantResponse = page.waitForResponse(
        (response) => response.url().endsWith('/roles') && response.request().method() === 'PUT',
      );
      await readerRole.check();
      expect((await grantResponse).status()).toBe(200);
      const revokeResponse = page.waitForResponse(
        (response) => response.url().endsWith('/roles') && response.request().method() === 'PUT',
      );
      await readerRole.uncheck();
      expect((await revokeResponse).status()).toBe(200);
      await context.setExtraHTTPHeaders(headers());
      await page.reload();
      await page.getByRole('button', { name: '후보 등록', exact: true }).click();
      await page.getByLabel('제목', { exact: true }).fill('브라우저 검증: 테넌트 캐시');
      await page.getByLabel('주제 키').fill('cache.browser');
      await page.getByLabel('검토 기준', { exact: true }).fill('테넌트별 캐시를 분리한다.');
      await page.getByLabel('기준의 이유').fill('다른 테넌트의 데이터 유출 방지');
      await page.getByLabel('판단 근거').fill('Synthetic shared-cache fixture review.');
      await page
        .getByLabel('반증 조건')
        .fill('호출부에서 테넌트별 인스턴스를 선택하면 성립하지 않는다.');
      await page.getByLabel('검토 절차').fill('캐시 호출부와 키를 확인한다.');
      await page
        .getByLabel('수동 검토 기록')
        .fill('<script>window.untrustedSourceExecuted = true</script> Synthetic source.');
      await page.getByRole('button', { name: '후보 저장', exact: true }).click();
      await page.getByRole('button', { name: '평가 기록 추가', exact: true }).click();
      for (const [index, label] of ['결함', '수정', '정상', '반증'].entries()) {
        const item = evaluation().cases[index]!;
        await page.getByLabel(`${label} 사례 이름`, { exact: true }).fill(item.name);
        await page.getByLabel(`${label} 코드`, { exact: true }).fill(item.source);
        await page.getByLabel(`${label} 결과`, { exact: true }).selectOption(item.observed);
        await page.getByLabel(`${label} 근거`, { exact: true }).fill(item.evidence);
      }
      await page
        .getByLabel('평가 메모', { exact: true })
        .fill('Browser synthetic manual evaluation.');
      await page.getByRole('button', { name: '평가 기록 저장', exact: true }).click();
      for (const [label, state] of [
        ['평가 통과 처리', '평가 통과'],
        ['관찰 시작', '관찰 중'],
        ['활성화', '활성'],
      ]) {
        await page.getByLabel('검토 메모', { exact: true }).fill('Synthetic maintainer approval');
        await page.getByRole('button', { name: label, exact: true }).click();
        await page.getByText(`${state} · P2 · v1 · Advisory`, { exact: true }).waitFor();
      }
      await context.setExtraHTTPHeaders(headers('reader'));
      await page.reload();
      await page.getByRole('button', { name: /브라우저 검증: 테넌트 캐시/ }).click();
      expect(await page.getByRole('button', { name: '새 버전 작성', exact: true }).count()).toBe(0);
      await page
        .getByLabel('요청 근거', { exact: true })
        .fill('Synthetic reader correction: check the caller.');
      await page.getByRole('button', { name: '요청 제출', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.getByText('정정 요청', { exact: true }).waitFor();
      await page.getByLabel('요청 종류', { exact: true }).selectOption('exception');
      await page
        .getByLabel('요청 근거', { exact: true })
        .fill('Synthetic bounded migration exception.');
      await page.getByLabel('예외 파일 경로', { exact: true }).fill('legacy/cache.py');
      const localDate = (offset: number) => {
        const date = new Date(Date.now() + offset);
        date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
        return date.toISOString().slice(0, 16);
      };
      await page.getByLabel('예외 시작', { exact: true }).fill(localDate(-3600000));
      await page.getByLabel('예외 만료', { exact: true }).fill(localDate(86400000));
      await page.getByRole('button', { name: '요청 제출', exact: true }).click();
      await page.getByText('예외 요청', { exact: true }).waitFor();
      await context.setExtraHTTPHeaders(headers('owner'));
      await page.reload();
      await page.getByRole('button', { name: /브라우저 검증: 테넌트 캐시/ }).click();
      await page
        .getByLabel('요청 검토 메모', { exact: true })
        .fill('Synthetic owner review: bounded scope and date.');
      await page.getByRole('button', { name: '예외 승인', exact: true }).click();
      await page.getByText('유효', { exact: true }).waitFor();
      await context.setExtraHTTPHeaders(headers());
      await page.reload();
      await page.getByRole('button', { name: /브라우저 검증: 테넌트 캐시/ }).click();
      await page
        .getByLabel('요청 검토 메모', { exact: true })
        .fill('Synthetic migration is complete.');
      await page.getByRole('button', { name: '예외 철회', exact: true }).click();
      await page.getByText('철회', { exact: true }).waitFor();
      await page.getByRole('button', { name: '새 버전 작성', exact: true }).click();
      await page
        .getByLabel('검토 기준', { exact: true })
        .fill('변경한 호출부의 테넌트 인스턴스도 확인한다.');
      await page.getByLabel('수동 검토 기록').fill('Synthetic revision source.');
      await page.getByRole('button', { name: '후보 저장', exact: true }).click();
      await page.getByLabel('검토 메모', { exact: true }).fill('Synthetic retirement');
      await page.getByRole('button', { name: '퇴역', exact: true }).click();
      await page.getByText('퇴역 · P2 · v2 · Advisory', { exact: true }).waitFor();
      expect(
        await page.evaluate(
          () => (window as unknown as Record<string, unknown>).untrustedSourceExecuted,
        ),
      ).toBeUndefined();
      expect(errors).toEqual([]);
      const stored = criterionListSchema
        .parse((await app.inject({ url: base(), headers: headers() })).json())
        .items.find((item) => item.document.title.startsWith('브라우저 검증'))!;
      expect(stored).toMatchObject({ state: 'retired', revision: 2 });
      const history = criterionDetailSchema.parse(
        (await app.inject({ url: `${base()}/${stored.id}`, headers: headers() })).json(),
      );
      expect(history.revisions).toHaveLength(2);
      expect(history.evaluations).toHaveLength(1);
      expect(history.events.map(({ action }) => action)).toEqual(
        expect.arrayContaining([
          'created',
          'evaluation-recorded',
          'evaluate',
          'shadow',
          'activate',
          'revised',
          'retire',
        ]),
      );
      if (process.env.GCR_CRITERIA_SCREENSHOT) {
        await mkdir(path.dirname(process.env.GCR_CRITERIA_SCREENSHOT), { recursive: true });
        await page.screenshot({ path: process.env.GCR_CRITERIA_SCREENSHOT, fullPage: false });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      if (process.env.GCR_CRITERIA_SCREENSHOT) {
        await page.screenshot({
          path: process.env.GCR_CRITERIA_SCREENSHOT.replace(/\.png$/, '-mobile.png'),
          fullPage: false,
        });
      }
      await context.close();
    } finally {
      const page = browser?.contexts()[0]?.pages()[0];
      if (page && process.env.GCR_CRITERIA_SCREENSHOT) {
        const target = process.env.GCR_CRITERIA_SCREENSHOT;
        await mkdir(path.dirname(target), { recursive: true });
        await page.screenshot({ path: target, fullPage: true });
        await writeFile(
          `${target}.json`,
          JSON.stringify({ errors, text: await page.locator('body').innerText() }, null, 2),
        );
      }
      await browser?.close();
      await vite.close();
    }
  }, 90_000);
});
