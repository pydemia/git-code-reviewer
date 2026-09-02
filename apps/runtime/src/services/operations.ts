import type { Database, DatabaseClient } from '@gcr/db';
import { appendEvent } from '../events/index.js';

export type RefreshResult = {
  id: string;
  state: string;
  deduplicated: boolean;
  pullRequestId: string;
};

export async function requestPullRefresh(
  database: Database,
  repositoryId: string,
  pullNumber: number,
  requestedBy: string,
): Promise<RefreshResult | null> {
  const connection = await database.connect();
  try {
    await connection.query('begin');
    const pullLock = `${repositoryId}:${pullNumber}`;
    await connection.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [pullLock]);
    const pull = await connection.query<{
      id: string;
      base_sha: string;
      head_sha: string;
    }>(
      `select id, base_sha, head_sha from pull_requests
       where repository_id = $1 and number = $2 and state = 'open' for update`,
      [repositoryId, pullNumber],
    );
    const row = pull.rows[0];
    if (!row) {
      await connection.query('rollback');
      return null;
    }
    const result = await enqueueSnapshot(
      connection,
      row.id,
      row.base_sha,
      row.head_sha,
      requestedBy,
      'manual',
    );
    await connection.query('commit');
    return result;
  } catch (error) {
    await connection.query('rollback');
    throw error;
  } finally {
    connection.release();
  }
}

export async function enqueueSnapshot(
  connection: DatabaseClient,
  pullRequestId: string,
  baseSha: string,
  headSha: string,
  requestedBy: string | null,
  source: 'manual' | 'poll',
): Promise<RefreshResult> {
  const dedupeKey = `pr_refresh:${pullRequestId}:${baseSha}:${headSha}`;
  const existing = await connection.query<{ id: string; state: string }>(
    `select id, state from operations where dedupe_key = $1
     and state in ('queued', 'polling', 'materializing', 'analyzing')`,
    [dedupeKey],
  );
  if (existing.rows[0]) {
    return {
      id: existing.rows[0].id,
      state: existing.rows[0].state,
      deduplicated: true,
      pullRequestId,
    };
  }

  const snapshotRequest = await connection.query<{ id: string }>(
    `insert into snapshot_requests(pull_request_id, base_sha, head_sha)
     values ($1, $2, $3)
     on conflict (pull_request_id, base_sha, head_sha) do update set pull_request_id = excluded.pull_request_id
     returning id`,
    [pullRequestId, baseSha, headSha],
  );
  const operation = await connection.query<{ id: string; state: string }>(
    `insert into operations(type, scope_type, scope_id, state, dedupe_key, requested_by)
     values ('pr_refresh', 'pull_request', $1, 'queued', $2, $3)
     returning id, state`,
    [pullRequestId, dedupeKey, requestedBy],
  );
  const operationId = operation.rows[0]!.id;
  const requestId = snapshotRequest.rows[0]!.id;
  await connection.query(
    `insert into jobs(type, payload, priority, dedupe_key)
     values ('snapshot.materialize', $1::jsonb, $2, $3)
     on conflict do nothing`,
    [
      JSON.stringify({ operationId, snapshotRequestId: requestId, pullRequestId }),
      source === 'manual' ? 10 : 100,
      `snapshot.materialize:${requestId}`,
    ],
  );
  await appendEvent(connection, 'pull_request', pullRequestId, 'snapshot.requested', {
    operationId,
    requestId,
    baseSha,
    headSha,
    source,
  });
  return {
    id: operationId,
    state: operation.rows[0]!.state,
    deduplicated: false,
    pullRequestId,
  };
}
