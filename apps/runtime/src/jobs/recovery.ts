import type { Database } from '@gcr/db';
import { appendEvent } from '../events/index.js';

export async function recoverExpiredJobs(database: Database) {
  const client = await database.connect();
  try {
    await client.query('begin');
    const expired = await client.query<{
      id: string;
      type: string;
      attempt_count: number;
      max_attempts: number;
      recovery_count: number;
      payload: {
        analysisId?: string;
        operationId?: string;
        snapshotRequestId?: string;
        pullRequestId?: string;
        memoryOwnerUserId?: string;
      };
    }>(
      `select * from jobs where state='running' and lease_expires_at<clock_timestamp()
       and type in ('analysis.run','snapshot.materialize','github.review.publish')
       order by lease_expires_at for update skip locked limit 20`,
    );
    for (const job of expired.rows) {
      const published =
        job.payload.analysisId && job.type === 'analysis.run'
          ? await client.query('select 1 from reports where analysis_run_id=$1', [
              job.payload.analysisId,
            ])
          : null;
      const state = published?.rowCount
        ? 'completed'
        : job.recovery_count < 3
          ? 'queued'
          : 'failed';
      await client.query(
        `update job_attempts set ended_at=clock_timestamp(),outcome=$2,error_code=$3
         where job_id=$1 and ended_at is null`,
        [
          job.id,
          state === 'completed' ? 'completed' : 'interrupted',
          state === 'completed' ? null : 'WORKER_LEASE_EXPIRED',
        ],
      );
      await client.query(
        `update jobs set state=$2,lease_owner=null,lease_expires_at=null,
         available_at=clock_timestamp(),updated_at=clock_timestamp(),
         recovery_count=recovery_count+case when $2='queued' then 1 else 0 end,
         max_attempts=greatest(max_attempts,attempt_count+case when $2='queued' then 1 else 0 end),
         last_error=case when $2='completed' then null else jsonb_build_object('code','WORKER_LEASE_EXPIRED','retryable',$2='queued') end where id=$1`,
        [job.id, state],
      );
      if (state === 'failed') {
        await client.query(
          `update operations set state='failed',finished_at=clock_timestamp(),error='{"code":"WORKER_RECOVERY_EXHAUSTED","retryable":false}'::jsonb where id=$1 and state not in ('completed','failed')`,
          [job.payload.operationId],
        );
        if (job.type === 'analysis.run')
          await client.query(
            `update analysis_runs set state='failed',stage='failed',finished_at=clock_timestamp(),limitations='["WORKER_RECOVERY_EXHAUSTED"]'::jsonb where id=$1 and not exists(select 1 from reports where analysis_run_id=$1)`,
            [job.payload.analysisId],
          );
        if (job.type === 'snapshot.materialize')
          await client.query("update snapshot_requests set state='failed' where id=$1", [
            job.payload.snapshotRequestId,
          ]);
        if (job.type === 'github.review.publish')
          await client.query(
            "update github_review_publications set state='failed',last_error_code='WORKER_RECOVERY_EXHAUSTED' where target_analysis_run_id=$1 and state not in ('published','disabled')",
            [job.payload.analysisId],
          );
      }
      await appendEvent(client, 'job', job.id, 'job.lease_recovered', {
        state,
        recoveryCount: job.recovery_count + (state === 'queued' ? 1 : 0),
      });
      if (job.payload.analysisId) {
        const payload = {
          analysisId: job.payload.analysisId,
          state,
          recoveryCount: job.recovery_count + (state === 'queued' ? 1 : 0),
        };
        await appendEvent(client, 'analysis', job.payload.analysisId, 'analysis.state', payload);
        if (job.payload.pullRequestId && !job.payload.memoryOwnerUserId)
          await appendEvent(
            client,
            'pull_request',
            job.payload.pullRequestId,
            'analysis.state',
            payload,
          );
      }
    }
    await client.query('commit');
    return expired.rowCount;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
