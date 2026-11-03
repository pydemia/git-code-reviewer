import type { DatabaseClient } from '@gcr/db';
import { ModelCapacityError } from './model-admission.js';
import { assertJobLease, type JobLease } from './analysis-checkpoint.js';

/** Called in the worker's fenced transaction. Quota waiting does not spend a crash retry. */
export async function deferModelJob(
  database: DatabaseClient,
  job: JobLease & { type: string; payload: { analysisId?: string } },
  error: unknown,
) {
  if (
    job.type !== 'analysis.run' ||
    !(error instanceof ModelCapacityError) ||
    !Number.isFinite(error.resumeAfter.getTime())
  )
    return false;
  await assertJobLease(database, job);
  const result = await database.query(
    `update jobs set state='queued',available_at=greatest($2,clock_timestamp()+interval '3 seconds'),lease_owner=null,lease_expires_at=null,model_defer_count=model_defer_count+1,max_attempts=max_attempts+1,last_error='{"code":"MODEL_CAPACITY_WAIT","retryable":true}'::jsonb,updated_at=clock_timestamp() where id=$1 and model_defer_count<50 and created_at>clock_timestamp()-interval '24 hours' returning id`,
    [job.id, error.resumeAfter],
  );
  if (!result.rowCount) return false;
  await database.query(
    "update job_attempts set ended_at=clock_timestamp(),outcome='retry',error_code='MODEL_CAPACITY_WAIT' where id=$1",
    [job.attempt_id],
  );
  await database.query(
    "update analysis_runs set stage='model-capacity-wait' where id=$1 and state='analyzing'",
    [job.payload.analysisId],
  );
  return true;
}
