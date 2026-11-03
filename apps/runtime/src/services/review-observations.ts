import {
  reportObservationSchema,
  reviewObservationsSchema,
  type ReviewObservations,
} from '@gcr/contracts';
import type { Database } from '@gcr/db';
export async function readReviewObservations(
  database: Database,
  repositoryId: string,
  days: 7 | 30 | 90,
) {
  const c = await database.connect();
  try {
    await c.query('begin isolation level repeatable read read only');
    await c.query("set local statement_timeout='3s'");
    const times = (
      await c.query<{ now: Date; from: Date; since: Date | null }>(
        "select transaction_timestamp() as now, transaction_timestamp()-($1 * interval '1 day') as \"from\", (select applied_at from schema_migrations where version='0051_review_observations.sql') as since",
        [days],
      )
    ).rows[0]!;
    const limit = 2000;
    const all = (
      await c.query<{
        id: string;
        pull_id: string;
        head_sha: string;
        current_head: string;
        state: string;
        report_id: string | null;
        observation: unknown;
      }>(
        `select ar.id,sr.pull_request_id as pull_id,sr.head_sha,pr.head_sha as current_head,ar.state,r.id as report_id,r.observation
      from analysis_runs ar join snapshots s on s.id=ar.snapshot_id join snapshot_requests sr on sr.id=s.request_id join pull_requests pr on pr.id=sr.pull_request_id left join reports r on r.analysis_run_id=ar.id
      where pr.repository_id=$1 and ar.memory_owner_user_id is null and ar.created_at >= $2 and ar.created_at <= $3 order by ar.created_at desc,ar.id desc limit $4`,
        [repositoryId, times.from, times.now, limit + 1],
      )
    ).rows;
    const runs = all.slice(0, limit),
      latest = new Map<string, (typeof runs)[number]>();
    for (const run of runs) if (!latest.has(run.pull_id)) latest.set(run.pull_id, run);
    const result: ReviewObservations = {
      schemaVersion: 1,
      repositoryId,
      observedAt: times.now.toISOString(),
      window: {
        days,
        from: times.from.toISOString(),
        runLimit: limit,
        includedRuns: runs.length,
        truncated: all.length > limit,
      },
      pulls: {
        included: latest.size,
        states: {},
        latestAtObservedHead: 0,
        latestAtOtherHead: 0,
        reports: 0,
        recordedReports: 0,
        fixtureReports: 0,
        reviewStatuses: {},
        unrecordedReports: 0,
        findings: { P0: 0, P1: 0, P2: 0, P3: 0 },
        criteria: { violation: 0, satisfied: 0, uncertain: 0, notReported: 0, unavailable: 0 },
        recurrence: {
          comparedReports: 0,
          unavailableReports: 0,
          repeated: 0,
          unconfirmedPrevious: 0,
        },
      },
      effort: {
        recordedDurations: 0,
        fixtureDurations: 0,
        unrecordedDurations: 0,
        totalReportedDurationMs: 0,
        ledgerAttempts: 0,
        ledgerStates: {},
        runsWithLedger: 0,
        runsWithoutLedger: 0,
        inputBytes: 0,
        billedCost: null,
        tokenUsage: null,
      },
      decisions: [],
      publication: [],
      downloads: { since: times.since?.toISOString() ?? null, bestEffort: true, responses: [] },
      local: { execution: 'unknown', applied: 'unknown' },
      quality: { falsePositiveRate: null, incidentReduction: null },
    };
    for (const run of latest.values()) {
      const out = result.pulls;
      out.states[run.state] = (out.states[run.state] ?? 0) + 1;
      if (run.head_sha === run.current_head) out.latestAtObservedHead++;
      else out.latestAtOtherHead++;
      if (!run.report_id) continue;
      out.reports++;
      const parsed = reportObservationSchema.safeParse(run.observation);
      if (!parsed.success) {
        out.unrecordedReports++;
        continue;
      }
      out.recordedReports++;
      const o = parsed.data;
      out.reviewStatuses[o.reviewStatus] = (out.reviewStatuses[o.reviewStatus] ?? 0) + 1;
      if (o.reviewStatus === 'fixture') {
        out.fixtureReports++;
        continue;
      }
      for (const key of ['P0', 'P1', 'P2', 'P3'] as const) out.findings[key] += o.findings[key];
      for (const key of [
        'violation',
        'satisfied',
        'uncertain',
        'notReported',
        'unavailable',
      ] as const)
        out.criteria[key] += o.criteria[key];
      if (o.recurrence.status === 'compared') out.recurrence.comparedReports++;
      else out.recurrence.unavailableReports++;
      out.recurrence.repeated += o.recurrence.repeated;
      out.recurrence.unconfirmedPrevious += o.recurrence.unconfirmedPrevious;
    }
    for (const run of runs) {
      const o = reportObservationSchema.safeParse(run.observation);
      if (o.success && o.data.reviewStatus === 'fixture') result.effort.fixtureDurations++;
      else if (o.success) {
        result.effort.recordedDurations++;
        result.effort.totalReportedDurationMs += o.data.durationMs;
      } else result.effort.unrecordedDurations++;
    }
    const ledger = (
      await c.query<{ run_key: string; state: string; n: string; bytes: string }>(
        `select run_key,state,count(*)::text as n,sum(input_bytes)::text as bytes from model_request_ledger where run_key=any($1::text[]) group by run_key,state`,
        [runs.map((r) => 'analysis:' + r.id)],
      )
    ).rows;
    const withLedger = new Set<string>();
    for (const row of ledger) {
      withLedger.add(row.run_key);
      result.effort.ledgerAttempts += Number(row.n);
      result.effort.ledgerStates[row.state] =
        (result.effort.ledgerStates[row.state] ?? 0) + Number(row.n);
      result.effort.inputBytes += Number(row.bytes);
    }
    result.effort.runsWithLedger = withLedger.size;
    result.effort.runsWithoutLedger = runs.length - withLedger.size;
    result.decisions = (
      await c.query(
        `select r.state,d.outcome,count(*)::int as count from review_rules r join review_rule_revisions v on v.rule_id=r.id and v.revision=r.current_revision join review_decisions d on d.id=v.decision_id where r.repository_id=$1 group by r.state,d.outcome order by r.state,d.outcome`,
        [repositoryId],
      )
    ).rows;
    result.publication = (
      await c.query(
        `select s.component,case when s.last_error is not null then 'failed' when s.requested_revision<>s.published_revision then 'pending' when s.current_release_id is null then 'unpublished' when a.state<>'available' or a.id is null then 'unavailable' else 'published' end as state,s.release_sequence as "releaseSequence",(select count(*)::int from review_knowledge_releases v where v.scope_id=s.id and v.created_at >= $2 and v.created_at <= $3) as "publishedInWindow" from review_knowledge_scopes s left join review_knowledge_releases r on r.id=s.current_release_id left join artifacts a on a.id=r.artifact_id where s.repository_id=$1 and s.component in ('policy','collective') order by s.component`,
        [repositoryId, times.from, times.now],
      )
    ).rows;
    result.downloads.responses = (
      await c.query(
        `select route,status,sum(responses)::float8 as count,sum(duration_ms)::float8 as "totalDurationMs" from knowledge_response_observations where repository_id=$1 and day >= ($2::timestamptz at time zone 'UTC')::date and day <= ($3::timestamptz at time zone 'UTC')::date group by route,status order by route,status`,
        [repositoryId, times.from, times.now],
      )
    ).rows;
    await c.query('commit');
    return reviewObservationsSchema.parse(result);
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}
