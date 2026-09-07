import type { z } from 'zod';
import type { reportViewSchema } from './index.js';
import type { ReviewAnalysis } from './review-analysis.js';

export const reviewPriorityLabels = {
  P0: 'P0 Praise',
  P1: 'P1 Info',
  P2: 'P2 Warning',
  P3: 'P3 Critical',
} as const;
export const reviewStatusLabels = {
  pass: '분석 완료 · PASS',
  blocked: '분석 완료 · BLOCKED',
  incomplete: '분석 완료 · 제한 있음',
  unavailable: '분석 미수행',
  failed: '분석 실패',
  demo: '데모 분석',
} as const;
export const reviewFileStatusLabels = {
  reviewed: '검토 완료',
  partial: '일부 검토',
  'not-reviewed': '미검토',
  legacy: 'Legacy 분석',
} as const;
type View = z.infer<typeof reportViewSchema>;
export type ReportContent = Pick<
  View,
  'analysis' | 'summary' | 'grade' | 'coverage' | 'versions' | 'durationMs' | 'perFileSummaries'
> & {
  findings: Array<
    Pick<
      View['findings'][number],
      'id' | 'priority' | 'category' | 'anchor' | 'title' | 'problem' | 'impact' | 'recommendation'
    >
  >;
};
export type ReportFile = { id: string; path: string };

export function presentReviewReport<F extends ReportContent['findings'][number]>(
  report: ReportContent & { findings: F[] },
  paths: ReportFile[] = [],
) {
  const { analysis } = report;
  const state: ReviewAnalysis['status'] =
    analysis?.status ??
    (report.versions.model?.startsWith('fixture')
      ? 'demo'
      : report.versions.review === 'failed'
        ? 'failed'
        : report.versions.model === 'disabled' || report.versions.review === 'unavailable'
          ? 'unavailable'
          : report.coverage.truncated || report.coverage.limitations.length
            ? 'incomplete'
            : report.findings.some((finding) => finding.priority === 'P3')
              ? 'blocked'
              : 'pass');
  const findingsByFile = new Map<string, F[]>();
  for (const finding of report.findings) {
    const group = findingsByFile.get(finding.anchor.fileId) ?? [];
    group.push(finding);
    findingsByFile.set(finding.anchor.fileId, group);
  }
  const pathById = new Map(paths.map((file) => [file.id, file.path]));
  const legacyIds = new Set([
    ...paths.map((file) => file.id),
    ...report.perFileSummaries.map((file) => file.fileId),
    ...findingsByFile.keys(),
  ]);
  const files =
    analysis?.files ??
    [...legacyIds].map((fileId) => {
      const legacy = report.perFileSummaries.find((file) => file.fileId === fileId);
      return {
        fileId,
        path: pathById.get(fileId) ?? fileId,
        summary: legacy?.summary ?? '이전 report에는 파일별 요약이 없습니다.',
        status: 'legacy' as const,
        priority: legacy?.priority ?? null,
      };
    });
  const groups = files.map((file) => ({
    ...file,
    findings: findingsByFile.get(file.fileId) ?? [],
  }));
  return {
    state,
    label: reviewStatusLabels[state],
    groups,
    priority: analysis
      ? analysis.priority
      : report.findings.reduce<keyof typeof reviewPriorityLabels | null>(
          (max, finding) => (!max || finding.priority > max ? finding.priority : max),
          null,
        ),
    mode: analysis?.mode ?? 'legacy',
    filesCompleted: analysis?.coverage.filesCompleted ?? null,
    showGrade: state !== 'demo' && state !== 'failed' && state !== 'unavailable',
  };
}

// Source/model의 HTML, Markdown link와 @mention을 실행하지 않고 텍스트로 보존한다.
export function escapeReviewMarkdown(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\\', '\\\\')
    .replaceAll('@', '＠')
    .replace(/[<>`*_{}[\]()#+.!|~-]/g, '\\$&')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

export function formatReviewMarkdown(
  report: ReportContent,
  paths: ReportFile[] = [],
  options: { reportUrl?: string; maxLength?: number } = {},
): string {
  const view = presentReviewReport(report, paths);
  const text = escapeReviewMarkdown;
  const safeUrl = (url: string) => {
    try {
      const parsed = new URL(url);
      return ['https:', 'http:'].includes(parsed.protocol)
        ? parsed.toString().replaceAll('(', '%28').replaceAll(')', '%29')
        : '';
    } catch {
      return '';
    }
  };
  const reportUrl = options.reportUrl ? safeUrl(options.reportUrl) : '';
  const linkFor = (fileId: string, findingId?: string) => {
    if (!reportUrl) return '';
    const url = new URL(reportUrl);
    url.searchParams.set('file', fileId);
    if (findingId) url.searchParams.set('finding', findingId);
    return url.toString();
  };
  const footer = reportUrl ? `\n\n[전체 review와 evidence 보기](${reportUrl})` : '';
  const blocks = [
    '# Git Code Reviewer',
    `**${view.label}**${view.priority ? ` · ${reviewPriorityLabels[view.priority]}` : ''}${view.showGrade ? ` · Grade: ${report.grade}${view.state === 'incomplete' ? ' (검토 범위 내)' : ''}` : ''}`,
    `${view.filesCompleted === null ? 'Legacy file coverage' : `${view.filesCompleted}/${report.coverage.filesChanged} files 검토 완료`} · ${report.findings.length} comments · ${view.mode} · ${report.durationMs} ms`,
    text(report.summary),
  ];
  if (view.state === 'demo' || view.state === 'unavailable' || view.state === 'failed')
    blocks.push(
      '> 실제 AI 검토 완료를 의미하지 않습니다. 분석 Provider 설정과 오류를 확인한 뒤 재분석하세요.',
    );
  if (report.coverage.limitations.length)
    blocks.push(`> 분석 제한: ${report.coverage.limitations.map(text).join(' / ')}`);
  blocks.push('## Overall Summary');
  for (const file of view.groups)
    blocks.push(
      `### ${text(file.path)}${file.priority ? ` · ${reviewPriorityLabels[file.priority]}` : ''}\n\n${reviewFileStatusLabels[file.status]}\n\n${text(file.summary)}`,
    );
  blocks.push('## AI Comments');
  for (const file of view.groups) {
    if (!file.findings.length) continue;
    blocks.push(`### ${text(file.path)}`);
    for (const finding of file.findings) {
      const anchor = finding.anchor;
      const location = `${anchor.side} · ${anchor.startLine ? `line ${anchor.startLine}${anchor.endLine && anchor.endLine !== anchor.startLine ? `–${anchor.endLine}` : ''}` : '파일 전체'}`;
      const link = linkFor(file.fileId, finding.id);
      blocks.push(
        `**${reviewPriorityLabels[finding.priority]} · ${text(finding.category)} · ${location}**\n\n${text(finding.problem || finding.title)}${finding.impact ? `\n\n영향: ${text(finding.impact)}` : ''}${finding.recommendation ? `\n\n수정 제안: ${text(finding.recommendation)}` : ''}${link ? `\n\n[관련 코드 보기](${link})` : ''}`,
      );
    }
  }
  if (!report.findings.length)
    blocks.push('표시할 comment가 없습니다. 분석 상태와 제한을 함께 확인하세요.');
  blocks.push('## Analyzed File List');
  blocks.push(
    ...view.groups.map(
      (file) =>
        `- ${text(file.path)} · ${reviewFileStatusLabels[file.status]} · ${file.findings.length} comments`,
    ),
  );
  if (report.analysis)
    blocks.push(
      `Skill bundle: ${report.analysis.skills.version === null ? 'Built-in' : `Version ${report.analysis.skills.version}`} · SHA-256 ${report.analysis.skills.bundleHash}`,
    );
  const limit = options.maxLength ?? Number.POSITIVE_INFINITY;
  const omission = '\n\n> 댓글 길이 제한으로 이후 항목을 생략했습니다. 전체 report에서 확인하세요.';
  let result = '';
  for (const block of blocks) {
    if (result.length + block.length + footer.length + omission.length + 2 > limit)
      return `${result}${omission}${footer}`;
    result += `${result ? '\n\n' : ''}${block}`;
  }
  return result + footer;
}
