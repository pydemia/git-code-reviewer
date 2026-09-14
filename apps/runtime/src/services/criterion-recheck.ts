import {
  criterionSourceSchema,
  type CriterionReviewStatus,
  type CriterionSummary,
} from '@gcr/contracts';
import type { Database, DatabaseClient } from '@gcr/db';
import { z } from 'zod';
import { CriterionError, criteriaHash, resolveCriterionSources } from './review-criteria.js';

type Connection = Pick<DatabaseClient, 'query'>;
type Source = z.infer<typeof criterionSourceSchema>;
export function criterionSourceInspector(
  connection: Connection,
  repositoryId: string,
  lock = false,
) {
  // Cache only within this caller's DB snapshot, never across users or requests.
  const cache = new Map<
    string,
    Promise<{ status: 'current' | 'changed' | 'unavailable'; source?: Source }>
  >();
  return (source: Source) => {
    const input =
      source.kind === 'manual'
        ? { kind: 'manual' as const, content: source.content }
        : {
            kind: source.kind,
            id: source.id!,
            contentHash: source.contentHash,
            ...(source.observationHash ? { observationHash: source.observationHash } : {}),
          };
    const key = criteriaHash(input);
    let result = cache.get(key);
    if (!result) {
      result = (async () => {
        try {
          const current = (
            await resolveCriterionSources(connection, repositoryId, [input], lock)
          )[0]!;
          return { status: 'current' as const, source: current };
        } catch (error) {
          if (!(error instanceof CriterionError) || ![404, 409].includes(error.statusCode))
            throw error;
          return {
            status: error.statusCode === 404 ? ('unavailable' as const) : ('changed' as const),
          };
        }
      })();
      cache.set(key, result);
    }
    return result.then((result) =>
      result.status === 'current' && criteriaHash(result.source) !== criteriaHash(source)
        ? { status: 'changed' as const }
        : result,
    );
  };
}

export async function criterionReviewStatus(
  connection: Connection,
  rule: CriterionSummary,
  sources: Source[],
  sourceHash: string,
  now: Date,
  inspect = criterionSourceInspector(connection, rule.repositoryId),
): Promise<CriterionReviewStatus> {
  const states: CriterionReviewStatus['sources'] = [];
  for (const source of sources)
    states.push({ kind: source.kind, id: source.id, status: (await inspect(source)).status });
  const exceptions = await connection.query<{ count: number }>(
    `select count(*)::int as count from review_rule_exceptions e where e.rule_id=$1 and e.revision=$2
     and e.expires_at<=$3 and not exists(select 1 from review_rule_exception_revocations v where v.exception_id=e.id)`,
    [rule.id, rule.revision, now],
  );
  const sourceSetChanged = criteriaHash(sources) !== sourceHash;
  const promotionBlocked = sourceSetChanged || states.some((source) => source.status !== 'current');
  const reviewDateReached =
    rule.document.reviewAfter !== null && Date.parse(rule.document.reviewAfter) <= now.getTime();
  const expiredExceptions = exceptions.rows[0]!.count;
  return {
    checkedAt: now.toISOString(),
    requiresReview:
      rule.state !== 'retired' && (promotionBlocked || reviewDateReached || expiredExceptions > 0),
    promotionBlocked,
    reviewDateReached,
    expiredExceptions,
    sourceSetChanged,
    sources: states,
  };
}

export async function requireCurrentCriterionSources(
  connection: Connection,
  rule: CriterionSummary,
) {
  const decision = (
    await connection.query<{ sources: unknown; source_hash: string }>(
      `select d.sources,d.source_hash from review_rule_revisions v join review_decisions d on d.id=v.decision_id
     where v.rule_id=$1 and v.revision=$2`,
      [rule.id, rule.revision],
    )
  ).rows[0];
  if (!decision)
    throw new CriterionError(409, 'CRITERION_RECHECK_REQUIRED', '기준 출처를 다시 확인해 주세요.');
  const status = await criterionReviewStatus(
    connection,
    rule,
    z.array(criterionSourceSchema).parse(decision.sources),
    decision.source_hash,
    new Date(),
    criterionSourceInspector(connection, rule.repositoryId, true),
  );
  if (status.promotionBlocked)
    throw new CriterionError(
      409,
      'CRITERION_RECHECK_REQUIRED',
      '출처가 변경되거나 사용할 수 없습니다. 최신 출처를 확인해 새 버전으로 재검토해 주세요.',
    );
}

export async function reconcileCriterionDeadlines(database: Database, limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('Invalid deadline batch');
  const c = await database.connect();
  try {
    await c.query('begin');
    const rows = await c.query<{
      id: string;
      rule_id: string;
      revision: number;
      kind: string;
      reference_id: string;
    }>(
      `select id,rule_id,revision,kind,reference_id from review_criterion_deadlines where processed_at is null and due_at<=clock_timestamp()
       order by due_at,id limit $1 for update skip locked`,
      [limit],
    );
    for (const row of rows.rows) {
      const current = (
        await c.query<{ repository_id: string }>(
          `select repository_id from review_rules where id=$1 and current_revision=$2 and state<>'retired'
           and ($3='review-date' or not exists(select 1 from review_rule_exception_revocations where exception_id=$4)) for share`,
          [row.rule_id, row.revision, row.kind, row.reference_id],
        )
      ).rows[0];
      if (current)
        await c.query("select request_review_knowledge($1,'policy',null,$2)", [
          current.repository_id,
          `criterion.${row.kind}`,
        ]);
      await c.query(
        'update review_criterion_deadlines set processed_at=clock_timestamp() where id=$1',
        [row.id],
      );
    }
    await c.query('commit');
    return rows.rowCount;
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}
