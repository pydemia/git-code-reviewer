import { createHash } from 'node:crypto';
import type { DatabaseClient } from '@gcr/db';
import {
  centralMemoryContent,
  encodeKnowledgeBundle,
  canonicalKnowledgeJson,
  type CentralMemoryContent,
} from '@gcr/client-contract';
import { criterionDocumentSchema, criterionSourceSchema } from '@gcr/contracts';
import { z } from 'zod';
import { getEffectiveReviewSkills } from './analysis-skills.js';
import { CriterionError, criteriaHash, resolveCriterionSources } from './review-criteria.js';
import { reviewMemoryColumns, type ReviewMemoryRecord } from './review-memory.js';

type Connection = Pick<DatabaseClient, 'query'>;
export type KnowledgeScope = {
  id: string;
  repository_id: string;
  component: 'policy' | 'collective' | 'personal';
  owner_user_id: string | null;
  requested_revision: string;
  claim_token: string;
};
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalKnowledgeJson(value)).digest('hex');
const utc = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();
export function memoryPublicationFingerprint(memory: ReviewMemoryRecord) {
  return digest({
    id: memory.id,
    repositoryId: memory.repositoryId,
    tenantId: memory.tenantId,
    scope: memory.scope,
    ownerUserId: memory.ownerUserId,
    revision: memory.revision,
    kind: memory.kind,
    state: memory.state,
    summary: memory.summary,
    detail: memory.detail,
    recommendation: memory.recommendation,
    categories: memory.categories,
    filePaths: memory.filePaths,
    symbols: memory.symbols,
    contentHash: memory.contentHash,
    aggregationKey: memory.aggregationKey,
    sourceKind: memory.sourceKind,
    sourceFindingId: memory.sourceFindingId,
    sourceChatMessageId: memory.sourceChatMessageId,
    sourceGithubPrMessageId: memory.sourceGithubPrMessageId,
    sourceGithubPrMessageContentHash: memory.sourceGithubPrMessageContentHash,
    sourceBaseSha: memory.sourceBaseSha,
    sourceHeadSha: memory.sourceHeadSha,
    supersedesId: memory.supersedesId,
  });
}
export async function knowledgeUserAllowed(
  connection: Connection,
  repoId: string,
  userId: string,
  role: 'reader' | 'maintainer' | 'owner',
) {
  const result = await connection.query(
    `select u.id from users u join repositories r on r.id=$1
    join tenants t on t.id=r.tenant_id join github_instances i on i.id=r.instance_id
    where u.id=$2 and u.enabled and u.deleted_at is null and r.enabled and r.deleted_at is null and t.enabled and i.enabled
    and (u.role='administrator' or (exists(select 1 from tenant_memberships m where m.user_id=u.id and m.tenant_id=r.tenant_id and m.enabled)
      and exists(select 1 from repository_grants g where g.repository_id=r.id and (g.subject_or_group=u.oidc_subject or g.subject_or_group in (select 'group:'||value from jsonb_array_elements_text(u.groups_json))))))
    and ($3='reader' or ($3='maintainer' and u.role='administrator') or exists(select 1 from review_criteria_roles k where k.repository_id=r.id and k.user_id=u.id and (($3='maintainer' and k.role='maintainer') or ($3='owner' and k.role in ('security-owner','domain-owner')))))`,
    [repoId, userId, role],
  );
  return Boolean(result.rowCount);
}
async function memorySourceFingerprint(
  connection: Connection,
  memory: ReviewMemoryRecord,
): Promise<string | null> {
  if (memory.sourceKind === 'manual') return 'manual';
  let rows;
  if (memory.sourceKind === 'github-pr-message') {
    if (!memory.sourceGithubPrMessageId) return null;
    rows = await connection.query(
      `select body,content_hash,path,line,side,commit_sha,observation_hash from github_pr_messages m where id=$1 and repository_id=$2 and content_hash=$3
      and not exists(select 1 from github_pr_message_user_states s where s.message_id=m.id and s.user_id=$4 and s.state='ignored')`,
      [
        memory.sourceGithubPrMessageId,
        memory.repositoryId,
        memory.sourceGithubPrMessageContentHash,
        memory.ownerUserId,
      ],
    );
  } else if (memory.sourceKind === 'finding') {
    if (!memory.sourceFindingId) return null;
    rows = await connection.query(
      'select f.title,f.problem,f.impact,f.recommendation,f.anchor,f.evidence,f.fingerprint from findings f join reports report on report.id=f.report_id join analysis_runs a on a.id=report.analysis_run_id join pull_requests p on p.id=a.pull_request_id where f.id=$1 and p.repository_id=$2',
      [memory.sourceFindingId, memory.repositoryId],
    );
  } else {
    if (!memory.sourceChatMessageId || memory.scope !== 'personal') return null;
    rows = await connection.query(
      "select m.role,m.content,m.citations from chat_messages m join chat_sessions s on s.id=m.session_id join analysis_runs a on a.id=s.analysis_run_id join pull_requests p on p.id=a.pull_request_id where m.id=$1 and s.user_id=$2 and p.repository_id=$3 and m.status='completed'",
      [memory.sourceChatMessageId, memory.ownerUserId, memory.repositoryId],
    );
  }
  const source = rows.rows[0];
  if (!source) return null;
  // Legacy approvals retain their old fingerprint until new REST evidence is observed.
  if (source.observation_hash === null) delete source.observation_hash;
  return digest(source);
}
export async function knowledgeMemoryApprovalFingerprint(
  connection: Connection,
  memory: ReviewMemoryRecord,
): Promise<string | null> {
  const source = await memorySourceFingerprint(connection, memory);
  return source === null ? null : digest({ memory: memoryPublicationFingerprint(memory), source });
}
/** Caller owns the transaction. Approval locks the source before writing its projection/outbox. */
export async function approveKnowledgeMemory(
  connection: Connection,
  repoId: string,
  userId: string,
  memoryId: string,
  expectedFingerprint: string,
  input: CentralMemoryContent,
) {
  const content = centralMemoryContent(input);
  const memory = (
    await connection.query<ReviewMemoryRecord>(
      `select ${reviewMemoryColumns} from review_memories where id=$1 and repository_id=$2 for update`,
      [memoryId, repoId],
    )
  ).rows[0];
  if (
    !memory ||
    !(await knowledgeUserAllowed(
      connection,
      repoId,
      userId,
      memory.scope === 'personal' ? 'reader' : 'maintainer',
    )) ||
    (memory.scope === 'personal' && memory.ownerUserId !== userId)
  )
    throw new CriterionError(404, 'RESOURCE_NOT_FOUND', '배포할 메모리를 찾을 수 없습니다.');
  const currentFingerprint = await knowledgeMemoryApprovalFingerprint(connection, memory);
  if (
    !currentFingerprint ||
    memory.state !== 'active' ||
    !memory.reviewedBy ||
    currentFingerprint !== expectedFingerprint
  )
    throw new CriterionError(
      409,
      'PUBLICATION_SOURCE_CHANGED',
      '활성 메모리와 출처를 다시 확인해 주세요.',
    );
  await connection.query(
    `insert into review_knowledge_memory_projections(memory_id,revision,source_fingerprint,content,approved_by) values($1,1,$2,$3::jsonb,$4)
    on conflict(memory_id) do update set revision=review_knowledge_memory_projections.revision+1,source_fingerprint=excluded.source_fingerprint,content=excluded.content,approved_by=excluded.approved_by,approved_at=clock_timestamp()`,
    [memoryId, expectedFingerprint, JSON.stringify(content), userId],
  );
  await connection.query(
    "insert into audit_events(actor,action,resource_type,resource_id,outcome) values($1,'knowledge.memory.approve','review-memory',$2,'success')",
    [userId, memoryId],
  );
}

export async function projectKnowledge(connection: Connection, scope: KnowledgeScope) {
  const repo = (
    await connection.query<{ tenant_id: string }>(
      `select r.tenant_id from repositories r join tenants t on t.id=r.tenant_id join github_instances i on i.id=r.instance_id where r.id=$1 and r.enabled and r.deleted_at is null and t.enabled and i.enabled`,
      [scope.repository_id],
    )
  ).rows[0];
  if (
    !repo ||
    (scope.owner_user_id &&
      !(await knowledgeUserAllowed(connection, scope.repository_id, scope.owner_user_id, 'reader')))
  )
    throw new CriterionError(
      403,
      'PUBLICATION_SCOPE_UNAVAILABLE',
      '배포 범위 접근 권한이 없습니다.',
    );
  const base = {
    schemaVersion: 2,
    tenantId: repo.tenant_id,
    repositoryId: scope.repository_id,
    component: scope.component,
    ownerUserId: scope.owner_user_id,
  };
  const excluded: Array<{ id: string; reason: string }> = [];
  if (scope.component !== 'policy') {
    const rows = await connection.query<ReviewMemoryRecord>(
      `select ${reviewMemoryColumns} from review_memories where repository_id=$1 and tenant_id=$2 and scope=$3 and owner_user_id is not distinct from $4::uuid and state='active' order by id`,
      [scope.repository_id, repo.tenant_id, scope.component, scope.owner_user_id],
    );
    const memories = [];
    for (const memory of rows.rows) {
      const approval = (
        await connection.query<{
          revision: number;
          source_fingerprint: string;
          content: unknown;
          approved_by: string;
        }>(
          'select revision,source_fingerprint,content,approved_by from review_knowledge_memory_projections where memory_id=$1',
          [memory.id],
        )
      ).rows[0];
      if (
        !approval ||
        !memory.reviewedBy ||
        approval.source_fingerprint !==
          (await knowledgeMemoryApprovalFingerprint(connection, memory)) ||
        !(await knowledgeUserAllowed(
          connection,
          scope.repository_id,
          approval.approved_by,
          scope.component === 'personal' ? 'reader' : 'maintainer',
        )) ||
        (scope.component === 'personal' && approval.approved_by !== scope.owner_user_id)
      ) {
        excluded.push({ id: memory.id, reason: 'projection-approval-required' });
        continue;
      }
      const content = centralMemoryContent(approval.content);
      // Expiry stays in the immutable component; consumers apply the time bound.
      const value = {
        id: memory.id,
        aggregationKey: memory.aggregationKey,
        revision: approval.revision,
        sourceRevision: memory.revision,
        sourceContentHash: memory.contentHash,
        kind: memory.kind,
        content,
        sources: [{ kind: 'memory', id: memory.id, contentHash: memory.contentHash }],
        sourceBaseSha: memory.sourceBaseSha,
        sourceHeadSha: memory.sourceHeadSha,
        supersedesId: memory.supersedesId,
      };
      memories.push({ ...value, contentHash: digest(value) });
    }
    return { bytes: encodeKnowledgeBundle({ ...base, memories }), excluded };
  }
  const effective = await getEffectiveReviewSkills(connection);
  const rules = await connection.query<{
    id: string;
    current_revision: number;
    document: unknown;
    content_hash: string;
    decision_id: string;
    sources: unknown;
    source_hash: string;
    outcome: string;
    created_by: string;
  }>(
    `select r.id,r.current_revision,rev.document,rev.content_hash,rev.decision_id,d.sources,d.source_hash,d.outcome,rev.created_by
    from review_rules r join review_rule_revisions rev on rev.rule_id=r.id and rev.revision=r.current_revision join review_decisions d on d.id=rev.decision_id
    where r.repository_id=$1 and r.state='active' order by r.id`,
    [scope.repository_id],
  );
  const criteria = [];
  for (const rule of rules.rows) {
    const document = criterionDocumentSchema.parse(rule.document);
    const sources = z.array(criterionSourceSchema).parse(rule.sources);
    const evaluation = (
      await connection.query<{ passed: boolean }>(
        `select passed from review_rule_evaluations where rule_id=$1 and revision=$2 order by created_at desc,id desc limit 1`,
        [rule.id, rule.current_revision],
      )
    ).rows[0];
    let permitted =
      rule.outcome !== 'open-question' &&
      evaluation?.passed === true &&
      criteriaHash(sources) === rule.source_hash;
    try {
      const current = await resolveCriterionSources(
        connection,
        scope.repository_id,
        sources.map((source) =>
          source.kind === 'manual'
            ? { kind: 'manual' as const, content: source.content }
            : {
                kind: source.kind,
                id: source.id!,
                contentHash: source.contentHash,
                ...(source.observationHash ? { observationHash: source.observationHash } : {}),
              },
        ),
        false,
      );
      if (criteriaHash(current) !== rule.source_hash) permitted = false;
    } catch (error) {
      if (!(error instanceof CriterionError) || ![404, 409].includes(error.statusCode)) throw error;
      permitted = false;
    }
    if (
      permitted &&
      (['P0', 'P1'].includes(document.severity) || rule.outcome === 'accepted-exception')
    ) {
      const owners = await connection.query<{ actor_user_id: string }>(
        "select actor_user_id from review_rule_events where rule_id=$1 and revision=$2 and action='approve-owner' and actor_user_id<>$3",
        [rule.id, rule.current_revision, rule.created_by],
      );
      let approved = false;
      for (const owner of owners.rows)
        if (
          await knowledgeUserAllowed(connection, scope.repository_id, owner.actor_user_id, 'owner')
        )
          approved = true;
      permitted = approved;
    }
    if (!permitted) {
      excluded.push({ id: rule.id, reason: 'criterion-review-required' });
      continue;
    }
    const exceptions = [];
    const rows = await connection.query<{
      id: string;
      applies_to: unknown;
      reason: string;
      starts_at: Date;
      expires_at: Date;
      approved_by: string;
    }>(
      `select e.* from review_rule_exceptions e where e.rule_id=$1 and e.revision=$2 and exists(select 1 from review_rule_feedback f where f.id=e.request_id and f.created_by<>e.approved_by) and not exists(select 1 from review_rule_exception_revocations v where v.exception_id=e.id) order by e.id`,
      [rule.id, rule.current_revision],
    );
    for (const exception of rows.rows) {
      if (
        !(await knowledgeUserAllowed(
          connection,
          scope.repository_id,
          exception.approved_by,
          'owner',
        ))
      )
        continue;
      exceptions.push({
        id: exception.id,
        appliesTo: exception.applies_to,
        reason: exception.reason,
        startsAt: utc(exception.starts_at),
        expiresAt: utc(exception.expires_at),
      });
    }
    const projected = {
      id: rule.id,
      revision: rule.current_revision,
      sourceContentHash: rule.content_hash,
      document: { ...document, reviewAfter: utc(document.reviewAfter) },
      decision: {
        id: rule.decision_id,
        outcome: rule.outcome,
        sources: sources.map(({ kind, id, contentHash }) => ({ kind, id, contentHash })),
      },
      exceptions,
    };
    criteria.push({ ...projected, contentHash: digest(projected) });
  }
  return {
    bytes: encodeKnowledgeBundle({ ...base, skills: effective.bundle, criteria }),
    excluded,
  };
}
