import { createHash, randomUUID } from 'node:crypto';
import {
  criterionDocumentSchema,
  criterionSourceSchema,
  criterionFeedbackContentSchema,
  type CriterionFeedbackCreate,
  type CriterionFeedbackResolution,
  type CriterionCreate,
  type CriterionAction,
  type CriterionEvaluationCreate,
  type CriterionSummary,
} from '@gcr/contracts';
import type { DatabaseClient } from '@gcr/db';
import type { z } from 'zod';
import { listSnapshotChangeSources } from './criterion-code-sources.js';
import { requireCurrentCriterionSources } from './criterion-recheck.js';

type Connection = Pick<DatabaseClient, 'query'>;
type Source = z.infer<typeof criterionSourceSchema>;
export class CriterionError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const criteriaNotFound = () =>
  new CriterionError(404, 'RESOURCE_NOT_FOUND', '리소스를 찾을 수 없습니다.');
const conflict = (message: string) => new CriterionError(409, 'CRITERION_CONFLICT', message);

export function criteriaHash(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b, 'en'))
          .map(([key, value]) => [key, canonical(value)]),
      );
    }
    return item;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

export const criterionSelection = `r.id, repo.tenant_id as "tenantId", r.repository_id as "repositoryId",
  r.current_revision as revision, r.version, r.state, rev.content_hash as "contentHash", rev.document,
  decision.origin, decision.outcome, r.created_at as "createdAt", r.updated_at as "updatedAt"`;
export const criterionJoins = `from review_rules r join repositories repo on repo.id = r.repository_id
  join review_rule_revisions rev on rev.rule_id = r.id and rev.revision = r.current_revision
  join review_decisions decision on decision.id = rev.decision_id`;

function withObservedHash<
  T extends { observationHash?: string | null | undefined; discussion?: unknown; content: string },
>(source: T) {
  const { observationHash, discussion, ...rest } = source;
  return {
    ...rest,
    // Preserve existing non-code source normalization. Diff sources bypass this
    // helper because their leading/trailing whitespace is part of the evidence.
    content: source.content.trim(),
    ...(observationHash ? { observationHash } : {}),
    ...(discussion ? { discussion } : {}),
  };
}

export async function listCriterionSources(
  connection: Connection,
  repositoryId: string,
): Promise<Source[]> {
  const result = await connection.query<Source>(
    `select 'memory' as kind, id, content_hash as "contentHash",
       concat_ws(E'\n\n', summary, nullif(detail, ''), nullif(recommendation, '')) as content,
       summary as label, source_base_sha as "baseSha", source_head_sha as "headSha", null::text as "observationHash", null::jsonb as discussion
     from review_memories where repository_id = $1 and scope = 'collective' and state in ('candidate','active')
     union all
     select 'github-pr-message', message.id, message.content_hash, message.body,
       left(concat('PR #', pr.number, ' · ', message.author_login), 500), pr.base_sha, message.commit_sha, message.observation_hash, message.provenance
     from github_pr_messages message join pull_requests pr on pr.id = message.pull_request_id
     where message.repository_id = $1 and char_length(trim(message.body)) between 1 and 12000
     order by kind, id limit 200`,
    [repositoryId],
  );
  return [
    ...(await listSnapshotChangeSources(connection, repositoryId)),
    ...result.rows.map((row) => criterionSourceSchema.parse(withObservedHash(row))),
  ];
}

export async function resolveCriterionSources(
  connection: Connection,
  repositoryId: string,
  input: CriterionCreate['decision']['sources'],
  lock = true,
): Promise<Source[]> {
  const result: Source[] = [];
  const seen = new Set<string>();
  for (const source of input) {
    if (source.kind === 'manual') {
      result.push({
        kind: 'manual',
        id: null,
        content: source.content,
        contentHash: criteriaHash(source.content),
        label: '수동 검토 기록',
        baseSha: null,
        headSha: null,
      });
      continue;
    }
    const key = `${source.kind}:${source.id}`;
    if (seen.has(key)) throw conflict('같은 출처를 중복해서 연결할 수 없습니다.');
    seen.add(key);
    if (source.kind === 'snapshot-change') {
      const found = (await listSnapshotChangeSources(connection, repositoryId, source.id, lock))[0];
      if (!found) throw criteriaNotFound();
      if (found.contentHash !== source.contentHash)
        throw conflict('코드 변경 출처가 달라졌습니다. 출처를 다시 조회해 주세요.');
      result.push(found);
      continue;
    }
    const found =
      source.kind === 'memory'
        ? await connection.query<Source>(
            `select 'memory' as kind, id, content_hash as "contentHash",
           concat_ws(E'\n\n', summary, nullif(detail,''), nullif(recommendation,'')) as content,
           summary as label, source_base_sha as "baseSha", source_head_sha as "headSha"
         from review_memories where id = $1 and repository_id = $2 and scope = 'collective'
           and state in ('candidate','active') ${lock ? 'for share' : ''}`,
            [source.id, repositoryId],
          )
        : await connection.query<Source>(
            `select 'github-pr-message' as kind, m.id, m.content_hash as "contentHash", m.body as content,
           left(concat('PR #', p.number, ' · ', m.author_login),500) as label,
           p.base_sha as "baseSha", m.commit_sha as "headSha", m.observation_hash as "observationHash", m.provenance as discussion
         from github_pr_messages m join pull_requests p on p.id = m.pull_request_id
         where m.id = $1 and m.repository_id = $2 ${lock ? 'for share of m, p' : ''}`,
            [source.id, repositoryId],
          );
    if (!found.rows[0]) throw criteriaNotFound();
    if (found.rows[0].contentHash !== source.contentHash)
      throw conflict('출처가 변경됐습니다. 최신 내용을 확인하고 다시 등록해 주세요.');
    if (
      source.kind === 'github-pr-message' &&
      (found.rows[0].observationHash ?? null) !== (source.observationHash ?? null)
    )
      throw conflict('리뷰 상태나 위치가 변경됐습니다. 출처를 다시 조회해 주세요.');
    const parsed = criterionSourceSchema.safeParse(withObservedHash(found.rows[0]));
    if (!parsed.success) throw conflict('출처가 비어 있거나 허용 길이를 초과합니다.');
    result.push(parsed.data);
  }
  return result;
}

async function insertRevision(
  connection: Connection,
  repositoryId: string,
  ruleId: string,
  revision: number,
  actorId: string,
  input: CriterionCreate,
) {
  const sources = await resolveCriterionSources(connection, repositoryId, input.decision.sources);
  const sourceHash = criteriaHash(sources);
  const document = criterionDocumentSchema.parse(input.document);
  const decisionId = randomUUID();
  await connection.query(
    `insert into review_decisions(id, repository_id, outcome, reasoning, origin, source_hash, sources, created_by)
     values($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [
      decisionId,
      repositoryId,
      input.decision.outcome,
      input.decision.reasoning,
      input.origin,
      sourceHash,
      JSON.stringify(sources),
      actorId,
    ],
  );
  const contentHash = criteriaHash({
    document,
    decision: {
      outcome: input.decision.outcome,
      reasoning: input.decision.reasoning,
      origin: input.origin,
      sourceHash,
    },
  });
  await connection.query(
    `insert into review_rule_revisions(rule_id, repository_id, revision, supersedes, decision_id, document, content_hash, created_by)
     values($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [
      ruleId,
      repositoryId,
      revision,
      revision === 1 ? null : revision - 1,
      decisionId,
      JSON.stringify(document),
      contentHash,
      actorId,
    ],
  );
  await recordCriterionEvent(
    connection,
    ruleId,
    revision,
    actorId,
    revision === 1 ? 'created' : 'revised',
    '',
  );
}

export async function createCriterion(
  connection: Connection,
  repositoryId: string,
  actorId: string,
  input: CriterionCreate,
): Promise<string> {
  const ruleId = randomUUID();
  await connection.query('insert into review_rules(id, repository_id) values($1,$2)', [
    ruleId,
    repositoryId,
  ]);
  await insertRevision(connection, repositoryId, ruleId, 1, actorId, input);
  return ruleId;
}

export async function lockCriterion(
  connection: Connection,
  repositoryId: string,
  ruleId: string,
  expectedVersion: number,
): Promise<CriterionSummary> {
  // Lock the stable identity first. A joined FOR UPDATE can recheck the new
  // head against an older statement snapshot and incorrectly return no row.
  const locked = await connection.query<{ version: number }>(
    'select version from review_rules where repository_id = $1 and id = $2 for update',
    [repositoryId, ruleId],
  );
  if (!locked.rows[0]) throw criteriaNotFound();
  if (locked.rows[0].version !== expectedVersion)
    throw conflict('다른 변경이 먼저 저장됐습니다. 최신 버전을 다시 불러와 주세요.');
  const found = await connection.query<CriterionSummary>(
    `select ${criterionSelection} ${criterionJoins} where r.repository_id = $1 and r.id = $2`,
    [repositoryId, ruleId],
  );
  if (!found.rows[0]) throw criteriaNotFound();
  if (found.rows[0].version !== expectedVersion)
    throw conflict('다른 변경이 먼저 저장됐습니다. 최신 버전을 다시 불러와 주세요.');
  return found.rows[0];
}

export async function reviseCriterion(
  connection: Connection,
  rule: CriterionSummary,
  actorId: string,
  input: CriterionCreate,
) {
  await insertRevision(connection, rule.repositoryId, rule.id, rule.revision + 1, actorId, input);
  await connection.query(
    `update review_rules set current_revision = current_revision + 1, version = version + 1,
       state = 'draft', updated_at = clock_timestamp() where id = $1`,
    [rule.id],
  );
}

export async function evaluateCriterion(
  connection: Connection,
  rule: CriterionSummary,
  actorId: string,
  input: CriterionEvaluationCreate,
) {
  if (rule.state !== 'draft')
    throw conflict(
      '평가 기록은 후보 상태에서 추가할 수 있습니다. 내용을 재검토하려면 새 버전을 등록해 주세요.',
    );
  await requireCurrentCriterionSources(connection, rule);
  const cases = input.cases.map((item) => ({ ...item, sourceHash: criteriaHash(item.source) }));
  const passed = cases.every(
    (item) => item.observed === (item.kind === 'defect' ? 'finding' : 'clear'),
  );
  await connection.query(
    `insert into review_rule_evaluations(rule_id, revision, cases, passed, note, actor_user_id)
     values($1,$2,$3::jsonb,$4,$5,$6)`,
    [rule.id, rule.revision, JSON.stringify(cases), passed, input.note, actorId],
  );
  await recordCriterionEvent(
    connection,
    rule.id,
    rule.revision,
    actorId,
    'evaluation-recorded',
    input.note,
  );
  await bumpVersion(connection, rule.id);
}

export async function actOnCriterion(
  connection: Connection,
  rule: CriterionSummary,
  actorId: string,
  input: CriterionAction,
) {
  const { action, note } = input;
  if (action !== 'retire') await requireCurrentCriterionSources(connection, rule);
  if (action === 'approve-owner') {
    if (rule.state !== 'evaluated')
      throw conflict('평가를 통과한 버전에 책임자 승인을 기록할 수 있습니다.');
    const author = await connection.query<{ createdBy: string }>(
      'select created_by as "createdBy" from review_rule_revisions where rule_id = $1 and revision = $2',
      [rule.id, rule.revision],
    );
    if (author.rows[0]?.createdBy === actorId)
      throw conflict('기준 작성자와 다른 지정 책임자의 검토가 필요합니다.');
    const duplicate = await connection.query(
      'select id from review_rule_events where rule_id = $1 and revision = $2 and action = $3 and actor_user_id = $4',
      [rule.id, rule.revision, action, actorId],
    );
    if (duplicate.rowCount) throw conflict('이 버전에 이미 책임자 승인을 기록했습니다.');
    await recordCriterionEvent(connection, rule.id, rule.revision, actorId, action, note);
    await bumpVersion(connection, rule.id);
    return;
  }
  const target = { evaluate: 'evaluated', shadow: 'shadow', activate: 'active', retire: 'retired' }[
    action
  ];
  const expected = { evaluate: 'draft', shadow: 'evaluated', activate: 'shadow', retire: null }[
    action
  ];
  if (rule.state === 'retired' || (expected && rule.state !== expected))
    throw conflict('현재 상태에서는 요청한 전이를 수행할 수 없습니다.');
  if (action !== 'retire') {
    if (rule.outcome === 'open-question')
      throw conflict('미해결 질문은 승인된 기준으로 전환할 수 없습니다.');
    const evaluation = await connection.query<{ passed: boolean }>(
      `select passed from review_rule_evaluations where rule_id = $1 and revision = $2 order by created_at desc, id desc limit 1`,
      [rule.id, rule.revision],
    );
    if (!evaluation.rows[0]?.passed)
      throw conflict('현재 버전의 결함·수정·정상·반증 평가가 모두 통과해야 합니다.');
  }
  if (
    ['shadow', 'activate'].includes(action) &&
    (['P0', 'P1'].includes(rule.document.severity) || rule.outcome === 'accepted-exception')
  ) {
    // Approval is revision-bound and must still belong to an enabled, delegated
    // owner with repository membership/grant at the moment of promotion.
    const approved = await connection.query(
      `select e.id from review_rule_events e
       join review_criteria_roles role on role.repository_id = $3 and role.user_id = e.actor_user_id
         and role.role in ('security-owner','domain-owner')
       join users u on u.id = e.actor_user_id and u.enabled
       where e.rule_id = $1 and e.revision = $2 and e.action = 'approve-owner'
         and (u.role = 'administrator' or (
           exists(select 1 from tenant_memberships m where m.user_id = u.id and m.tenant_id = $4 and m.enabled)
           and exists(select 1 from repository_grants g where g.repository_id = $3 and (g.subject_or_group = u.oidc_subject or g.subject_or_group in (select 'group:' || value from jsonb_array_elements_text(u.groups_json))))))
       limit 1`,
      [rule.id, rule.revision, rule.repositoryId, rule.tenantId],
    );
    if (!approved.rowCount)
      throw conflict('고위험 기준과 예외는 지정 security/domain owner의 승인이 필요합니다.');
  }
  await recordCriterionEvent(connection, rule.id, rule.revision, actorId, action, note);
  await connection.query(
    'update review_rules set state = $2, version = version + 1, updated_at = clock_timestamp() where id = $1',
    [rule.id, target],
  );
}

async function bumpVersion(connection: Connection, ruleId: string) {
  await connection.query(
    'update review_rules set version = version + 1, updated_at = clock_timestamp() where id = $1',
    [ruleId],
  );
}
async function recordCriterionEvent(
  connection: Connection,
  ruleId: string,
  revision: number,
  actorId: string,
  action: string,
  note: string,
) {
  await connection.query(
    'insert into review_rule_events(rule_id, revision, action, actor_user_id, note) values($1,$2,$3,$4,$5)',
    [ruleId, revision, action, actorId, note],
  );
}

export async function submitCriterionFeedback(
  connection: Connection,
  rule: CriterionSummary,
  actorId: string,
  input: CriterionFeedbackCreate,
) {
  if (input.request.kind === 'exception' && !['shadow', 'active'].includes(rule.state))
    throw conflict('예외는 관찰 중이거나 활성 상태인 기준에 요청할 수 있습니다.');
  const inserted = await connection.query<{ id: string }>(
    'insert into review_rule_feedback(rule_id, revision, request, created_by) values($1,$2,$3::jsonb,$4) returning id',
    [rule.id, rule.revision, JSON.stringify(input.request), actorId],
  );
  await recordCriterionEvent(
    connection,
    rule.id,
    rule.revision,
    actorId,
    `${input.request.kind}-requested`,
    input.request.message.slice(0, 2000),
  );
  await bumpVersion(connection, rule.id);
  return inserted.rows[0]!.id;
}

export async function resolveCriterionFeedback(
  connection: Connection,
  rule: CriterionSummary,
  requestId: string,
  actorId: string,
  input: CriterionFeedbackResolution,
) {
  const found = await connection.query<{
    revision: number;
    request: unknown;
    createdBy: string;
    resolved: boolean;
  }>(
    `select f.revision, f.request, f.created_by as "createdBy", (r.request_id is not null) as resolved
     from review_rule_feedback f left join review_rule_feedback_resolutions r on r.request_id = f.id
     where f.id = $1 and f.rule_id = $2`,
    [requestId, rule.id],
  );
  const item = found.rows[0];
  if (!item) throw criteriaNotFound();
  if (item.resolved) throw conflict('이미 처리된 요청입니다.');
  const request = criterionFeedbackContentSchema.parse(item.request);
  if (input.action === 'acknowledge' && request.kind !== 'correction')
    throw conflict('예외 요청은 책임자 승인 또는 거절로 처리해 주세요.');
  if (input.action === 'approve-exception') {
    if (request.kind !== 'exception') throw conflict('정정 요청을 예외로 승인할 수 없습니다.');
    if (item.createdBy === actorId)
      throw conflict('예외 요청자와 다른 지정 책임자의 승인이 필요합니다.');
    if (item.revision !== rule.revision || !['shadow', 'active'].includes(rule.state))
      throw conflict('현재 관찰·활성 버전에 요청한 예외만 승인할 수 있습니다.');
    const unexpired = await connection.query('select 1 where $1::timestamptz > clock_timestamp()', [
      request.terms.expiresAt,
    ]);
    if (!unexpired.rowCount) throw conflict('이미 만료된 예외를 승인할 수 없습니다.');
    await connection.query(
      `insert into review_rule_exceptions(rule_id, revision, applies_to, reason, starts_at, expires_at, approved_by, request_id)
       values($1,$2,$3::jsonb,$4,$5,$6,$7,$8)`,
      [
        rule.id,
        rule.revision,
        JSON.stringify(request.terms.appliesTo),
        request.message,
        request.terms.startsAt,
        request.terms.expiresAt,
        actorId,
        requestId,
      ],
    );
  }
  await connection.query(
    'insert into review_rule_feedback_resolutions(request_id, action, note, actor_user_id) values($1,$2,$3,$4)',
    [requestId, input.action, input.note, actorId],
  );
  await recordCriterionEvent(
    connection,
    rule.id,
    item.revision,
    actorId,
    `feedback-${input.action}`,
    input.note,
  );
  await bumpVersion(connection, rule.id);
}

export async function revokeCriterionException(
  connection: Connection,
  rule: CriterionSummary,
  exceptionId: string,
  actorId: string,
  note: string,
) {
  const found = await connection.query<{ revision: number; revoked: boolean }>(
    `select e.revision, (r.exception_id is not null) as revoked from review_rule_exceptions e
     left join review_rule_exception_revocations r on r.exception_id = e.id
     where e.id = $1 and e.rule_id = $2`,
    [exceptionId, rule.id],
  );
  if (!found.rows[0]) throw criteriaNotFound();
  if (found.rows[0].revoked) throw conflict('이미 철회한 예외입니다.');
  await connection.query(
    'insert into review_rule_exception_revocations(exception_id, note, actor_user_id) values($1,$2,$3)',
    [exceptionId, note, actorId],
  );
  await recordCriterionEvent(
    connection,
    rule.id,
    found.rows[0].revision,
    actorId,
    'exception-revoked',
    note,
  );
  await bumpVersion(connection, rule.id);
}
