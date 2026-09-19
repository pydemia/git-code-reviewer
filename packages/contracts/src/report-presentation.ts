import type { z } from 'zod';
import type { reportViewSchema } from './index.js';
import type { ReviewAnalysis } from './review-analysis.js';
import { formatReviewNarrative } from './review-narrative.js';

// 저장된 Grade와 분석 기준은 유지하고 사용자에게 보이는 평가만 한국어로 설명한다.
export const reviewGrades = {
  exceptional: {
    label: '탁월',
    description: '구현 완성도가 매우 높은 수준으로 평가했습니다.',
    tone: 'positive',
  },
  proficient: {
    label: '우수',
    description: '기본 요구를 넘어 구현 품질이 우수한 수준으로 평가했습니다.',
    tone: 'positive',
  },
  adequate: {
    label: '양호',
    description: '기본 요구를 충족하는 수준으로 평가했습니다. 개선 의견은 남아 있을 수 있습니다.',
    tone: 'positive',
  },
  insufficient: {
    label: '개선 필요',
    description: '구현 품질이 부족해 개선이 필요한 수준으로 평가했습니다.',
    tone: 'warning',
  },
  critical: {
    label: '심각',
    description: '심각한 문제가 있는 수준으로 평가했습니다. 관련 검토 의견을 확인하세요.',
    tone: 'danger',
  },
} as const satisfies Record<
  z.infer<typeof reportViewSchema>['grade'],
  {
    label: string;
    description: string;
    tone: 'positive' | 'warning' | 'danger';
  }
>;

export function formatReviewGrade(grade: keyof typeof reviewGrades): string {
  return `${reviewGrades[grade].label} (${grade})`;
}

export const reviewPriorityLabels = {
  P0: 'P0 Praise',
  P1: 'P1 Info',
  P2: 'P2 Warning',
  P3: 'P3 Critical',
} as const;
export const reviewStatusLabels = {
  pass: '분석 완료 · PASS',
  blocked: '분석 완료 · BLOCKED',
  incomplete: '일부 검토 · 제한 있음',
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
  | 'analysis'
  | 'summary'
  | 'grade'
  | 'coverage'
  | 'versions'
  | 'durationMs'
  | 'perFileSummaries'
  | 'recurrence'
> & {
  findings: Array<
    Pick<
      View['findings'][number],
      | 'id'
      | 'priority'
      | 'category'
      | 'anchor'
      | 'title'
      | 'problem'
      | 'impact'
      | 'recommendation'
      | 'criteria'
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
  const groups = files.map((file) => {
    const findings = findingsByFile.get(file.fileId) ?? [];
    // 검토 완료와 지적 사항 부재가 모두 확인된 파일만 간결하게 표시한다.
    // 원본 report와 별도의 분석 제한은 보존한다. Legacy/미수행 결과는 추정하지 않는다.
    const noIssues =
      analysis &&
      ['ai-powered', 'hybrid'].includes(analysis.mode) &&
      !['demo', 'failed', 'unavailable'].includes(state) &&
      file.status === 'reviewed' &&
      'unitIds' in file &&
      file.unitIds.length === 0 &&
      file.priority === null &&
      findings.length === 0;
    return {
      ...file,
      summary: noIssues ? '검토한 변경 범위에서 문제가 발견되지 않았습니다.' : file.summary,
      findings,
    };
  });
  // When total-summary is unavailable, the engine joins the file summaries. Show
  // those once in their file blocks, including for reports already stored.
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  const rollup = files.map((file) => `${file.path}: ${file.summary}`).join('\n\n');
  const overview = normalize(report.summary) === normalize(rollup) ? null : report.summary.trim();
  return {
    state,
    label:
      state === 'blocked' && report.coverage.truncated
        ? '일부 검토 · BLOCKED'
        : reviewStatusLabels[state],
    groups,
    reviewGroups: groups.filter((file) => file.findings.length > 0),
    // Empty patches are not review findings. Keep raw coverage/status for auditing,
    // while avoiding one notification per empty file in existing reports as well.
    limitations: report.coverage.limitations.filter(
      (item) => !/^(?:.+: )?분석 가능한 변경 line이 없습니다\.$/.test(item.trim()),
    ),
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
  options: {
    reportUrl?: string;
    maxLength?: number;
    includeTitle?: boolean;
    audience?: 'full' | 'pull-request';
    minimumPriority?: 'P2' | 'P3';
    codePermalinks?: ReadonlyMap<string, string>;
  } = {},
): string {
  const minimumPriority = options.audience === 'pull-request' ? options.minimumPriority : undefined;
  if (minimumPriority) {
    const findings = report.findings.filter((finding) => finding.priority >= minimumPriority);
    const filtered = findings.length !== report.findings.length;
    const summaryFor = (fileId: string) =>
      findings
        .filter((finding) => finding.anchor.fileId === fileId)
        .map((finding) => finding.title)
        .join('\n\n');
    // Unfiltered summaries and previous findings can repeat opinions excluded from
    // notifications. Project only the outgoing view; preserve the canonical report.
    report = {
      ...report,
      findings,
      summary: filtered ? '' : report.summary,
      recurrence: undefined,
      perFileSummaries: report.perFileSummaries.map((file) => ({
        ...file,
        summary: filtered ? summaryFor(file.fileId) : file.summary,
      })),
      ...(report.analysis
        ? {
            analysis: {
              ...report.analysis,
              priority: findings.reduce<keyof typeof reviewPriorityLabels | null>(
                (max, finding) => (!max || finding.priority > max ? finding.priority : max),
                null,
              ),
              files: report.analysis.files.map((file) => ({
                ...file,
                summary: filtered ? summaryFor(file.fileId) : file.summary,
              })),
            },
          }
        : {}),
    };
  }
  const view = presentReviewReport(report, paths);
  const forPullRequest = options.audience === 'pull-request';
  const text = escapeReviewMarkdown;
  const html = (value: string) =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
      .replaceAll('@', '＠');
  const narrative = formatReviewNarrative;
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
    ...(minimumPriority
      ? [
          `PR 댓글 알림: ${minimumPriority === 'P2' ? 'P2 Warning 이상' : 'P3 Critical만'} · 전체 분석 결과는 보고서에서 확인할 수 있습니다.`,
        ]
      : []),
    `**${view.label}**${view.priority ? ` · ${reviewPriorityLabels[view.priority]}` : ''}${view.showGrade ? ` · 코드 품질: ${formatReviewGrade(report.grade)}${view.state === 'incomplete' ? ' · 검토 범위 내' : ''}` : ''}`,
    `| 파일 검토 | 검토 의견 | 소요 시간 | 분석 방식 |\n| :--- | :--- | :--- | :--- |\n| ${view.filesCompleted === null ? 'Legacy file coverage' : `${view.filesCompleted}/${report.coverage.filesChanged} files 검토 완료`} | ${report.findings.length} comments | ${formatReviewDuration(report.durationMs)} | ${view.mode} |`,
  ];
  if (view.overview) {
    blocks.push(`## 전체 분석 요약\n\n${narrative(view.overview)}`);
  }
  if (report.recurrence) {
    const history = report.recurrence;
    const repeated = history.items.filter(
      (item) => item.status === 'observed-again' || item.status === 'same-head',
    ).length;
    blocks.push(
      details(
        '이전 리뷰와 비교',
        [
          text(history.reason),
          ...(history.baseline
            ? [
                `비교 SHA: ${history.baseline.headSha} · ${history.baseline.state === 'partial' ? '일부 검토' : '검토 완료'}`,
                `같은 코드·설명의 재관측 ${repeated}개 · 재확인하지 못한 이전 지적 ${history.unconfirmedPrevious.length}개`,
                '현재 지적을 숨기거나 이전 지적의 수정 완료를 판정하지 않습니다.',
                ...history.unconfirmedPrevious.map(
                  (item) =>
                    `- ${item.priority} · ${text(item.title)}${item.path ? ` · ${text(item.path)}` : ''}`,
                ),
              ]
            : []),
        ].join('\n\n'),
      ),
    );
  }
  if (view.state === 'demo')
    blocks.push(
      '> 실제 AI 검토 완료를 의미하지 않습니다. 분석 Provider 설정과 오류를 확인한 뒤 재분석하세요.',
    );
  if (view.limitations.length)
    blocks.push(
      `## 분석 제한 ${view.limitations.length}건\n\n${view.limitations.map((item) => `- ${text(item)}`).join('\n')}`,
    );
  if (!forPullRequest) {
    blocks.push('## Overall Summary');
    for (const file of view.reviewGroups)
      blocks.push(
        details(
          `<code>${html(file.path)}</code> · ${reviewFileStatusLabels[file.status]} · ${file.findings.length} comments${file.priority ? ` · ${reviewPriorityLabels[file.priority]}` : ''}`,
          narrative(file.summary),
        ),
      );
  }
  blocks.push('## AI Comments');
  const limit = options.maxLength ?? Number.POSITIVE_INFINITY;
  const omission = '\n\n> 댓글 길이 제한으로 일부 항목을 생략했습니다. 전체 report에서 확인하세요.';
  const modelBlock = report.analysis
    ? details(
        '적용 Model·Skill',
        `Model: ${text(report.versions.model ?? view.mode)}\n\nSkill bundle: ${report.analysis.skills.version === null ? 'Built-in' : `Version ${report.analysis.skills.version}`} · SHA-256 ${text(report.analysis.skills.bundleHash)}`,
      )
    : '';
  // Reserve existing status, provenance and report links before selecting whole comments.
  let prefixLength = 0;
  for (const block of blocks) {
    if (prefixLength + block.length + footer.length + omission.length + 2 <= limit)
      prefixLength += block.length + 2;
  }
  const commentBudget = forPullRequest
    ? limit - prefixLength - footer.length - omission.length - modelBlock.length - 8
    : Number.POSITIVE_INFINITY;
  const comments: string[] = [];
  const includedFiles = new Set<string>();
  let includedCount = 0,
    omittedComments = 0,
    lastFile = '';
  const commentLabel = (count: number, files: number) =>
    `검토 의견 ${count === report.findings.length ? count : `${count}/${report.findings.length}`}개 · 파일 ${files}개 — 펼쳐 보기`;
  const ordered = view.reviewGroups.flatMap((file) =>
    file.findings.map((finding) => ({ file, finding })),
  );
  if (forPullRequest) ordered.sort((a, b) => b.finding.priority.localeCompare(a.finding.priority));
  for (const { file, finding } of ordered) {
    const anchor = finding.anchor;
    const location = `${anchor.side} · ${anchor.startLine ? `line ${anchor.startLine}${anchor.endLine && anchor.endLine !== anchor.startLine ? `–${anchor.endLine}` : ''}` : '파일 전체'}`;
    const link = linkFor(file.fileId, finding.id);
    const codeLink = options.codePermalinks?.get(finding.id);
    // A standalone permalink lets GitHub render its native code snippet. Keep
    // it outside the blockquote and never derive it from model-written text.
    const comment = [
      `💬 **${reviewPriorityLabels[finding.priority]} · ${narrative(finding.title).replace(/\n/g, ' ')}**`,
      `${text(finding.category)} · ${location}`,
      ...(finding.problem && finding.problem !== finding.title ? [narrative(finding.problem)] : []),
      ...(finding.impact ? [`**영향**\n\n${narrative(finding.impact)}`] : []),
      ...(finding.recommendation ? [`**수정 제안**\n\n${narrative(finding.recommendation)}`] : []),
      ...(finding.criteria
        ? [
            details(
              '공용 기준 판단',
              [
                '모델 판단이며 기준 버전·적용 파일의 연결만 확인했습니다. 결함 확정이나 테스트 실행 증거는 아닙니다.',
                ...(finding.criteria.status === 'not-reported'
                  ? ['기준별 판단이 보고되지 않았습니다.']
                  : []),
                ...(finding.criteria.rejected
                  ? [
                      `연결 조건을 충족하지 못한 판단 ${finding.criteria.rejected}개를 제외했습니다.`,
                    ]
                  : []),
                ...finding.criteria.items.map((item) =>
                  [
                    `**${text(item.title)} · v${item.revision} · ${{ violation: '위반 가능성', satisfied: '충족 판단', uncertain: '판단 미완료' }[item.outcome]}**`,
                    text(item.rationale),
                    `반증 ${item.counterEvidence.status === 'reviewed' ? '검토' : '미검토'}: ${text(item.counterEvidence.explanation)}`,
                    `기준 ID: ${text(item.id)} · hash: ${item.hash}`,
                  ].join('\n\n'),
                ),
              ].join('\n\n'),
            ),
          ]
        : []),
      ...(link ? [`[관련 코드 보기](${link})`] : []),
    ].join('\n\n');
    const candidate = [
      ...(lastFile !== file.fileId ? [`### ${text(file.path)}`] : []),
      ...(forPullRequest && !includedFiles.has(file.fileId) && file.summary.trim()
        ? [`**파일 요약 · ${reviewFileStatusLabels[file.status]}**\n\n${narrative(file.summary)}`]
        : []),
      ...(forPullRequest && codeLink && safeUrl(codeLink) ? [safeUrl(codeLink)] : []),
      comment
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n'),
      '---',
    ].join('\n\n');
    const fileCount = includedFiles.size + (includedFiles.has(file.fileId) ? 0 : 1);
    if (
      details(commentLabel(includedCount + 1, fileCount), [...comments, candidate].join('\n\n'))
        .length > commentBudget
    ) {
      omittedComments++;
      continue;
    }
    comments.push(candidate);
    includedFiles.add(file.fileId);
    lastFile = file.fileId;
    includedCount++;
  }
  if (comments.length)
    blocks.push(details(commentLabel(includedCount, includedFiles.size), comments.join('\n\n')));
  else
    blocks.push(
      omittedComments
        ? '댓글 길이 제한으로 검토 의견을 표시하지 못했습니다. 전체 보고서에서 확인하세요.'
        : minimumPriority
          ? 'PR 알림 기준에 해당하는 검토 의견이 없습니다. 전체 분석 상태와 범위는 위 내용을 확인하세요.'
          : forPullRequest && view.state === 'pass'
            ? '검토한 변경 범위에서 문제가 발견되지 않았습니다.'
            : '표시할 comment가 없습니다. 분석 상태와 제한을 함께 확인하세요.',
    );
  if (!forPullRequest) {
    blocks.push('## Analyzed File List');
    blocks.push(
      details(
        `검토 의견이 있는 파일 ${view.reviewGroups.length}개 보기`,
        `| 파일 | 검토 상태 | 의견 |\n| :--- | :--- | ---: |\n${view.reviewGroups
          .map(
            (file) =>
              `| ${text(file.path)} | ${reviewFileStatusLabels[file.status]} | ${file.findings.length} |`,
          )
          .join('\n')}`,
      ),
    );
  }
  if (modelBlock) blocks.push(modelBlock);
  let result = '';
  let omitted = omittedComments > 0;
  for (const block of blocks) {
    if (result.length + block.length + footer.length + omission.length + 2 > limit) {
      omitted = true;
      continue;
    }
    result += `${result ? '\n\n' : ''}${block}`;
  }
  return result + (omitted ? omission : '') + footer;
}
