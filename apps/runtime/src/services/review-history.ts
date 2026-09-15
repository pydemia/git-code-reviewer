import { createHash } from 'node:crypto';
import type { Database, DatabaseClient } from '@gcr/db';
import { z } from 'zod';
import {
  reviewHistoryPullSchema,
  reviewHistoryMessageSchema,
  reviewHistoryObservationListSchema,
} from '@gcr/contracts';
import { CriterionError, criteriaNotFound } from './review-criteria.js';
type Connection = Pick<DatabaseClient, 'query'>;
const utc = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();
export async function withHistoryRead<T>(
  db: Database,
  operation: (c: DatabaseClient) => Promise<T>,
) {
  const c = await db.connect();
  try {
    await c.query('begin isolation level repeatable read read only');
    const result = await operation(c);
    await c.query('commit');
    return result;
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}
export async function historyRevision(c: Connection, repoId: string) {
  const row = (
    await c.query(
      `select
    (select coalesce(max(o.id),0)::text from github_pr_message_observations o join github_pr_messages m on m.id=o.message_id where m.repository_id=$1) as observation,
    (select count(*)::text from github_pr_messages where repository_id=$1) as messages,
    (select count(*)::text from pull_requests where repository_id=$1) as pulls,
    (select max(github_updated_at)::text from pull_requests where repository_id=$1) as updated`,
      [repoId],
    )
  ).rows[0];
  return createHash('sha256').update(JSON.stringify(row)).digest('hex');
}
const cursorSchema = z
  .object({
    repoId: z.string().uuid(),
    scope: z.string(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    last: z.string(),
  })
  .strict();
export function historyCursor(repoId: string, scope: string, revision: string, last: string) {
  return Buffer.from(JSON.stringify({ repoId, scope, revision, last })).toString('base64url');
}
export function readHistoryCursor(
  cursor: string | undefined,
  repoId: string,
  scope: string,
  revision: string,
  requestedRevision?: string,
) {
  if (requestedRevision && requestedRevision !== revision)
    throw new CriterionError(
      409,
      'HISTORY_REVISION_CHANGED',
      '이력이 변경됐습니다. 첫 페이지부터 다시 조회해 주세요.',
    );
  if (!cursor) return null;
  let value;
  try {
    if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
    value = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new CriterionError(
      400,
      'INVALID_HISTORY_CURSOR',
      '이력 페이지 위치가 올바르지 않습니다.',
    );
  }
  if (value.repoId !== repoId || value.scope !== scope)
    throw new CriterionError(400, 'INVALID_HISTORY_CURSOR', '다른 조회 범위의 페이지 위치입니다.');
  if (value.revision !== revision)
    throw new CriterionError(
      409,
      'HISTORY_REVISION_CHANGED',
      '이력이 변경됐습니다. 첫 페이지부터 다시 조회해 주세요.',
    );
  return value.last;
}
export async function historyPull(c: Connection, repoId: string, number: number) {
  const row = (
    await c.query(
      `select p.id,p.number,p.title,p.state,p.html_url,
    (select count(*)::int from github_pr_messages m where m.pull_request_id=p.id) as messages,
    (select count(*)::int from github_pr_messages m where m.pull_request_id=p.id and m.in_reply_to_github_id is not null) as replies,
    (select count(*)::int from github_pr_messages m where m.pull_request_id=p.id and m.upstream_state='not-returned') as missing,
    c.observed_at,c.sync_started_at,c.message_count,case when c.sync_started_at is null or s.last_attempt_at>=c.sync_started_at then s.last_error_code else null end as last_error_code,s.claim_until,
    (select j.state from review_history_collection_items i join jobs j on j.id=i.job_id where i.pull_request_id=p.id order by j.created_at desc limit 1) as job_state,
    (select case when i.completed_at is null and (c.sync_started_at is null or j.created_at>=c.sync_started_at) then j.last_error->>'code' else null end from review_history_collection_items i join jobs j on j.id=i.job_id where i.pull_request_id=p.id order by j.created_at desc limit 1) as job_error
    from pull_requests p left join review_history_coverage c on c.pull_request_id=p.id
    left join pull_request_conversation_sync s on s.pull_request_id=p.id where p.repository_id=$1 and p.number=$2`,
      [repoId, number],
    )
  ).rows[0];
  if (!row) throw criteriaNotFound();
  const collecting =
    ['queued', 'running'].includes(row.job_state) ||
    (row.claim_until && new Date(row.claim_until) > new Date());
  const error = row.job_error ?? row.last_error_code ?? null;
  return reviewHistoryPullSchema.parse({
    id: row.id,
    number: row.number,
    title: row.title,
    state: row.state,
    htmlUrl: row.html_url,
    messageCount: row.messages,
    replyCount: row.replies,
    notReturnedCount: row.missing,
    coverage: {
      state: collecting
        ? 'collecting'
        : error
          ? 'failed'
          : row.observed_at
            ? 'collected'
            : 'uncollected',
      lastCompleteAt: utc(row.observed_at),
      syncStartedAt: utc(row.sync_started_at),
      observedCount: row.message_count ?? null,
      errorCode: error,
    },
  });
}
export async function historyMessage(c: Connection, repoId: string, number: number, id: string) {
  const row = (
    await c.query(
      `select m.*,parent.id as parent_id,review.id as review_id,
    (select count(*)::int from github_pr_messages child where child.pull_request_id=m.pull_request_id and child.kind='review-comment' and m.kind='review-comment' and child.in_reply_to_github_id=m.github_id) as replies
    from github_pr_messages m join pull_requests p on p.id=m.pull_request_id
    left join github_pr_messages parent on parent.pull_request_id=m.pull_request_id and parent.kind='review-comment' and m.kind='review-comment' and parent.github_id=m.in_reply_to_github_id
    left join github_pr_messages review on review.pull_request_id=m.pull_request_id and review.kind='review' and review.github_id::text=m.provenance->>'reviewGithubId'
    where m.id=$1 and m.repository_id=$2 and p.number=$3`,
      [id, repoId, number],
    )
  ).rows[0];
  if (!row) throw criteriaNotFound();
  return reviewHistoryMessageSchema.parse({
    id: row.id,
    pullRequestId: row.pull_request_id,
    githubId: String(row.github_id),
    kind: row.kind,
    authorLogin: row.author_login,
    authorType: row.author_type,
    body: row.body,
    contentHash: row.content_hash,
    path: row.path,
    line: row.line,
    side: row.side,
    commitSha: row.commit_sha,
    inReplyToGithubId:
      row.in_reply_to_github_id === null ? null : String(row.in_reply_to_github_id),
    provenance: row.provenance,
    observationHash: row.observation_hash,
    htmlUrl: row.html_url,
    githubCreatedAt: utc(row.github_created_at),
    githubUpdatedAt: utc(row.github_updated_at),
    upstreamState: row.upstream_state,
    parentId: row.parent_id ?? null,
    reviewSourceId: row.review_id ?? null,
    replyCount: row.replies,
    lastObservedAt: utc(row.last_observed_at),
  });
}
export async function historyObservations(
  c: Connection,
  repoId: string,
  number: number,
  id: string,
  cursor?: string,
) {
  await historyMessage(c, repoId, number, id);
  const revision = await historyRevision(c, repoId);
  const last = readHistoryCursor(cursor, repoId, `observations:${id}`, revision);
  if (last && (!/^[1-9][0-9]{0,18}$/.test(last) || BigInt(last) > 9223372036854775807n))
    throw new CriterionError(
      400,
      'INVALID_HISTORY_CURSOR',
      '이력 페이지 위치가 올바르지 않습니다.',
    );
  const rows = (
    await c.query(
      `select id::text,observation_hash as "observationHash",snapshot,observed_at as "observedAt",sync_started_at as "syncStartedAt" from github_pr_message_observations where message_id=$1 and ($2::bigint is null or id<$2) order by id desc limit 11`,
      [id, last],
    )
  ).rows;
  return reviewHistoryObservationListSchema.parse({
    schemaVersion: 1,
    repositoryId: repoId,
    sourceId: id,
    revision,
    items: rows
      .slice(0, 10)
      .map((x) => ({ ...x, observedAt: utc(x.observedAt), syncStartedAt: utc(x.syncStartedAt) })),
    nextCursor:
      rows.length > 10 ? historyCursor(repoId, `observations:${id}`, revision, rows[9].id) : null,
  });
}
