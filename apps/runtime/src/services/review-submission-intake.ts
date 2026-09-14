import type { Database, DatabaseClient } from '@gcr/db';
import type { FastifyRequest } from 'fastify';
import {
  submissionIntakeActionSchema,
  type SubmissionIntakeDecision,
  type SubmissionIntakeAction,
} from '@gcr/contracts';
import { reviewSubmission, type ReviewSubmission } from '@gcr/client-contract';
import {
  CriterionError,
  createCriterion,
  criteriaHash,
  lockCriterion,
  submitCriterionFeedback,
} from './review-criteria.js';
import type { AuthorizationService } from './authorization.js';
import { canReadRepository } from '../routes/worklist.js';
const deny = () =>
  new CriterionError(
    403,
    'SUBMISSION_REVIEW_PERMISSION_REQUIRED',
    '이 저장소의 리뷰 기준 관리 권한이 필요합니다.',
  );
const missing = () =>
  new CriterionError(404, 'SUBMISSION_NOT_FOUND', '제출 내용을 찾을 수 없습니다.');
const conflict = () =>
  new CriterionError(
    409,
    'SUBMISSION_REVIEW_CONFLICT',
    '제출 내용이나 검토 상태가 바뀌었습니다. 최신 내용을 확인해 주세요.',
  );
export async function submissionIntakeAccess(
  database: Pick<Database, 'query'>,
  request: FastifyRequest,
  authorization: AuthorizationService,
  repositoryId: string,
) {
  if (!request.user || request.clientPrincipal || request.headers.authorization) throw deny();
  const access = (
    await database.query<{
      role: 'administrator' | 'reviewer';
      groups: string[];
      tenantIds: string[];
      manage: boolean;
    }>(
      `select u.role,u.groups_json as groups,
      array(select m.tenant_id from tenant_memberships m join tenants t on t.id=m.tenant_id where m.user_id=u.id and m.enabled and t.enabled) as "tenantIds",
      (u.role='administrator' or exists(select 1 from review_criteria_roles where repository_id=$1 and user_id=u.id and role='maintainer')) as manage
     from users u where u.id=$2 and u.enabled and u.deleted_at is null`,
      [repositoryId, request.user.id],
    )
  ).rows[0];
  if (
    !access ||
    !(await canReadRepository(
      database,
      authorization,
      {
        id: request.id,
        user: {
          ...request.user,
          role: access.role,
          groups: access.groups,
          tenantIds: access.tenantIds,
        },
      },
      repositoryId,
    ))
  )
    throw missing();
  return { manage: access.manage };
}
export const intakeDecisionSelect = `case when d.submission_id is null then null else jsonb_build_object(
  'action',d.action,'note',d.note,'actorUserId',d.actor_user_id,'createdAt',d.created_at,
  'ruleId',d.rule_id,'feedbackId',d.feedback_id,
  'rule',case when r.id is null then null else jsonb_build_object('id',r.id,'state',r.state,'revision',r.current_revision,'version',r.version) end,
  'feedbackResolution',case when fr.request_id is null then null else jsonb_build_object('action',fr.action,'note',fr.note,'actorUserId',fr.actor_user_id,'createdAt',fr.created_at) end
) end as decision`;
export const intakeDecisionJoins = `left join client_review_submission_decisions d on d.submission_id=s.id
  left join review_rules r on r.id=d.rule_id left join review_rule_feedback_resolutions fr on fr.request_id=d.feedback_id`;
export async function readIntakeDecision(
  database: Pick<Database, 'query'>,
  repositoryId: string,
  id: string,
) {
  const row = (
    await database.query<{ decision: SubmissionIntakeDecision | null }>(
      `select ${intakeDecisionSelect} from client_review_submissions s ${intakeDecisionJoins} where s.repository_id=$1 and s.id=$2 and s.expires_at>clock_timestamp()`,
      [repositoryId, id],
    )
  ).rows[0];
  if (!row) throw missing();
  return row.decision;
}
function adoptedSource(id: string, hash: string, submission: ReviewSubmission) {
  if (submission.kind !== 'feedback') throw conflict();
  // The durable criterion source contains the explicitly shared message and its
  // provenance, not private report/chat/source bodies or a claim of CI verification.
  return `Client-reported review feedback (not independently verified)\nSubmission: ${id}\nPayload SHA-256: ${hash}\nClient: ${submission.clientId}\nSubmitter: ${submission.audience.userId}\nRun: ${submission.review.runId}\nSource SHA-256: ${submission.review.sourceHash}\nContext SHA-256: ${submission.review.contextHash}\nKind: ${submission.feedback.kind}\n\n${submission.feedback.message}`;
}
export async function reviewSubmissionIntake(
  database: Database,
  request: FastifyRequest,
  authorization: AuthorizationService,
  repositoryId: string,
  id: string,
  raw: unknown,
) {
  const input = submissionIntakeActionSchema.parse(raw);
  if (!(await submissionIntakeAccess(database, request, authorization, repositoryId)).manage)
    throw deny();
  const c = await database.connect();
  try {
    await c.query('begin isolation level serializable');
    await c.query("set local lock_timeout='5s'");
    // Recheck current user/role and repository access inside the mutation snapshot.
    const user = (
      await c.query<{ role: string }>(
        'select role from users where id=$1 and enabled and deleted_at is null for share',
        [request.user!.id],
      )
    ).rows[0];
    if (
      !user ||
      user.role !== request.user!.role ||
      !(await submissionIntakeAccess(c, request, authorization, repositoryId)).manage
    )
      throw deny();
    const row = (
      await c.query<{ payload: ReviewSubmission; payload_hash: string; expires_at: Date }>(
        'select payload,payload_hash,expires_at from client_review_submissions where repository_id=$1 and id=$2 for update',
        [repositoryId, id],
      )
    ).rows[0];
    if (!row || row.expires_at.getTime() <= Date.now()) throw missing();
    if (row.payload_hash !== input.expectedPayloadHash) throw conflict();
    const hash = criteriaHash(input);
    const existing = (
      await c.query<{ input_hash: string }>(
        'select input_hash from client_review_submission_decisions where submission_id=$1',
        [id],
      )
    ).rows[0];
    if (existing && existing.input_hash !== hash) throw conflict();
    if (!existing) {
      const submission = reviewSubmission(row.payload);
      const links = await adopt(
        c,
        repositoryId,
        request.user!.id,
        id,
        row.payload_hash,
        submission,
        input,
      );
      await c.query(
        `insert into client_review_submission_decisions(submission_id,action,payload_hash,input_hash,note,actor_user_id,rule_id,feedback_id) values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          input.action,
          row.payload_hash,
          hash,
          input.note,
          request.user!.id,
          links.ruleId,
          links.feedbackId,
        ],
      );
      await c.query(
        `insert into audit_events(actor,action,resource_type,resource_id,outcome,request_id) values($1,'client-submission.review','client-review-submission',$2,'success',$3)`,
        [request.user!.id, id, request.id],
      );
    }
    const decision = await readIntakeDecision(c, repositoryId, id);
    await c.query('commit');
    return { schemaVersion: 1, decision };
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}
async function adopt(
  c: DatabaseClient,
  repositoryId: string,
  actorId: string,
  id: string,
  hash: string,
  submission: ReviewSubmission,
  input: SubmissionIntakeAction,
) {
  if (input.action === 'dismiss') return { ruleId: null, feedbackId: null };
  if (submission.kind !== 'feedback')
    throw new CriterionError(
      400,
      'FEEDBACK_REQUIRED',
      '피드백 제출만 후보나 기준 수정·예외 요청으로 연결할 수 있습니다.',
    );
  if (input.action === 'create-candidate') {
    const ruleId = await createCriterion(c, repositoryId, actorId, {
      document: input.document,
      decision: {
        outcome: input.outcome,
        reasoning: input.reasoning,
        sources: [{ kind: 'manual', content: adoptedSource(id, hash, submission) }],
      },
      origin: 'maintainer-curated',
    });
    return { ruleId, feedbackId: null };
  }
  if (
    submission.feedback.kind === 'judgment' ||
    (submission.feedback.kind === 'exception') !== Boolean(input.exceptionTerms)
  )
    throw new CriterionError(
      400,
      'INVALID_FEEDBACK_ADOPTION',
      '수정 또는 예외 요청을 선택하고 예외에는 적용 범위와 기간을 지정해 주세요.',
    );
  // A submitted rule reference cannot silently be reassigned to a different rule.
  if (submission.feedback.rule && submission.feedback.rule.id !== input.ruleId) throw conflict();
  const rule = await lockCriterion(c, repositoryId, input.ruleId, input.expectedVersion);
  if (submission.feedback.rule && submission.feedback.rule.revision !== rule.revision)
    throw conflict();
  const request =
    submission.feedback.kind === 'exception'
      ? {
          kind: 'exception' as const,
          message: submission.feedback.message,
          terms: input.exceptionTerms!,
        }
      : { kind: 'correction' as const, message: submission.feedback.message };
  // The curator owns the enriched request; existing approval rules prohibit self-approval.
  const feedbackId = await submitCriterionFeedback(c, rule, actorId, {
    expectedVersion: input.expectedVersion,
    request,
  });
  await c.query(
    'insert into review_rule_feedback_client_sources(feedback_id,content) values($1,$2)',
    [feedbackId, adoptedSource(id, hash, submission)],
  );
  return { ruleId: rule.id, feedbackId };
}
