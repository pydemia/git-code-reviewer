import { createHash } from 'node:crypto';
import type { AnalysisProgress, ReviewMemoryProjection, ReviewSeverityLevel } from '@gcr/contracts';
import { filterSeverityComments, severityInstructions } from './review-severity.js';
import {
  gradeSchema,
  legacyAnalysisReportSchema,
  prioritySchema,
  type LegacyAnalysisReport,
  type ReviewAnalysis,
  type ReviewSkillBundle,
} from '@gcr/review-contract';
import type { AnalysisFile, ReviewModel } from './index.js';
import {
  buildReviewWindows,
  formatReviewWindow,
  windowContainsComment,
  type ReviewWindow,
} from './review-windows.js';
import { validateReviewSkillBundle } from './skills.js';
import { incompleteFileSummary, reviewFailure } from './review-failures.js';

type Comment = LegacyAnalysisReport['review']['file_comments'][number];
type FileResult = ReviewAnalysis['files'][number];
export type SkillReviewOutput = {
  legacy: LegacyAnalysisReport;
  files: Array<Pick<FileResult, 'fileId' | 'path' | 'status' | 'summary'>>;
  reviewStatus: 'model' | 'failed' | 'unavailable';
  limitations: string[];
  coverage: Omit<ReviewAnalysis['coverage'], 'filesCompleted'>;
  windows: ReviewWindow[];
};

const ranks: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const maxStageInputBytes = 128_000;

export async function runSkillReview(input: {
  files: AnalysisFile[];
  allFiles: AnalysisFile[];
  skills: ReviewSkillBundle;
  model?: ReviewModel;
  instructions?: string;
  severityLevel?: ReviewSeverityLevel;
  memory?: ReviewMemoryProjection[];
  maxModelCalls: number;
  onProgress?: (stage: string, detail: AnalysisProgress) => Promise<void>;
}): Promise<SkillReviewOutput> {
  const skills = validateReviewSkillBundle(input.skills);
  const active = new Set(
    skills.skills
      .filter((skill) => skill.enabled && skill.kind === 'perspective')
      .map((skill) => skill.name),
  );
  const windows = planReviewWindows(input.files, input.maxModelCalls);
  const comments: Comment[] = [];
  const fingerprints = new Map<string, Comment>();
  const limitations: string[] = [];
  const fileResults: SkillReviewOutput['files'] = [];
  const fileGrades = new Map<string, string>();
  const coverage = { windowsPlanned: windows.length, windowsReviewed: 0, modelCalls: 0 };
  let successfulCalls = 0;
  const instructions = input.severityLevel
    ? severityInstructions(input.severityLevel, input.instructions)
    : input.instructions;
  const publishProgress = async (stage: string, currentFile: string | null) => {
    await input.onProgress?.(stage, {
      filesProcessed: fileResults.length,
      filesTotal: input.allFiles.length,
      filesReviewed: fileResults.filter((file) => file.status === 'reviewed').length,
      filesSkipped: fileResults.filter((file) => file.status === 'not-reviewed').length,
      currentFile,
    });
  };

  const call = async (
    stage: 'unit-comment-block' | 'overall-summary' | 'total-summary',
    body: string,
    files: string[],
  ) => {
    if (!input.model) return null;
    const reservedCalls =
      stage === 'unit-comment-block' && input.maxModelCalls >= 3
        ? 2
        : stage === 'overall-summary' && input.maxModelCalls >= 2
          ? 1
          : 0;
    if (coverage.modelCalls >= input.maxModelCalls - reservedCalls) {
      limitations.push(`${stage}: model call budget 초과`);
      return null;
    }
    if (Buffer.byteLength(body) > maxStageInputBytes) {
      limitations.push(`${stage}: 모델 입력 크기 제한 초과`);
      return null;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      coverage.modelCalls += 1;
      try {
        const result = await input.model.review(body, files, instructions, {
          stage,
          skills,
          ...(stage === 'unit-comment-block' && input.memory ? { memory: input.memory } : {}),
        });
        const parsed = legacyAnalysisReportSchema.parse(result.report);
        if (
          parsed.review.is_error ||
          !parsed.review.summary.trim() ||
          !gradeSchema.safeParse(parsed.review.grade).success
        )
          throw new Error('Invalid review result');
        successfulCalls += 1;
        return { review: parsed.review, truncated: result.truncated };
      } catch (error) {
        if (error instanceof Error && ['worker_draining', 'job_lease_lost'].includes(error.message))
          throw error;
        const { code, retryable } = reviewFailure(error);
        if (retryable && attempt === 0 && coverage.modelCalls < input.maxModelCalls - reservedCalls)
          continue;
        limitations.push(
          `${files.join(', ') || '전체 report'}: ${stage} 모델 호출 또는 응답 검증 실패 [${code}]`,
        );
        return null;
      }
    }
    return null;
  };

  for (const file of input.allFiles) {
    const limitationStart = limitations.length;
    await publishProgress('unit-comment-block', file.path);
    const selected = input.files.some((candidate) => candidate.id === file.id);
    const planned = windows.filter((window) => window.fileId === file.id);
    let completed = 0;
    let attempted = 0;
    if (selected && !planned.length)
      limitations.push(`${file.path}: 분석 가능한 변경 line이 없습니다.`);
    for (const window of planned) {
      const result = await call('unit-comment-block', formatReviewWindow(window), [file.path]);
      if (!result) continue;
      attempted += 1;
      let valid = !result.truncated;
      if (
        result.review.grade === 'critical' &&
        !result.review.file_comments.some((comment) => comment.priority === 'P3')
      ) {
        valid = false;
        limitations.push(`${file.path}: Critical grade와 unit priority가 일치하지 않습니다.`);
      }
      if (result.truncated) limitations.push(`${file.path}: 잘린 unit-comment-block 응답`);
      if (result.review.file_comments.length > 80) {
        valid = false;
        limitations.push(`${file.path}: window당 comment 수 제한 초과`);
      }
      for (const candidate of result.review.file_comments.slice(0, 80)) {
        const end = candidate.end_line ?? candidate.line;
        if (
          candidate.file !== file.path ||
          !active.has(candidate.category) ||
          !prioritySchema.safeParse(candidate.priority).success ||
          !candidate.comment.trim() ||
          (candidate.side !== undefined && candidate.side !== window.side) ||
          !windowContainsComment(window, candidate.line, end)
        ) {
          valid = false;
          limitations.push(`${file.path}: Skill 또는 code segment와 일치하지 않는 comment 제외`);
          continue;
        }
        const comment = { ...candidate, side: window.side, end_line: end };
        const fingerprint = createHash('sha256')
          .update(
            JSON.stringify([
              comment.file,
              comment.side,
              comment.line,
              end,
              comment.category,
              comment.comment.trim(),
            ]),
          )
          .digest('hex');
        const previous = fingerprints.get(fingerprint);
        if (!previous) {
          fingerprints.set(fingerprint, comment);
          comments.push(comment);
        } else if (input.severityLevel && ranks[comment.priority]! > ranks[previous.priority]!) {
          // 같은 근거가 더 높은 priority로 다시 검증되면 P3를 중복으로 버리지 않는다.
          Object.assign(previous, comment);
        }
      }
      if (valid) {
        completed += 1;
        coverage.windowsReviewed += 1;
      }
    }
    // 모든 window의 중복을 제거한 뒤 level을 적용하고, 같은 집합으로 요약한다.
    if (input.severityLevel) {
      const retained = new Set(
        filterSeverityComments(
          comments.filter((comment) => comment.file === file.path),
          input.severityLevel,
        ),
      );
      for (let n = comments.length - 1; n >= 0; n -= 1)
        if (comments[n]!.file === file.path && !retained.has(comments[n]!)) comments.splice(n, 1);
    }
    // Praise를 제거한 동일 unit 집합으로 파일 요약과 최종 report를 만든다.
    const concerns = comments.filter(
      (comment) => comment.file === file.path && comment.priority !== 'P0',
    );
    if (concerns.length) {
      for (let n = comments.length - 1; n >= 0; n -= 1)
        if (comments[n]!.file === file.path && comments[n]!.priority === 'P0')
          comments.splice(n, 1);
    }
    const units = comments.filter((comment) => comment.file === file.path);
    let status: FileResult['status'] =
      planned.length > 0 && completed === planned.length
        ? 'reviewed'
        : attempted > 0
          ? 'partial'
          : 'not-reviewed';
    let summary = !input.model
      ? '분석 모델이 비활성화되어 AI review를 수행하지 않았습니다.'
      : !selected
        ? '분석 대상 또는 파일·byte 예산에서 제외되어 AI review를 수행하지 않았습니다.'
        : units.length
          ? units.map((unit) => unit.comment).join('\n\n')
          : attempted
            ? '처리된 window에서 추가 comment가 생성되지 않았습니다.'
            : incompleteFileSummary(limitations.slice(limitationStart));
    if (attempted > 0) {
      await publishProgress('overall-summary', file.path);
      const result = await call(
        'overall-summary',
        JSON.stringify({
          file: file.path,
          coverage: { windowsPlanned: planned.length, windowsReviewed: completed },
          unit_comment_blocks: units,
          change: { status: file.status, additions: file.additions, deletions: file.deletions },
        }),
        [file.path],
      );
      if (
        result &&
        !result.truncated &&
        result.review.file_comments.length === 0 &&
        (result.review.grade !== 'critical' || highest(units) === 'P3')
      ) {
        summary = result.review.summary;
        fileGrades.set(file.id, result.review.grade);
      } else {
        status = 'partial';
        limitations.push(`${file.path}: Overall Summary 미완료, 생성된 unit 설명을 표시합니다.`);
      }
    }
    fileResults.push({ fileId: file.id, path: file.path, status, summary });
    await publishProgress('file-review', file.path);
  }
  let summary = 'AI review를 완료하지 못했습니다. 파일별 분석 상태를 확인하세요.';
  if (successfulCalls > 0) {
    await publishProgress('total-summary', null);
    const result = await call(
      'total-summary',
      JSON.stringify({
        overall_summaries: fileResults.map((file) => ({
          ...file,
          priority: highest(comments.filter((comment) => comment.file === file.path)),
        })),
        limitations: [...new Set(limitations)],
      }),
      input.allFiles.map((file) => file.path),
    );
    if (
      result &&
      !result.truncated &&
      result.review.file_comments.length === 0 &&
      (result.review.grade !== 'critical' || highest(comments) === 'P3')
    )
      summary = result.review.summary;
    else {
      summary = fileResults.map((file) => `${file.path}: ${file.summary}`).join('\n\n');
      limitations.push('Total Summary 미완료, 파일별 요약을 표시합니다.');
    }
  }
  if (!input.model) limitations.push('model review가 비활성화되어 deterministic context만 생성');
  const priority = highest(comments);
  const grade =
    priority === 'P3'
      ? 'critical'
      : priority === 'P2'
        ? 'adequate'
        : worstGrade([...fileGrades.values()]);
  return {
    legacy: legacyAnalysisReportSchema.parse({
      schema_version: 1,
      staged_files: input.allFiles.map((file) => file.path),
      duration_ms: 0,
      exit_code: priority === 'P3' ? 1 : 0,
      lint_findings: [],
      review: {
        summary,
        grade,
        blocking: priority === 'P3',
        is_error: false,
        file_comments: comments,
        per_file_summaries: fileResults.map((file) => ({
          file: file.path,
          summary: file.summary,
          priority: highest(comments.filter((comment) => comment.file === file.path)) ?? 'P1',
          grade: comments.some((comment) => comment.file === file.path && comment.priority === 'P3')
            ? 'critical'
            : (fileGrades.get(file.fileId) ?? 'adequate'),
          blocking: comments.some(
            (comment) => comment.file === file.path && comment.priority === 'P3',
          ),
        })),
      },
    }),
    files: fileResults,
    reviewStatus: !input.model
      ? 'unavailable'
      : successfulCalls === 0 && coverage.modelCalls > 0
        ? 'failed'
        : 'model',
    limitations: [...new Set(limitations)],
    coverage,
    windows,
  };
}

function highest(comments: Comment[]) {
  return comments.reduce<string | null>(
    (priority, comment) =>
      priority === null || ranks[comment.priority]! > ranks[priority]!
        ? comment.priority
        : priority,
    null,
  );
}

function planReviewWindows(files: AnalysisFile[], maxModelCalls: number): ReviewWindow[] {
  let windows: ReviewWindow[] = [];
  for (const coreLines of [80, 160, 320, 500]) {
    windows = files.flatMap((file) => buildReviewWindows(file, { coreLines }));
    const summaries = new Set(windows.map((window) => window.fileId)).size + 1;
    if (windows.length + summaries <= maxModelCalls) break;
  }
  return windows;
}
function worstGrade(grades: string[]) {
  const ordered = ['critical', 'insufficient', 'adequate', 'proficient', 'exceptional'];
  return ordered.find((grade) => grades.includes(grade)) ?? 'adequate';
}
