import { ContractError, choice, list, object, text } from './codec.js';
import {
  clientReviewReport,
  type ClientReviewReport,
  type ReviewFinding,
  type EvidenceAssessment,
} from './review.js';

/** Imported status/confidence are retained verbatim and never promoted to source/test confirmation. */
export function importLegacyAssessment(
  value: unknown,
): Pick<
  ReviewFinding,
  'anchorValidation' | 'evidenceAssessment' | 'legacyVerification' | 'confidence'
> {
  const legacy = object({
    confidence: choice(['low', 'medium', 'high']),
    verification: object({
      status: choice(['verified', 'limited']),
      checks: list(text(256, 1), 100),
      originalPriority: text(64, 1),
    }),
  })(value);
  const evidenceAssessment: EvidenceAssessment = {
    level: 'unassessed',
    rationale:
      'Legacy verification checked file/line anchors; defect evidence has not been assessed.',
    conditions: [],
    evidenceIds: [],
    counterEvidence: { status: 'not-reviewed', summary: '', evidenceIds: [] },
  };
  return {
    confidence: legacy.confidence,
    legacyVerification: legacy.verification,
    anchorValidation: {
      status: legacy.verification.status,
      checks: [...legacy.verification.checks],
      reason: 'Imported legacy anchor checks.',
    },
    evidenceAssessment,
  };
}

type LegacyStatus = 'completed' | 'partial' | 'failed' | 'cancelled';
type LegacyCategory =
  'correctness' | 'security' | 'maintenance' | 'optimization' | 'review-history' | 'setting' | '';
type LegacyGrade = 'exceptional' | 'proficient' | 'adequate' | 'insufficient' | 'critical' | '';
type LegacyReason = ClientReviewReport['problems'][number]['code'];
export interface CommitDefenderProjection {
  schema_version: 1;
  staged_files: string[];
  duration_ms: number;
  exit_code: 0;
  lint_findings: [];
  review: {
    status: LegacyStatus;
    summary: string;
    blocking: false;
    is_error: boolean;
    grade: LegacyGrade;
    incomplete_reasons: LegacyReason[];
    file_comments: Array<{
      file: string;
      line: number;
      comment: string;
      category: LegacyCategory;
      priority: ReviewFinding['severity'];
    }>;
    per_file_summaries: Array<{
      file: string;
      summary: string;
      status: LegacyStatus | 'not-run';
      priority?: ReviewFinding['severity'];
      blocking: false;
      grade: LegacyGrade;
    }>;
  };
  source_anchors: Record<string, { sha256: string; line_count: number; side: 'source' | 'base' }>;
  source_snapshot:
    | { kind: 'index'; base_commit: string | null; base_tree: string; source_tree: string }
    | { kind: 'working-tree'; content_sha256: Record<string, string> };
  source_exclusions: ClientReviewReport['excluded'];
  gcr: {
    /** Preserve all identity, coverage, evidence and unprojected evaluations for the new UI. */
    report: ClientReviewReport;
    enforcement: 'advisory';
    projectionOmissions: Array<{ findingId: string; reason: string }>;
  };
}
function legacyStatus(report: ClientReviewReport): LegacyStatus {
  if (report.status === 'queued' || report.status === 'running')
    throw new ContractError(
      '$.status',
      'project only terminal reports; display live run progress separately',
    );
  if (report.status === 'completed' || report.status === 'partial') return report.status;
  if (
    report.status === 'needs-context' &&
    report.files.some((file) => file.status === 'completed' || file.status === 'partial')
  )
    return 'partial';
  if (report.status === 'cancelled' || report.status === 'superseded') return 'cancelled';
  return 'failed';
}
const categories = new Set<string>([
  'correctness',
  'security',
  'maintenance',
  'optimization',
  'review-history',
  'setting',
]);

/** Display projection only. New automatic reviews always use the advisory hook adapter. */
export function projectCommitDefender(value: ClientReviewReport): CommitDefenderProjection {
  const report = clientReviewReport(value);
  const status = legacyStatus(report);
  const projectionOmissions: CommitDefenderProjection['gcr']['projectionOmissions'] = [];
  const comments = report.findings.flatMap((finding) => {
    // CD's legacy comments cannot represent incomplete/not-applicable evaluations as findings.
    if (!(
      finding.outcome === 'violation' ||
      (finding.outcome === 'satisfied' && finding.severity === 'P0')
    )) {
      projectionOmissions.push({
        findingId: finding.id,
        reason: `Evaluation outcome: ${finding.outcome}`,
      });
      return [];
    }
    const text = [finding.problem, finding.impact, finding.recommendation]
      .filter(Boolean)
      .join('\n\n');
    return [
      {
        file: finding.anchor.path,
        line: finding.anchor.startLine,
        comment: text,
        category: (categories.has(finding.category) ? finding.category : '') as LegacyCategory,
        priority: finding.severity,
      },
    ];
  });
  const source = report.identity.source;
  const highestPriority = new Map<string, ReviewFinding['severity']>();
  for (const comment of comments) {
    const current = highestPriority.get(comment.file);
    if (!current || comment.priority > current) highestPriority.set(comment.file, comment.priority);
  }
  const fileSummary = report.files.map((file) => {
    const priority = highestPriority.get(file.source.path);
    return {
      file: file.source.path,
      summary: file.summary,
      status: file.status,
      ...(priority ? { priority } : {}),
      blocking: false as const,
      grade: file.grade ?? ('' as const),
    };
  });
  const reasons = [...new Set(report.problems.map((problem) => problem.code))];
  return {
    schema_version: 1,
    staged_files: report.files.map((file) => file.source.path),
    duration_ms: report.durationMs,
    exit_code: 0,
    lint_findings: [],
    review: {
      status,
      summary: report.summary,
      blocking: false,
      is_error: status === 'failed',
      grade: status === 'completed' ? (report.grade ?? '') : '',
      incomplete_reasons: reasons,
      file_comments: comments,
      per_file_summaries: fileSummary,
    },
    source_anchors: Object.fromEntries(
      report.files.map((file) => [
        file.source.path,
        { sha256: file.source.hash, line_count: file.source.lineCount, side: file.source.side },
      ]),
    ),
    source_snapshot:
      source.kind === 'index'
        ? {
            kind: 'index',
            base_commit: source.baseCommit,
            base_tree: source.baseTree,
            source_tree: source.sourceTree,
          }
        : {
            kind: 'working-tree',
            content_sha256: Object.fromEntries(
              report.files.map((file) => [file.source.path, file.source.hash]),
            ),
          },
    source_exclusions: report.excluded,
    gcr: { report, enforcement: 'advisory', projectionOmissions },
  };
}
