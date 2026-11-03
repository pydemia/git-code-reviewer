import type { Database } from '@gcr/db';

/** Safe operational evidence alongside immutable reports, including older misclassified runs. */
export async function analysisModelLimit(database: Pick<Database, 'query'>, analysisId: string) {
  const row = (
    await database.query<{ retryAt: Date; active: boolean }>(
      `select greatest(c.cooldown_until,(l.failure->>'retryAt')::timestamptz) as "retryAt",
      greatest(c.cooldown_until,(l.failure->>'retryAt')::timestamptz)>clock_timestamp() as active
      from model_request_ledger l left join model_account_capacity c using(quota_key)
      where l.run_key=$1 and l.failure->>'providerCode'='usage_limit_reached'
      order by l.created_at desc,l.id desc limit 1`,
      [`analysis:${analysisId}`],
    )
  ).rows[0];
  return row
    ? {
        code: 'MODEL_USAGE_LIMIT_REACHED' as const,
        retryAt: row.retryAt.toISOString(),
        active: row.active,
      }
    : null;
}

export class AnalysisModelCooldownError extends Error {
  constructor(readonly retryAt: string) {
    super('ANALYSIS_MODEL_COOLDOWN');
  }
}
