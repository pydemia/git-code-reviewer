import {
  criterionCreateSchema,
  criterionRevisionCreateSchema,
  criterionEvaluationCreateSchema,
  criterionActionSchema,
  criterionFeedbackCreateSchema,
  criterionFeedbackResolutionSchema,
  criterionExceptionRevokeSchema,
  criterionRoleAssignmentSchema,
  criterionGenerationCreateSchema,
} from '@gcr/contracts';
import type { Database, DatabaseClient } from '@gcr/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/index.js';
import type { AuthorizationService } from '../services/authorization.js';
import {
  CriterionError,
  criteriaNotFound,
  criterionSelection,
  criterionJoins,
  listCriterionSources,
  createCriterion,
  lockCriterion,
  reviseCriterion,
  evaluateCriterion,
  actOnCriterion,
  submitCriterionFeedback,
  resolveCriterionFeedback,
  revokeCriterionException,
} from '../services/review-criteria.js';
import { canReadRepository } from './worklist.js';
import type { AppConfig } from '../config.js';
import { listAvailableChatAccounts } from '../services/account-registry.js';
import {
  enqueueCriterionGeneration,
  generationSelection,
} from '../services/criterion-generation.js';

const repositoryParams = z.object({ repoId: z.string().uuid() });
const ruleParams = repositoryParams.extend({ ruleId: z.string().uuid() });
const delegationSchema = criterionRoleAssignmentSchema;

export async function registerReviewCriteriaRoutes(
  app: FastifyInstance,
  database: Database,
  authorization: AuthorizationService,
  config?: AppConfig,
) {
  const capabilities = async (request: FastifyRequest, repositoryId: string) => {
    if (!(await canReadRepository(database, authorization, request, repositoryId)))
      throw criteriaNotFound();
    const roles = await database.query<{ role: string }>(
      'select role from review_criteria_roles where repository_id = $1 and user_id = $2',
      [repositoryId, request.user!.id],
    );
    const admin = request.user!.role === 'administrator';
    return {
      manage: admin || roles.rows.some(({ role }) => role === 'maintainer'),
      approveOwner: roles.rows.some(({ role }) =>
        ['security-owner', 'domain-owner'].includes(role),
      ),
      delegate:
        admin &&
        (await canReadRepository(database, authorization, request, repositoryId, 'manage')),
    };
  };
  const requirePermission = (allowed: boolean) => {
    if (!allowed)
      throw new CriterionError(
        403,
        'CRITERIA_PERMISSION_REQUIRED',
        '이 저장소의 리뷰 기준 관리 권한이 필요합니다.',
      );
  };
  const detail = async (request: FastifyRequest, repositoryId: string, ruleId: string) => {
    const access = await capabilities(request, repositoryId);
    const connection = await database.connect();
    try {
      await connection.query('begin isolation level repeatable read read only');
      const rule = await connection.query(
        `select ${criterionSelection} ${criterionJoins} where r.repository_id = $1 and r.id = $2`,
        [repositoryId, ruleId],
      );
      if (!rule.rows[0]) throw criteriaNotFound();
      const revisions = await connection.query(
        `select rev.revision, rev.supersedes, rev.content_hash as "contentHash", rev.document,
           rev.created_by as "createdBy", rev.created_at as "createdAt",
           jsonb_build_object('id', d.id, 'outcome', d.outcome, 'reasoning', d.reasoning, 'origin', d.origin,
             'sourceHash', d.source_hash, 'sources', d.sources) as decision
         from review_rule_revisions rev join review_decisions d on d.id = rev.decision_id
         where rev.rule_id = $1 order by rev.revision desc`,
        [ruleId],
      );
      const evaluations = await connection.query(
        `select id, revision, method, passed, cases, note, actor_user_id as "actorUserId", created_at as "createdAt"
        from review_rule_evaluations where rule_id = $1 order by created_at desc, id desc`,
        [ruleId],
      );
      const events = await connection.query(
        `select id, revision, action, actor_user_id as "actorUserId", note, created_at as "createdAt"
        from review_rule_events where rule_id = $1 order by created_at desc, id desc`,
        [ruleId],
      );
      const feedback = await connection.query(
        `select f.id, f.revision, f.request, f.created_by as "createdBy", f.created_at as "createdAt",
         (select content from review_rule_feedback_client_sources where feedback_id=f.id) as "clientSource",
         case when res.request_id is null then null else jsonb_build_object('action', res.action, 'note', res.note,
           'actorUserId', res.actor_user_id, 'createdAt', res.created_at) end as resolution
         from review_rule_feedback f left join review_rule_feedback_resolutions res on res.request_id = f.id
         where f.rule_id = $1 order by f.created_at desc, f.id`,
        [ruleId],
      );
      const exceptions = await connection.query(
        `select e.id, e.request_id as "requestId", e.revision, e.applies_to as "appliesTo", e.reason,
         e.starts_at as "startsAt", e.expires_at as "expiresAt", e.approved_by as "approvedBy",
         case when rev.exception_id is not null then 'revoked'
              when e.revision <> r.current_revision then 'superseded'
              when r.state = 'retired' then 'retired'
              when e.expires_at <= statement_timestamp() then 'expired'
              when e.starts_at > statement_timestamp() then 'scheduled' else 'active' end as status,
         case when rev.exception_id is null then null else jsonb_build_object('note', rev.note,
           'actorUserId', rev.actor_user_id, 'createdAt', rev.created_at) end as revocation
         from review_rule_exceptions e join review_rules r on r.id = e.rule_id
         left join review_rule_exception_revocations rev on rev.exception_id = e.id
         where e.rule_id = $1 order by e.created_at desc, e.id`,
        [ruleId],
      );
      const generation = await connection.query(
        `select ${generationSelection} from review_criterion_generations where rule_id=$1 and state='completed' limit 1`,
        [ruleId],
      );
      await connection.query('commit');
      return {
        schemaVersion: 1,
        criterion: rule.rows[0],
        generation: generation.rows[0] ?? null,
        capabilities: access,
        feedback: feedback.rows,
        exceptions: exceptions.rows,
        revisions: revisions.rows,
        evaluations: evaluations.rows,
        events: events.rows,
      };
    } catch (error) {
      await connection.query('rollback');
      throw error;
    } finally {
      connection.release();
    }
  };

  const mutate = async (
    request: FastifyRequest,
    repositoryId: string,
    action: string,
    operation: (connection: DatabaseClient) => Promise<string>,
  ) => {
    const connection = await database.connect();
    let ruleId: string;
    try {
      await connection.query('begin');
      ruleId = await operation(connection);
      await connection.query(
        `insert into audit_events(actor, action, resource_type, resource_id, outcome, request_id, metadata)
        values($1,$2,'review-criterion',$3,'success',$4,$5::jsonb)`,
        [request.user!.subject, action, ruleId, request.id, JSON.stringify({ repositoryId })],
      );
      await connection.query('commit');
    } catch (error) {
      await connection.query('rollback');
      throw error;
    } finally {
      connection.release();
    }
    return detail(request, repositoryId, ruleId);
  };

  // Encapsulation keeps domain error handling local to this feature.
  await app.register(async (routes) => {
    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof CriterionError)
        return reply.code(error.statusCode).send({
          error: {
            code: error.code,
            message: error.message,
            requestId: request.id,
            retryable: false,
          },
        });
      throw error;
    });
    const base = '/api/v1/repositories/:repoId/review-criteria';
    routes.get(base, { preHandler: requireUser }, async (request) => {
      const { repoId } = repositoryParams.parse(request.params);
      const access = await capabilities(request, repoId);
      const items = await database.query(
        `select ${criterionSelection} ${criterionJoins} where r.repository_id = $1 order by r.updated_at desc, r.id limit 100`,
        [repoId],
      );
      return { schemaVersion: 1, items: items.rows, capabilities: access };
    });
    routes.get(`${base}/sources`, { preHandler: requireUser }, async (request) => {
      const { repoId } = repositoryParams.parse(request.params);
      await capabilities(request, repoId);
      return { schemaVersion: 1, items: await listCriterionSources(database, repoId) };
    });
    routes.get(`${base}/:ruleId`, { preHandler: requireUser }, async (request) => {
      const { repoId, ruleId } = ruleParams.parse(request.params);
      return detail(request, repoId, ruleId);
    });
    routes.post(base, { preHandler: requireUser }, async (request, reply) => {
      const { repoId } = repositoryParams.parse(request.params);
      requirePermission((await capabilities(request, repoId)).manage);
      const input = criterionCreateSchema.parse(request.body);
      const result = await mutate(request, repoId, 'criterion.create', (connection) =>
        createCriterion(connection, repoId, request.user!.id, input),
      );
      return reply.code(201).send(result);
    });
    routes.post(
      `${base}/:ruleId/revisions`,
      { preHandler: requireUser },
      async (request, reply) => {
        const { repoId, ruleId } = ruleParams.parse(request.params);
        requirePermission((await capabilities(request, repoId)).manage);
        const input = criterionRevisionCreateSchema.parse(request.body);
        const result = await mutate(request, repoId, 'criterion.revise', async (connection) => {
          const rule = await lockCriterion(connection, repoId, ruleId, input.expectedVersion);
          await reviseCriterion(connection, rule, request.user!.id, input);
          return ruleId;
        });
        return reply.code(201).send(result);
      },
    );
    routes.post(
      `${base}/:ruleId/evaluations`,
      { preHandler: requireUser },
      async (request, reply) => {
        const { repoId, ruleId } = ruleParams.parse(request.params);
        requirePermission((await capabilities(request, repoId)).manage);
        const input = criterionEvaluationCreateSchema.parse(request.body);
        const result = await mutate(request, repoId, 'criterion.evaluate', async (connection) => {
          const rule = await lockCriterion(connection, repoId, ruleId, input.expectedVersion);
          await evaluateCriterion(connection, rule, request.user!.id, input);
          return ruleId;
        });
        return reply.code(201).send(result);
      },
    );
    routes.post(`${base}/:ruleId/actions`, { preHandler: requireUser }, async (request) => {
      const { repoId, ruleId } = ruleParams.parse(request.params);
      const access = await capabilities(request, repoId);
      const input = criterionActionSchema.parse(request.body);
      requirePermission(input.action === 'approve-owner' ? access.approveOwner : access.manage);
      return mutate(request, repoId, `criterion.${input.action}`, async (connection) => {
        const rule = await lockCriterion(connection, repoId, ruleId, input.expectedVersion);
        await actOnCriterion(connection, rule, request.user!.id, input);
        return ruleId;
      });
    });
    routes.post(`${base}/:ruleId/feedback`, { preHandler: requireUser }, async (request, reply) => {
      const { repoId, ruleId } = ruleParams.parse(request.params);
      await capabilities(request, repoId);
      const input = criterionFeedbackCreateSchema.parse(request.body);
      const result = await mutate(request, repoId, 'criterion.feedback', async (connection) => {
        const rule = await lockCriterion(connection, repoId, ruleId, input.expectedVersion);
        await submitCriterionFeedback(connection, rule, request.user!.id, input);
        return ruleId;
      });
      return reply.code(201).send(result);
    });
    routes.post(
      `${base}/:ruleId/feedback/:requestId/resolution`,
      { preHandler: requireUser },
      async (request) => {
        const { repoId, ruleId, requestId } = ruleParams
          .extend({ requestId: z.string().uuid() })
          .parse(request.params);
        const access = await capabilities(request, repoId);
        const input = criterionFeedbackResolutionSchema.parse(request.body);
        requirePermission(
          input.action === 'approve-exception'
            ? access.approveOwner
            : access.manage || access.approveOwner,
        );
        return mutate(request, repoId, 'criterion.feedback.resolve', async (connection) => {
          const rule = await lockCriterion(connection, repoId, ruleId, input.expectedVersion);
          await resolveCriterionFeedback(connection, rule, requestId, request.user!.id, input);
          return ruleId;
        });
      },
    );
    routes.post(
      `${base}/:ruleId/exceptions/:exceptionId/revocation`,
      { preHandler: requireUser },
      async (request) => {
        const { repoId, ruleId, exceptionId } = ruleParams
          .extend({ exceptionId: z.string().uuid() })
          .parse(request.params);
        const access = await capabilities(request, repoId);
        requirePermission(access.manage || access.approveOwner);
        const input = criterionExceptionRevokeSchema.parse(request.body);
        return mutate(request, repoId, 'criterion.exception.revoke', async (connection) => {
          const rule = await lockCriterion(connection, repoId, ruleId, input.expectedVersion);
          await revokeCriterionException(
            connection,
            rule,
            exceptionId,
            request.user!.id,
            input.note,
          );
          return ruleId;
        });
      },
    );
    routes.get(`${base}/roles`, { preHandler: requireUser }, async (request) => {
      const { repoId } = repositoryParams.parse(request.params);
      requirePermission((await capabilities(request, repoId)).delegate);
      const result = await database.query(
        `with candidates as (
        select u.id,u.display_name as "displayName",(u.enabled and u.deleted_at is null and (u.role='administrator' or (
          exists(select 1 from tenant_memberships m where m.user_id=u.id and m.tenant_id=r.tenant_id and m.enabled)
          and exists(select 1 from repository_grants g where g.repository_id=r.id and (g.subject_or_group=u.oidc_subject or g.subject_or_group in (select 'group:'||value from jsonb_array_elements_text(u.groups_json))))))) as eligible,
          array(select role from review_criteria_roles where repository_id=r.id and user_id=u.id order by role) as roles
        from users u cross join repositories r where r.id=$1)
        select * from candidates where eligible or cardinality(roles)>0 order by "displayName",id`,
        [repoId],
      );
      return { schemaVersion: 1, users: result.rows };
    });
    routes.get(`${base}/generations`, { preHandler: requireUser }, async (request) => {
      const { repoId } = repositoryParams.parse(request.params);
      requirePermission((await capabilities(request, repoId)).manage);
      const result = await database.query(
        `select ${generationSelection} from review_criterion_generations where repository_id=$1 and owner_user_id=$2 order by created_at desc,id desc limit 20`,
        [repoId, request.user!.id],
      );
      return {
        schemaVersion: 1,
        enabled: config?.CREDENTIAL_REGISTRY_ENABLED === true,
        items: result.rows,
      };
    });
    routes.post(`${base}/generations`, { preHandler: requireUser }, async (request, reply) => {
      const { repoId } = repositoryParams.parse(request.params);
      requirePermission((await capabilities(request, repoId)).manage);
      if (!config?.CREDENTIAL_REGISTRY_ENABLED)
        throw new CriterionError(503, 'GENERATION_DISABLED', '등록된 모델 계정이 필요합니다.');
      const input = criterionGenerationCreateSchema.parse(request.body);
      const accounts = await listAvailableChatAccounts(database, request.user!.id);
      const model = accounts
        .find((account) => account.id === input.accountId)
        ?.models.find((model) => model.id === input.modelName);
      if (!model?.allowedEfforts.includes(input.reasoningEffort))
        throw new CriterionError(
          403,
          'GENERATION_MODEL_UNAVAILABLE',
          '이 모델 계정을 사용할 수 없습니다.',
        );
      const id = await enqueueCriterionGeneration(database, repoId, request.user!.id, input);
      const result = await database.query(
        `select ${generationSelection} from review_criterion_generations where id=$1`,
        [id],
      );
      return reply.code(202).send(result.rows[0]);
    });
    routes.post(
      `${base}/generations/:generationId/cancel`,
      { preHandler: requireUser },
      async (request) => {
        const { repoId, generationId } = repositoryParams
          .extend({ generationId: z.string().uuid() })
          .parse(request.params);
        requirePermission((await capabilities(request, repoId)).manage);
        const result = await database.query(
          `update review_criterion_generations set state='cancelled',error_code=null,updated_at=clock_timestamp()
        where id=$1 and repository_id=$2 and owner_user_id=$3 and state in ('queued','running') returning ${generationSelection}`,
          [generationId, repoId, request.user!.id],
        );
        if (!result.rowCount)
          throw new CriterionError(
            409,
            'GENERATION_NOT_ACTIVE',
            '취소할 수 있는 진행 중 요청이 없습니다.',
          );
        return result.rows[0];
      },
    );
    routes.put(`${base}/roles`, { preHandler: requireUser }, async (request) => {
      const { repoId } = repositoryParams.parse(request.params);
      requirePermission((await capabilities(request, repoId)).delegate);
      const input = delegationSchema.parse(request.body);
      const connection = await database.connect();
      try {
        await connection.query('begin');
        if (input.enabled) {
          const eligible = await connection.query(
            `select u.id from users u join repositories r on r.id = $2 where u.id = $1 and u.enabled
            and (u.role = 'administrator' or (
              exists(select 1 from tenant_memberships m where m.user_id = u.id and m.tenant_id = r.tenant_id and m.enabled)
              and exists(select 1 from repository_grants g where g.repository_id = r.id and (g.subject_or_group = u.oidc_subject or g.subject_or_group in (select 'group:' || value from jsonb_array_elements_text(u.groups_json))))))`,
            [input.userId, repoId],
          );
          if (!eligible.rowCount) throw criteriaNotFound();
          await connection.query(
            `insert into review_criteria_roles(repository_id, user_id, role, granted_by) values($1,$2,$3,$4)
            on conflict(repository_id,user_id,role) do nothing`,
            [repoId, input.userId, input.role, request.user!.id],
          );
        } else
          await connection.query(
            'delete from review_criteria_roles where repository_id = $1 and user_id = $2 and role = $3',
            [repoId, input.userId, input.role],
          );
        await connection.query(
          `insert into audit_events(actor, action, resource_type, resource_id, outcome, request_id, metadata)
          values($1,'criterion.delegate','repository',$2,'success',$3,$4::jsonb)`,
          [request.user!.subject, repoId, request.id, JSON.stringify(input)],
        );
        await connection.query('commit');
      } catch (error) {
        await connection.query('rollback');
        throw error;
      } finally {
        connection.release();
      }
      return { schemaVersion: 1, ...input };
    });
  });
}
