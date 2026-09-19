import {
  describeImpactPlan,
  type ImpactTask,
  type ReviewTaskStore,
  type TaskResult,
} from '@gcr/analysis-engine';
import type { Database, DatabaseClient } from '@gcr/db';
import { legacyAnalysisReportSchema } from '@gcr/review-contract';
import { assertJobLease, type JobLease } from './analysis-checkpoint.js';

export function databaseReviewTaskStore(
  database: Database,
  analysisId: string,
  job: JobLease,
): ReviewTaskStore {
  const transaction = async <T>(operation: (client: DatabaseClient) => Promise<T>): Promise<T> => {
    const client = await database.connect();
    try {
      await client.query('begin');
      await assertJobLease(client, job);
      const result = await operation(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  };
  const update = (task: ImpactTask, sql: string, values: unknown[]) =>
    transaction(async (client) => {
      const changed = await client.query(sql, [
        analysisId,
        task.id,
        task.inputHash,
        job.attempt_id,
        ...values,
      ]);
      if (!changed.rowCount) throw Error('review_task_input_changed');
    });
  return {
    initialize: (plan) =>
      transaction(async (client) => {
        await client.query(
          'insert into analysis_review_plans(analysis_id,plan_hash,manifest) values($1,$2,$3::jsonb) on conflict do nothing',
          [analysisId, plan.hash, JSON.stringify(describeImpactPlan(plan))],
        );
        const pinned = await client.query<{ plan_hash: string }>(
          'select plan_hash from analysis_review_plans where analysis_id=$1 for update',
          [analysisId],
        );
        if (pinned.rows[0]?.plan_hash !== plan.hash) throw Error('review_plan_input_changed');
        // One statement registers every task. There is no per-file database round trip.
        await client.query(
          `insert into analysis_review_tasks(analysis_id,task_id,input_hash,kind,state)
        select $1, item.id,item.hash,item.kind,case when item.blocked then 'blocked' else 'pending' end
        from jsonb_to_recordset($2::jsonb) as item(id text,hash text,kind text,blocked boolean)
        on conflict do nothing`,
          [
            analysisId,
            JSON.stringify(
              plan.tasks.map((task) => ({
                id: task.id,
                hash: task.inputHash,
                kind: task.kind,
                blocked: task.blocked,
              })),
            ),
          ],
        );
        // A manual continuation may reuse only results from the exact same plan and
        // pinned context. Changed or expired context naturally gets a different hash.
        await client.query(
          `update analysis_review_tasks target set state='completed',result=source.result,error_code=null
          from analysis_runs a join analysis_review_plans old on old.analysis_id=a.resume_from_analysis_id
          join analysis_review_tasks source on source.analysis_id=old.analysis_id
          where a.id=$1 and old.plan_hash=$2 and target.analysis_id=a.id and target.task_id=source.task_id
            and target.input_hash=source.input_hash and target.state='pending' and source.state='completed'`,
          [analysisId, plan.hash],
        );
        const rows = await client.query<{ task_id: string; result: TaskResult }>(
          "select task_id,result from analysis_review_tasks where analysis_id=$1 and state='completed'",
          [analysisId],
        );
        return new Map(
          rows.rows.map((row) => [
            row.task_id,
            {
              report: legacyAnalysisReportSchema.parse(row.result.report),
              truncated: row.result.truncated,
            },
          ]),
        );
      }),
    start: (task) =>
      update(
        task,
        `update analysis_review_tasks set state='running',attempt_count=attempt_count+1,job_attempt_id=$4,result=null,error_code=null,retry_at=null,updated_at=clock_timestamp() where analysis_id=$1 and task_id=$2 and input_hash=$3 and state<>'completed'`,
        [],
      ),
    complete: (task, result) =>
      update(
        task,
        `update analysis_review_tasks set state='completed',result=$5::jsonb,error_code=null,retry_at=null,updated_at=clock_timestamp() where analysis_id=$1 and task_id=$2 and input_hash=$3 and job_attempt_id=$4 and state='running'`,
        [JSON.stringify(result)],
      ),
    fail: (task, failure) =>
      update(
        task,
        `update analysis_review_tasks set state=$5,error_code=$6,retry_at=$7,result=null,updated_at=clock_timestamp() where analysis_id=$1 and task_id=$2 and input_hash=$3 and (job_attempt_id=$4 or state='blocked') and state<>'completed'`,
        [failure.state, failure.code, failure.retryAt ?? null],
      ),
  };
}
