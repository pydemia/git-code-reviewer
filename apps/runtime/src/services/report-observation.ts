import { reportObservationSchema, type ReportObservation } from '@gcr/contracts';
import type { ReviewReport } from '@gcr/review-contract';
export function observeReport(report: ReviewReport): ReportObservation {
  const result: ReportObservation = {
    schemaVersion: 1,
    reviewStatus: ['model', 'fixture', 'failed', 'unavailable'].includes(
      report.versions.review ?? '',
    )
      ? (report.versions.review as ReportObservation['reviewStatus'])
      : 'unknown',
    durationMs: report.durationMs,
    findings: { P0: 0, P1: 0, P2: 0, P3: 0 },
    criteria: { violation: 0, satisfied: 0, uncertain: 0, notReported: 0, unavailable: 0 },
    recurrence: {
      status: report.recurrence?.status ?? 'unrecorded',
      repeated:
        report.recurrence?.items.filter((item) =>
          ['same-head', 'observed-again'].includes(item.status),
        ).length ?? 0,
      unconfirmedPrevious: report.recurrence?.unconfirmedPrevious.length ?? 0,
    },
  };
  for (const finding of report.findings) {
    result.findings[finding.priority]++;
    if (!finding.criteria || finding.criteria.status === 'not-reported')
      result.criteria.notReported++;
    else if (finding.criteria.status === 'unavailable') result.criteria.unavailable++;
    else for (const criterion of finding.criteria.items) result.criteria[criterion.outcome]++;
  }
  return reportObservationSchema.parse(result);
}
