import type { Database, DatabaseClient } from '@gcr/db';
import type { GitHubReader } from '@gcr/github';
import { GitHubConversationLimitError } from '@gcr/github';
import type { AppConfig } from '../config.js';
import { assertJobLease, type JobLease } from './analysis-checkpoint.js';
import { registeredGitHubReader } from './account-registry.js';
import { getRepository, persistPullRequestMessages } from './repositories.js';
import { knowledgeUserAllowed } from './knowledge-projection.js';
import { CriterionError, criteriaNotFound } from './review-criteria.js';

type CollectionInput = { requestKey: string; pullNumbers: number[] };
export class HistoryCollectionError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
  }
}
export async function createHistoryCollection(
  c: DatabaseClient,
  repoId: string,
  userId: string,
  input: CollectionInput,
) {
  const numbers = [...new Set(input.pullNumbers)].sort((a, b) => a - b);
  if (
    !numbers.length ||
    numbers.length > 20 ||
    numbers.some((n) => !Number.isSafeInteger(n) || n < 1)
  )
    throw new CriterionError(
      400,
      'INVALID_HISTORY_COLLECTION',
      'PR 번호를 1개부터 20개까지 지정해 주세요.',
    );
  const pulls = (
    await c.query<{ id: string; number: number }>(
      'select id,number from pull_requests where repository_id=$1 and number=any($2::int[]) order by number',
      [repoId, numbers],
    )
  ).rows;
  if (pulls.length !== numbers.length)
    throw new CriterionError(
      400,
      'HISTORY_PULL_NOT_COLLECTED',
      '이미 등록된 PR 번호를 지정해 주세요.',
    );
  const result = (
    await c.query<{ id: string; pull_numbers: number[] }>(
      `insert into review_history_collections(repository_id,requested_by,request_key,pull_numbers) values($1,$2,$3,$4)
    on conflict(repository_id,requested_by,request_key) do update set request_key=excluded.request_key returning id,pull_numbers`,
      [repoId, userId, input.requestKey, numbers],
    )
  ).rows[0]!;
  if (JSON.stringify(result.pull_numbers) !== JSON.stringify(numbers))
    throw new CriterionError(
      409,
      'HISTORY_REQUEST_REUSED',
      '같은 요청 키에 다른 PR 목록을 사용할 수 없습니다.',
    );
  for (const pull of pulls) {
    if (
      (
        await c.query(
          'select 1 from review_history_collection_items where collection_id=$1 and pull_request_id=$2',
          [result.id, pull.id],
        )
      ).rowCount
    )
      continue;
    const job = (
      await c.query<{ id: string }>(
        `insert into jobs(type,payload,priority,dedupe_key) values('history.collect',$1::jsonb,150,$2)
      returning id`,
        [
          JSON.stringify({ pullRequestId: pull.id, historyCollectionId: result.id }),
          `history.collect:${result.id}:${pull.id}`,
        ],
      )
    ).rows[0]!;
    await c.query(
      'insert into review_history_collection_items(collection_id,pull_request_id,job_id) values($1,$2,$3) on conflict do nothing',
      [result.id, pull.id, job.id],
    );
  }
  return result.id;
}
export async function readHistoryCollection(
  c: Pick<Database, 'query'>,
  repoId: string,
  id: string,
) {
  const collection = (
    await c.query(
      'select id,pull_numbers,created_at from review_history_collections where id=$1 and repository_id=$2',
      [id, repoId],
    )
  ).rows[0];
  if (!collection) throw criteriaNotFound();
  const items = (
    await c.query(
      `select p.number,p.id as "pullRequestId",i.completed_at as "completedAt",i.message_count as "messageCount",
    case when i.completed_at is not null then 'completed' else coalesce(j.state,'expired') end as state,
    coalesce(j.attempt_count,0) as attempts,j.last_error->>'code' as "errorCode"
    from review_history_collection_items i join pull_requests p on p.id=i.pull_request_id left join jobs j on j.id=i.job_id
    where i.collection_id=$1 order by p.number`,
      [id],
    )
  ).rows;
  const finished = items.filter((x) => x.state === 'completed').length;
  return {
    schemaVersion: 1,
    id,
    repositoryId: repoId,
    pullNumbers: collection.pull_numbers,
    createdAt: new Date(collection.created_at).toISOString(),
    state:
      finished === items.length
        ? 'completed'
        : items.some((x) => x.state === 'queued' || x.state === 'running')
          ? 'running'
          : 'partial',
    completed: finished,
    total: items.length,
    nextCursor: items.find((x) => x.state !== 'completed')?.number ?? null,
    limits: { pulls: 20, restPagesPerEndpoint: 20, itemsPerRestPage: 100 },
    items: items.map((x) => ({
      ...x,
      completedAt: x.completedAt ? new Date(x.completedAt).toISOString() : null,
    })),
  };
}
export async function executeHistoryCollectionJob(
  database: Database,
  github: GitHubReader | null,
  config: AppConfig,
  job: JobLease & { payload: { pullRequestId: string; historyCollectionId?: string } },
) {
  await assertJobLease(database, job);
  const row = (
    await database.query(
      `select c.repository_id,c.requested_by,p.number,i.completed_at from review_history_collection_items i
    join review_history_collections c on c.id=i.collection_id join pull_requests p on p.id=i.pull_request_id
    where i.job_id=$1 and i.collection_id=$2 and i.pull_request_id=$3 and p.repository_id=c.repository_id`,
      [job.id, job.payload.historyCollectionId, job.payload.pullRequestId],
    )
  ).rows[0];
  if (!row) throw new HistoryCollectionError('HISTORY_COLLECTION_UNAVAILABLE');
  if (row.completed_at) return;
  if (!(await knowledgeUserAllowed(database, row.repository_id, row.requested_by, 'maintainer')))
    throw new HistoryCollectionError('HISTORY_COLLECTION_ACCESS_REVOKED');
  const repository = await getRepository(database, row.repository_id);
  if (!repository) throw new HistoryCollectionError('HISTORY_REPOSITORY_UNAVAILABLE');
  const reader = repository.credentialId
    ? await registeredGitHubReader(
        database,
        config.CREDENTIAL_ENCRYPTION_KEY,
        repository.credentialId,
      )
    : github;
  if (!reader?.listPullRequestMessages)
    throw new HistoryCollectionError('HISTORY_READER_UNAVAILABLE');
  const started = new Date();
  let messages;
  try {
    messages = await reader.listPullRequestMessages(repository, row.number);
  } catch (error) {
    if (error instanceof GitHubConversationLimitError)
      throw new HistoryCollectionError('HISTORY_PAGE_LIMIT');
    throw error;
  }
  if (!(await knowledgeUserAllowed(database, row.repository_id, row.requested_by, 'maintainer')))
    throw new HistoryCollectionError('HISTORY_COLLECTION_ACCESS_REVOKED');
  const saved = await persistPullRequestMessages(
    database,
    row.repository_id,
    row.number,
    messages,
    started,
    undefined,
    { complete: true, lease: job },
  );
  if (!saved) throw new HistoryCollectionError('HISTORY_REPOSITORY_UNAVAILABLE');
  const c = await database.connect();
  try {
    await c.query('begin');
    await assertJobLease(c, job);
    await c.query(
      'update review_history_collection_items set completed_at=clock_timestamp(),message_count=$2 where job_id=$1',
      [job.id, messages.length],
    );
    await c.query('commit');
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}
