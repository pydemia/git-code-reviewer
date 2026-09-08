import { createHash } from 'node:crypto';
import type { Database, DatabaseClient } from '@gcr/db';
import type { ReviewModel } from '@gcr/analysis-engine';
import { gradeSchema, legacyAnalysisReportSchema } from '@gcr/review-contract';

export type JobLease = { id: string; attempt_id: string; attempt_count: number };

export async function assertJobLease(database: Database | DatabaseClient, job: JobLease) {
  const valid = await database.query(
    `select j.id from jobs j join job_attempts a on a.job_id=j.id
     where j.id=$1 and a.id=$2 and j.attempt_count=$3 and a.attempt_number=$3
       and j.state='running' and j.lease_owner=a.executor and a.ended_at is null
       and j.lease_expires_at>clock_timestamp() for update of j`,
    [job.id, job.attempt_id, job.attempt_count],
  );
  if (!valid.rowCount) throw Error('job_lease_lost');
}

export function checkpointReviewModel(
  model: ReviewModel,
  database: Database,
  analysisId: string,
  job: JobLease,
  limitations?: Set<string>,
  draining: () => boolean = () => false,
): ReviewModel {
  return {
    profile: model.profile,
    async review(...input) {
      if (draining()) throw Error('worker_draining');
      await assertJobLease(database, job);
      const hash = createHash('sha256')
        .update(JSON.stringify({ version: 1, profile: model.profile, input }))
        .digest('hex');
      const cached = await database.query<{
        result: Awaited<ReturnType<ReviewModel['review']>> & { sourceLimitations?: string[] };
      }>('select result from analysis_model_checkpoints where analysis_id=$1 and input_hash=$2', [
        analysisId,
        hash,
      ]);
      if (cached.rows[0]) {
        for (const limitation of cached.rows[0].result.sourceLimitations ?? [])
          limitations?.add(limitation);
        return cached.rows[0].result;
      }
      const result = await model.review(...input);
      const report = legacyAnalysisReportSchema.parse(result.report);
      if (
        report.review.is_error ||
        result.truncated ||
        !report.review.summary.trim() ||
        !gradeSchema.safeParse(report.review.grade).success
      )
        return result;
      const client = await database.connect();
      try {
        await client.query('begin');
        await assertJobLease(client, job);
        await client.query(
          'insert into analysis_model_checkpoints(analysis_id,input_hash,stage,result) values($1,$2,$3,$4::jsonb) on conflict do nothing',
          [
            analysisId,
            hash,
            input[3]?.stage ?? 'legacy',
            JSON.stringify({ ...result, sourceLimitations: [...(limitations ?? [])] }),
          ],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
      return result;
    },
  };
}
