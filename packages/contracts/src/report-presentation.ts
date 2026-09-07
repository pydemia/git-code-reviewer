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
  // When total-summary is unavailable, the engine joins the file summaries. Show
  // those once in their file blocks, including for reports already stored.
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  const rollup = groups.map((file) => `${file.path}: ${file.summary}`).join('\n\n');
  const overview = normalize(report.summary) === normalize(rollup) ? null : report.summary.trim();
  return {
    state,
    label: reviewStatusLabels[state],
    groups,
    overview,
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

export function formatReviewDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 ${seconds % 60}초`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
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
  options: { reportUrl?: string; maxLength?: number; includeTitle?: boolean } = {},
): string {
  const view = presentReviewReport(report, paths);
  const text = escapeReviewMarkdown;
  const html = (value: string) =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
      .replaceAll('@', '＠');
  // Inline HTML still permits Markdown parsing between its tags. Entities keep
  // code punctuation literal (including link syntax and emphasis).
  const code = (value: string) =>
    html(value).replace(/[\\`*_{}[\]()#+.!|~-]/g, (character) => `&#${character.charCodeAt(0)};`);
  const narrative = (value: string) =>
    value
      .split(/\r?\n/)
      .map((line) =>
        line
          .split(/(`[^`\n]+`)/g)
          .map((part) =>
            part.startsWith('`') && part.endsWith('`')
              ? `<code>${code(part.slice(1, -1))}</code>`
              : part.trim()
                ? `${part.match(/^\s*/)?.[0] ?? ''}${text(part)}${part.match(/\s*$/)?.[0] ?? ''}`
                : part,
          )
          .join(''),
      )
      .join('\n');
  // Only these template tags are HTML; source/model content is always escaped.
  const details = (label: string, body: string) =>
    `<details>\n<summary>${label}</summary>\n\n${body}\n\n</details>`;
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
    return safeUrl(url.toString());
  };
  const footer = reportUrl ? `\n\n[전체 review와 evidence 보기](${reportUrl})` : '';
  if (view.state === 'unavailable' || view.state === 'failed') {
    const message =
      view.state === 'failed'
        ? '분석 중 오류가 발생했습니다. 상세 보고서에서 원인을 확인한 뒤 재분석하세요.'
        : view.mode === 'disabled' || report.versions.model === 'disabled'
          ? '분석 모델이 비활성화되어 있습니다. 모델을 설정한 뒤 재분석하세요.'
          : '분석을 수행하지 못했습니다. 분석 설정과 상세 보고서를 확인한 뒤 재분석하세요.';
    return `**${view.label}**\n\n${message}${footer}`;
  }
  const blocks = [
    ...(options.includeTitle === false ? [] : ['# Git Code Reviewer']),
    `**${view.label}**${view.priority ? ` · ${reviewPriorityLabels[view.priority]}` : ''}${view.showGrade ? ` · Grade: ${report.grade}${view.state === 'incomplete' ? ' (검토 범위 내)' : ''}` : ''}`,
    `| 파일 검토 | 검토 의견 | 소요 시간 | 분석 방식 |\n| :--- | :--- | :--- | :--- |\n| ${view.filesCompleted === null ? 'Legacy file coverage' : `${view.filesCompleted}/${report.coverage.filesChanged} files 검토 완료`} | ${report.findings.length} comments | ${formatReviewDuration(report.durationMs)} | ${view.mode} |`,
  ];
  if (view.overview)
    blocks.push(
      view.overview.length > 600
        ? details('전체 분석 요약', narrative(view.overview))
        : narrative(view.overview),
    );
  if (view.state === 'demo')
    blocks.push(
      '> 실제 AI 검토 완료를 의미하지 않습니다. 분석 Provider 설정과 오류를 확인한 뒤 재분석하세요.',
    );
  if (report.coverage.limitations.length)
    blocks.push(
      details(
        `분석 제한 ${report.coverage.limitations.length}건`,
        report.coverage.limitations.map((item) => `- ${text(item)}`).join('\n'),
      ),
    );
  blocks.push('## Overall Summary');
  for (const file of view.groups)
    blocks.push(
      details(
        `<code>${html(file.path)}</code> · ${reviewFileStatusLabels[file.status]} · ${file.findings.length} comments${file.priority ? ` · ${reviewPriorityLabels[file.priority]}` : ''}`,
        narrative(file.summary),
      ),
    );
  blocks.push('## AI Comments');
  for (const file of view.groups) {
    if (!file.findings.length) continue;
    blocks.push(`### ${text(file.path)}`);
    for (const finding of file.findings) {
      const anchor = finding.anchor;
      const location = `${anchor.side} · ${anchor.startLine ? `line ${anchor.startLine}${anchor.endLine && anchor.endLine !== anchor.startLine ? `–${anchor.endLine}` : ''}` : '파일 전체'}`;
      const link = linkFor(file.fileId, finding.id);
      const comment = [
        `💬 **${reviewPriorityLabels[finding.priority]} · ${narrative(finding.title).replace(/\n/g, ' ')}**`,
        `${text(finding.category)} · ${location}`,
        ...(finding.problem && finding.problem !== finding.title
          ? [narrative(finding.problem)]
          : []),
        ...(finding.impact ? [`**영향**\n\n${narrative(finding.impact)}`] : []),
        ...(finding.recommendation
          ? [`**수정 제안**\n\n${narrative(finding.recommendation)}`]
          : []),
        ...(link ? [`[관련 코드 보기](${link})`] : []),
      ].join('\n\n');
      blocks.push(
        comment
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n'),
      );
      blocks.push('---');
    }
  }
  if (!report.findings.length)
    blocks.push('표시할 comment가 없습니다. 분석 상태와 제한을 함께 확인하세요.');
  blocks.push('## Analyzed File List');
  blocks.push(
    details(
      `파일 ${view.groups.length}개 보기`,
      `| 파일 | 검토 상태 | 의견 |\n| :--- | :--- | ---: |\n${view.groups
        .map(
          (file) =>
            `| ${text(file.path)} | ${reviewFileStatusLabels[file.status]} | ${file.findings.length} |`,
        )
        .join('\n')}`,
    ),
  );
  if (report.analysis)
    blocks.push(
      details(
        '적용 Model·Skill',
        `Model: ${text(report.versions.model ?? view.mode)}\n\nSkill bundle: ${report.analysis.skills.version === null ? 'Built-in' : `Version ${report.analysis.skills.version}`} · SHA-256 ${text(report.analysis.skills.bundleHash)}`,
      ),
    );
  const limit = options.maxLength ?? Number.POSITIVE_INFINITY;
  const omission = '\n\n> 댓글 길이 제한으로 일부 항목을 생략했습니다. 전체 report에서 확인하세요.';
  let result = '';
  let omitted = false;
  for (const block of blocks) {
    if (result.length + block.length + footer.length + omission.length + 2 > limit) {
      omitted = true;
      continue;
    }
    result += `${result ? '\n\n' : ''}${block}`;
  }
  return result + (omitted ? omission : '') + footer;
}
