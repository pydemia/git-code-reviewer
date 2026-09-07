import {
  priorityRank,
  reviewAnalysisSchema,
  type ReviewAnalysis,
  type ReviewFinding,
  type ReviewSkillBundle,
} from '@gcr/review-contract';
import { validateReviewSkillBundle } from './skills.js';

type FileResult = {
  fileId: string;
  path: string;
  status: 'reviewed' | 'partial' | 'not-reviewed';
  summary: string;
};

export function representativePriority(
  findings: Pick<ReviewFinding, 'priority'>[],
): ReviewFinding['priority'] | null {
  return findings.reduce<ReviewFinding['priority'] | null>(
    (highest, finding) =>
      highest === null || priorityRank(finding.priority) > priorityRank(highest)
        ? finding.priority
        : highest,
    null,
  );
}

/** P0를 "문제 없음"과 혼동하지 않도록 같은 파일의 문제 지적과 함께 발행하지 않는다. */
export function filterContradictoryPraise(findings: ReviewFinding[]): ReviewFinding[] {
  const filesWithConcerns = new Set(
    findings.filter((finding) => finding.priority !== 'P0').map((finding) => finding.anchor.fileId),
  );
  return findings.filter(
    (finding) => finding.priority !== 'P0' || !filesWithConcerns.has(finding.anchor.fileId),
  );
}

export function assembleReviewAnalysis(input: {
  findings: ReviewFinding[];
  files: FileResult[];
  skills: ReviewSkillBundle;
  skillVersionId?: string | null;
  skillVersion?: number | null;
  mode: ReviewAnalysis['mode'];
  reviewStatus: 'model' | 'fixture' | 'failed' | 'unavailable';
  incomplete: boolean;
  coverage: Omit<ReviewAnalysis['coverage'], 'filesCompleted'>;
}): ReviewAnalysis {
  const skills = validateReviewSkillBundle(input.skills);
  const active = skills.skills.filter((skill) => skill.enabled);
  const findings = filterContradictoryPraise(input.findings);
  const units = findings.map((finding) => {
    const skill = active.find(
      (item) => item.name === finding.category && item.kind === 'perspective',
    );
    if (!skill) throw new Error('Comment가 활성 perspective Skill을 참조하지 않습니다.');
    return {
      id: finding.id,
      kind: 'unit-comment-block' as const,
      findingId: finding.id,
      segment: {
        id: finding.anchor.id,
        fileId: finding.anchor.fileId,
        side: finding.anchor.side,
        ...(finding.anchor.startLine
          ? {
              startLine: finding.anchor.startLine,
              endLine: finding.anchor.endLine ?? finding.anchor.startLine,
            }
          : {}),
      },
      skill: { name: skill.name, version: skill.version, contentHash: skill.contentHash },
    };
  });
  const priority = representativePriority(findings);
  const status: ReviewAnalysis['status'] =
    input.reviewStatus === 'fixture'
      ? 'demo'
      : input.reviewStatus === 'unavailable'
        ? 'unavailable'
        : input.reviewStatus === 'failed'
          ? 'failed'
          : priority === 'P3'
            ? 'blocked'
            : input.incomplete || input.files.some((file) => file.status !== 'reviewed')
              ? 'incomplete'
              : 'pass';
  return reviewAnalysisSchema.parse({
    format: 'commit-defender-total-summary-v1',
    status,
    priority,
    mode: input.mode,
    units,
    files: input.files.map((file) => ({
      ...file,
      priority: representativePriority(
        findings.filter((finding) => finding.anchor.fileId === file.fileId),
      ),
      unitIds: units.filter((unit) => unit.segment.fileId === file.fileId).map((unit) => unit.id),
    })),
    skills: {
      bundleHash: skills.hash,
      versionId: input.skillVersionId ?? null,
      version: input.skillVersion ?? null,
      entries: active.map((skill) => ({
        name: skill.name,
        title: skill.title,
        kind: skill.kind,
        unit: skill.unit,
        version: skill.version,
        enabled: skill.enabled,
        contentHash: skill.contentHash,
      })),
    },
    coverage: {
      ...input.coverage,
      filesCompleted: input.files.filter((file) => file.status === 'reviewed').length,
    },
  });
}
