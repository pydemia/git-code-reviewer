import { createHash } from 'node:crypto';
import type { Database, DatabaseClient } from '@gcr/db';
import {
  centralMemoryContent,
  canonicalKnowledgeJson,
  type CentralMemoryContent,
} from '@gcr/client-contract';
import { CriterionError, criteriaNotFound } from './review-criteria.js';
import {
  reviewMemoryColumns,
  reviewMemoryContentHash,
  buildReviewMemorySearchText,
  type ReviewMemoryRecord,
} from './review-memory.js';
import {
  approveKnowledgeMemory,
  knowledgeMemoryApprovalFingerprint,
} from './knowledge-projection.js';

type Connection = Pick<DatabaseClient, 'query'>;
const marker = 'review-history-guidance-v1';
const changed = () =>
  new CriterionError(
    409,
    'GUIDANCE_SOURCE_CHANGED',
    '원문이나 지침이 변경됐습니다. 현재 원문을 확인하고 새 초안을 작성해 주세요.',
  );
export async function guidanceTransaction<T>(db: Database, op: (c: DatabaseClient) => Promise<T>) {
  const c = await db.connect();
  try {
    await c.query('begin');
    const result = await op(c);
    await c.query('commit');
    return result;
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}
async function getGuidance(c: Connection, repo: string, id: string, lock = false) {
  const row = (
    await c.query<ReviewMemoryRecord>(
      `select ${reviewMemoryColumns} from review_memories where id=$1 and repository_id=$2 and scope='collective' and source_kind='github-pr-message' and source_anchor->>'format'=$3 ${lock ? 'for update' : ''}`,
      [id, repo, marker],
    )
  ).rows[0];
  if (!row) throw criteriaNotFound();
  return row;
}
async function source(c: Connection, repo: string, id: string, lock = false) {
  const row = (
    await c.query(
      `select m.*,p.number from github_pr_messages m join pull_requests p on p.id=m.pull_request_id where m.id=$1 and m.repository_id=$2 ${lock ? 'for update of m' : ''}`,
      [id, repo],
    )
  ).rows[0];
  if (!row) throw criteriaNotFound();
  return row;
}
function fresh(memory: ReviewMemoryRecord, current: Record<string, unknown>) {
  return (
    current.upstream_state === 'present' &&
    current.content_hash === memory.sourceGithubPrMessageContentHash &&
    current.observation_hash === memory.sourceAnchor.observationHash
  );
}
export async function readHistoryGuidance(c: Connection, repo: string, id: string) {
  const memory = await getGuidance(c, repo, id);
  const current = await source(c, repo, memory.sourceGithubPrMessageId!);
  const projection = (
    await c.query(
      'select source_fingerprint from review_knowledge_memory_projections where memory_id=$1',
      [id],
    )
  ).rows[0];
  const approved =
    projection &&
    projection.source_fingerprint === (await knowledgeMemoryApprovalFingerprint(c, memory));
  return {
    schemaVersion: 1 as const,
    repositoryId: repo,
    id,
    revision: memory.revision,
    state: memory.state,
    needsReview: !fresh(memory, current) || (memory.state === 'active' && !approved),
    publicationRequested: memory.state === 'active' && Boolean(approved),
    content: centralMemoryContent(memory.sourceAnchor.content),
    source: {
      id: current.id,
      pullNumber: current.number,
      htmlUrl: current.html_url,
      contentHash: memory.sourceGithubPrMessageContentHash!,
      observationHash: memory.sourceAnchor.observationHash as string | null,
      upstreamState: current.upstream_state as 'present' | 'not-returned',
    },
    createdAt: new Date(memory.createdAt).toISOString(),
    reviewedAt: memory.reviewedAt ? new Date(memory.reviewedAt).toISOString() : null,
  };
}
export async function createHistoryGuidance(
  c: Connection,
  repo: string,
  actor: string,
  input: {
    sourceId: string;
    contentHash: string;
    observationHash: string | null;
    content: CentralMemoryContent;
  },
) {
  const content = centralMemoryContent(input.content);
  if (
    !content.recommendation.trim() ||
    !content.counterEvidence.length ||
    !Object.values(content.appliesTo).some((x) => x.length)
  )
    throw new CriterionError(
      400,
      'GUIDANCE_CONDITIONS_REQUIRED',
      '검토 지침, 적용 조건, 반증 지침을 작성해 주세요.',
    );
  const current = await source(c, repo, input.sourceId, true);
  if (
    current.upstream_state !== 'present' ||
    current.content_hash !== input.contentHash ||
    current.observation_hash !== input.observationHash
  )
    throw changed();
  const record = {
    ...content,
    kind: 'decision' as const,
    filePaths: content.appliesTo.filePaths,
    symbols: content.appliesTo.symbols,
  };
  const key = createHash('sha256')
    .update(
      canonicalKnowledgeJson({
        marker,
        sourceId: input.sourceId,
        observationHash: input.observationHash,
        contentHash: input.contentHash,
        content,
      }),
    )
    .digest('hex');
  const existing = (
    await c.query(
      "select id from review_memories where repository_id=$1 and aggregation_key=$2 and scope='collective' and state in ('candidate','active')",
      [repo, key],
    )
  ).rows[0];
  if (existing) return readHistoryGuidance(c, repo, existing.id);
  const inserted = (
    await c.query(
      `insert into review_memories(tenant_id,repository_id,scope,kind,state,summary,detail,recommendation,categories,file_paths,symbols,search_text,aggregation_key,source_kind,source_github_pr_message_id,source_github_pr_message_content_hash,source_anchor,content_hash,created_by)
    select tenant_id,id,'collective','decision','candidate',$2,$3,$4,$5,$6,$7,$8,$9,'github-pr-message',$10,$11,$12::jsonb,$13,$14 from repositories where id=$1
    on conflict(repository_id,aggregation_key) where scope='collective' and state='candidate' do nothing returning id`,
      [
        repo,
        content.summary,
        content.detail,
        content.recommendation,
        content.categories,
        record.filePaths,
        record.symbols,
        buildReviewMemorySearchText(record),
        key,
        input.sourceId,
        input.contentHash,
        JSON.stringify({
          format: marker,
          observationHash: input.observationHash,
          content,
          path: current.path,
          htmlUrl: current.html_url,
        }),
        reviewMemoryContentHash(record),
        actor,
      ],
    )
  ).rows[0];
  const id =
    inserted?.id ??
    (
      await c.query(
        "select id from review_memories where repository_id=$1 and aggregation_key=$2 and scope='collective' and state in ('candidate','active')",
        [repo, key],
      )
    ).rows[0].id;
  if (inserted) {
    await c.query(
      "insert into review_memory_events(memory_id,action,actor_user_id,after_state,revision) values($1,'created',$2,'candidate',1)",
      [id, actor],
    );
    await c.query(
      "insert into audit_events(actor,action,resource_type,resource_id,outcome) values($1,'review-history.guidance.create','review-memory',$2,'success')",
      [actor, id],
    );
  }
  return readHistoryGuidance(c, repo, id);
}
export async function activateHistoryGuidance(
  c: Connection,
  repo: string,
  actor: string,
  id: string,
  revision: number,
) {
  // Match collection's source-before-memory lock order to avoid a source update racing activation.
  const initial = await getGuidance(c, repo, id);
  const current = await source(c, repo, initial.sourceGithubPrMessageId!, true);
  let memory = await getGuidance(c, repo, id, true);
  if (
    memory.revision !== revision ||
    !fresh(memory, current) ||
    !['candidate', 'active'].includes(memory.state)
  )
    throw changed();
  if (memory.state === 'active') return readHistoryGuidance(c, repo, id);
  await c.query(
    "update review_memories set state='active',reviewed_by=$2,reviewed_at=clock_timestamp(),updated_at=clock_timestamp() where id=$1",
    [id, actor],
  );
  memory = await getGuidance(c, repo, id);
  const fingerprint = await knowledgeMemoryApprovalFingerprint(c, memory);
  if (!fingerprint) throw changed();
  await approveKnowledgeMemory(
    c,
    repo,
    actor,
    id,
    fingerprint,
    centralMemoryContent(memory.sourceAnchor.content),
  );
  await c.query(
    "insert into review_memory_events(memory_id,action,actor_user_id,before_state,after_state,revision) values($1,'activated',$2,'candidate','active',$3)",
    [id, actor, memory.revision],
  );
  return readHistoryGuidance(c, repo, id);
}
export async function retireHistoryGuidance(
  c: Connection,
  repo: string,
  actor: string,
  id: string,
  revision: number,
) {
  const memory = await getGuidance(c, repo, id, true);
  if (memory.revision !== revision || !['candidate', 'active', 'retired'].includes(memory.state))
    throw changed();
  if (memory.state !== 'retired') {
    await c.query(
      "update review_memories set state='retired',reviewed_by=$2,reviewed_at=clock_timestamp(),updated_at=clock_timestamp() where id=$1",
      [id, actor],
    );
    await c.query(
      "insert into review_memory_events(memory_id,action,actor_user_id,before_state,after_state,revision) values($1,'retired',$2,$3,'retired',$4)",
      [id, actor, memory.state, memory.revision],
    );
    await c.query(
      "insert into audit_events(actor,action,resource_type,resource_id,outcome) values($1,'review-history.guidance.retire','review-memory',$2,'success')",
      [actor, id],
    );
  }
  return readHistoryGuidance(c, repo, id);
}
