import { createHash } from 'node:crypto';
import type { Database } from '@gcr/db';
import type { FilesystemArtifactStore } from '@gcr/artifact-store';
import { reviewRecurrenceSchema, type ReviewRecurrence } from '@gcr/contracts';
import { reviewReportSchema, type ReviewReport } from '@gcr/review-contract';

type Baseline = NonNullable<ReviewRecurrence['baseline']>;
const counts = (report: ReviewReport) => {
  const result = new Map<string, number>();
  for (const finding of report.findings)
    if (finding.occurrence)
      result.set(finding.occurrence.key, (result.get(finding.occurrence.key) ?? 0) + 1);
  return result;
};
export function compareReviewOccurrences(
  current: ReviewReport,
  previous: ReviewReport,
  headSha: string,
  baseline: Baseline,
): ReviewRecurrence {
  const before = counts(previous),
    after = counts(current);
  const byKey = new Map(
    previous.findings.filter((f) => f.occurrence).map((f) => [f.occurrence!.key, f]),
  );
  const matched = new Set<string>();
  const items = current.findings.map((finding) => {
    const key = finding.occurrence?.key,
      prior = key ? byKey.get(key) : undefined;
    const ambiguous = key && ((after.get(key) ?? 0) > 1 || (before.get(key) ?? 0) > 1);
    if (prior && !ambiguous) matched.add(prior.id);
    return {
      findingId: finding.id,
      status: !key
        ? 'untracked'
        : ambiguous
          ? 'ambiguous'
          : prior
            ? headSha === baseline.headSha
              ? 'same-head'
              : 'observed-again'
            : 'not-in-baseline',
      previousFindingId: prior && !ambiguous ? prior.id : null,
    } as ReviewRecurrence['items'][number];
  });
  return reviewRecurrenceSchema.parse({
    schemaVersion: 1,
    status: 'compared',
    reason:
      '직전 공용 보고서와 코드 구간·설명·분석 기준이 같은 관측을 비교했습니다. 일치하지 않거나 누락된 지적의 수정 여부는 확인하지 않았습니다.',
    baseline,
    items,
    unconfirmedPrevious: previous.findings
      .filter((f) => f.priority !== 'P0' && !matched.has(f.id))
      .map((f) => ({
        findingId: f.id,
        title: f.title,
        path: f.occurrence?.path ?? '',
        priority: f.priority,
      })),
  });
}

export async function loadReviewRecurrence(
  database: Database,
  artifacts: Pick<FilesystemArtifactStore, 'readText'>,
  report: ReviewReport,
): Promise<ReviewRecurrence | undefined> {
  const unavailable = (
    reason: string,
    status: 'unavailable' | 'no-baseline' = 'unavailable',
  ): ReviewRecurrence => ({
    schemaVersion: 1,
    status,
    reason,
    baseline: null,
    items: [],
    unconfirmedPrevious: [],
  });
  try {
    const current = (
      await database.query<{
        pull_request_id: string;
        head_sha: string;
        created_at: Date;
        memory_owner_user_id: string | null;
      }>(
        `select sr.pull_request_id,sr.head_sha,ar.created_at,ar.memory_owner_user_id
      from analysis_runs ar join snapshots s on s.id=ar.snapshot_id join snapshot_requests sr on sr.id=s.request_id where ar.id=$1`,
        [report.analysisRevisionId],
      )
    ).rows[0];
    if (!current || current.memory_owner_user_id) return undefined;
    const prior = (
      await database.query<{
        analysis_id: string;
        snapshot_id: string;
        head_sha: string;
        state: 'completed' | 'partial';
        locator: string | null;
        checksum: string | null;
        byte_size: string | null;
        artifact_state: string | null;
      }>(
        `select ar.id as analysis_id,ar.snapshot_id,sr.head_sha,ar.state,a.locator,a.checksum,a.byte_size,a.state as artifact_state
      from analysis_runs ar join snapshots s on s.id=ar.snapshot_id join snapshot_requests sr on sr.id=s.request_id join reports r on r.analysis_run_id=ar.id left join artifacts a on a.id=r.artifact_id
      where sr.pull_request_id=$1 and ar.memory_owner_user_id is null and ar.state in ('completed','partial') and (ar.created_at,ar.id)<(select created_at,id from analysis_runs where id=$2)
      order by ar.created_at desc,ar.id desc limit 1`,
        [current.pull_request_id, report.analysisRevisionId],
      )
    ).rows[0];
    if (!prior) return unavailable('비교할 이전 공용 보고서가 없습니다.', 'no-baseline');
    if (
      !prior.locator ||
      prior.artifact_state !== 'available' ||
      !prior.byte_size ||
      Number(prior.byte_size) > 8 * 1024 * 1024
    )
      return unavailable('직전 공용 보고서가 없거나 조회 예산을 초과했습니다.');
    const bytes = await artifacts.readText(prior.locator);
    if (
      Buffer.byteLength(bytes) !== Number(prior.byte_size) ||
      createHash('sha256').update(bytes).digest('hex') !== prior.checksum
    )
      return unavailable('직전 공용 보고서의 무결성을 확인하지 못했습니다.');
    const previous = reviewReportSchema.parse(JSON.parse(bytes));
    if (
      previous.analysisRevisionId !== prior.analysis_id ||
      previous.snapshotId !== prior.snapshot_id
    )
      return unavailable('직전 공용 보고서의 분석 식별자가 일치하지 않습니다.');
    if (previous.findings.length > 2000 || report.findings.length > 2000)
      return unavailable('보고서 비교 지적 수 예산을 초과했습니다.');
    if (
      previous.findings.some((f) => f.priority !== 'P0') &&
      !previous.findings.some((f) => f.occurrence)
    )
      return unavailable('직전 보고서에는 코드 구간 관측 식별자가 없습니다.');
    return compareReviewOccurrences(report, previous, current.head_sha, {
      analysisId: prior.analysis_id,
      headSha: prior.head_sha,
      state: prior.state,
    });
  } catch {
    return unavailable('이전 공용 보고서 비교를 완료하지 못했습니다.');
  }
}
