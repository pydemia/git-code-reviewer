import type { AnalysisProgress, ReviewMemoryProjection, ReviewSeverityLevel } from '@gcr/contracts';
import {
  gradeSchema,
  legacyAnalysisReportSchema,
  prioritySchema,
  type LegacyAnalysisReport,
  type ReviewSkillBundle,
} from '@gcr/review-contract';
import type { AnalysisFile, ReviewModel } from './index.js';
import type { SkillReviewOutput } from './skill-review.js';
import { buildImpactPlan, type ImpactTask, type ReviewTarget } from './impact-plan.js';
import type { ReviewTaskStore, TaskResult } from './review-task-store.js';
import { composeSkillReviewPrompt } from './review-prompt.js';
import { windowContainsComment } from './review-windows.js';
import { mapConcurrent } from './concurrency.js';
import { filterSeverityComments, severityInstructions } from './review-severity.js';
import { reviewFailure } from './review-failures.js';

type Comment = LegacyAnalysisReport['review']['file_comments'][number];
export type ImpactReviewOptions = {
  store?: ReviewTaskStore;
  identity: unknown;
  maxInputBytes?: number;
  maxFilesPerGroup?: number;
};

function validated(result: TaskResult, task: ImpactTask, skills: ReviewSkillBundle): Comment[] {
  const review = legacyAnalysisReportSchema.parse(result.report).review;
  if (
    result.truncated ||
    review.is_error ||
    !review.summary.trim() ||
    !gradeSchema.safeParse(review.grade).success
  )
    throw Error('Invalid review result');
  const expected = new Set(task.targets.map((target) => target.id));
  const received = review.reviewed_targets;
  if (
    !received ||
    received.length !== expected.size ||
    new Set(received).size !== received.length ||
    received.some((id) => !expected.has(id))
  )
    throw Error('review_target_coverage_missing');
  const perspectives = new Set(
    skills.skills
      .filter((skill) => skill.enabled && skill.kind === 'perspective')
      .map((skill) => skill.name),
  );
  if (review.file_comments.length > 80) throw Error('review_group_output_limit');
  for (const comment of review.file_comments) {
    if (
      !prioritySchema.safeParse(comment.priority).success ||
      !perspectives.has(comment.category) ||
      !comment.comment.trim() ||
      !task.targets.some((target) => contains(target, comment))
    )
      throw Error('review_group_anchor_invalid');
  }
  if (
    review.grade === 'critical' &&
    !review.file_comments.some((comment) => comment.priority === 'P3')
  )
    throw Error('review_group_grade_invalid');
  return review.file_comments;
}
function contains(target: ReviewTarget, comment: Comment) {
  if (target.path !== comment.file) return false;
  if (target.window)
    return (
      comment.side === target.window.side &&
      windowContainsComment(target.window, comment.line, comment.end_line ?? comment.line)
    );
  return comment.line === 0 && (comment.end_line ?? 0) === 0 && comment.side === 'head';
}
const priority = (comments: Comment[]) =>
  comments.reduce<string | null>(
    (max, item) => (!max || item.priority > max ? item.priority : max),
    null,
  );

export async function runImpactReview(input: {
  allFiles: AnalysisFile[];
  files: AnalysisFile[];
  exclusionReasons: Map<string, string>;
  skills: ReviewSkillBundle;
  model?: ReviewModel;
  instructions?: string;
  severityLevel?: ReviewSeverityLevel;
  memory?: ReviewMemoryProjection[];
  maxModelCalls: number;
  concurrency: number;
  options: ImpactReviewOptions;
  onProgress?: (stage: string, detail: AnalysisProgress) => Promise<void>;
}): Promise<SkillReviewOutput> {
  const instructions = input.severityLevel
    ? severityInstructions(input.severityLevel, input.instructions)
    : input.instructions;
  const baseContext = {
    stage: 'unit-comment-block' as const,
    skills: input.skills,
    ...(input.memory ? { memory: input.memory } : {}),
  };
  // Conservative byte-based token upper estimate, including prompt, source-context
  // and response reserves. No provider context size is inferred from a model name.
  const fixedBytes = Buffer.byteLength(composeSkillReviewPrompt(baseContext, instructions));
  const bodyBudget = Math.min(
    input.options.maxInputBytes ?? 64_000,
    128_000 - fixedBytes - 16_384 - 16_000 - 4096,
  );
  if (bodyBudget < 2048) throw Error('review_prompt_budget_exhausted');
  const plan = buildImpactPlan({
    files: input.allFiles,
    eligibleIds: new Set(input.files.map((file) => file.id)),
    exclusionReasons: input.exclusionReasons,
    identity: {
      pin: input.options.identity,
      skills: input.skills.hash,
      instructions,
      memory: input.memory,
      model: input.model?.profile,
    },
    maxInputBytes: bodyBudget,
    ...(input.options.maxFilesPerGroup ? { maxFilesPerGroup: input.options.maxFilesPerGroup } : {}),
  });
  const cache = (await input.options.store?.initialize(plan)) ?? new Map<string, TaskResult>();
  const completed = new Map<string, { result: TaskResult; comments: Comment[] }>();
  const failures = new Map<string, string>();
  let blockedByAuth = false;
  let exhaustedBudget: string | null = null;
  let modelCalls = 0,
    progressQueue = Promise.resolve();
  const publish = (stage: string) => {
    progressQueue = progressQueue.then(() => {
      const reviewed = plan.files.filter(
        (file) =>
          file.disposition === 'required' &&
          file.tasks.length &&
          file.tasks.every((id) => completed.has(id)),
      ).length;
      const excluded = plan.files.filter((file) => file.disposition === 'excluded').length;
      return input.onProgress?.(stage, {
        filesProcessed: reviewed + excluded,
        filesTotal: plan.files.length,
        filesReviewed: reviewed,
        filesSkipped: excluded,
        currentFile: null,
        tasksTotal: plan.tasks.length,
        tasksCompleted: completed.size,
        filesExcluded: excluded,
        filesPending: plan.files.length - reviewed - excluded,
      });
    });
    return progressQueue;
  };
  // Validate cached output again against this exact plan, including every anchor.
  for (const task of plan.tasks) {
    const result = cache.get(task.id);
    if (result) completed.set(task.id, { result, comments: validated(result, task, input.skills) });
  }
  await publish('impact-planning');
  await mapConcurrent(plan.tasks, input.concurrency, async (task) => {
    if (completed.has(task.id)) return;
    if (task.blocked) {
      failures.set(task.id, 'REVIEW_INPUT_REQUIRES_SPLIT');
      await input.options.store?.fail(task, {
        state: 'blocked',
        code: 'REVIEW_INPUT_REQUIRES_SPLIT',
      });
      return;
    }
    if (exhaustedBudget) {
      failures.set(task.id, exhaustedBudget);
      await input.options.store?.start(task);
      await input.options.store?.fail(task, { state: 'budget-wait', code: exhaustedBudget });
      return;
    }
    if (blockedByAuth || !input.model) {
      failures.set(task.id, blockedByAuth ? 'MODEL_AUTH_UNAVAILABLE' : 'MODEL_UNAVAILABLE');
      return;
    }
    const context = {
      ...baseContext,
      group: {
        taskId: task.id,
        targetIds: task.targets.map((target) => target.id),
        kind: task.kind,
        sourceWindows: task.targets.flatMap((target) =>
          target.window ? [{ path: target.path, startLine: target.window.startLine }] : [],
        ),
      },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (modelCalls >= input.maxModelCalls) {
        await input.options.store?.start(task);
        await input.options.store?.fail(task, {
          state: 'budget-wait',
          code: 'MODEL_CALL_BUDGET_EXHAUSTED',
        });
        failures.set(task.id, 'MODEL_CALL_BUDGET_EXHAUSTED');
        break;
      }
      modelCalls++;
      await input.options.store?.start(task);
      try {
        const result = await input.model.review(
          task.body,
          [...new Set(task.targets.map((target) => target.path))],
          instructions,
          context,
        );
        const comments = validated(result, task, input.skills);
        await input.options.store?.complete(task, result);
        completed.set(task.id, { result, comments });
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (['worker_draining', 'job_lease_lost'].includes(message)) throw error;
        if (
          message === 'model_capacity_wait' &&
          error instanceof Error &&
          'resumeAfter' in error &&
          error.resumeAfter instanceof Date
        ) {
          await input.options.store?.fail(task, {
            state: 'retry-wait',
            code: 'MODEL_CAPACITY_WAIT',
            retryAt: error.resumeAfter,
          });
          throw error;
        }
        const reason = message.startsWith('review_')
          ? { code: message.toUpperCase(), retryable: true }
          : reviewFailure(error);
        await input.options.store?.fail(task, {
          state: ['MODEL_CALL_BUDGET_EXHAUSTED', 'MODEL_TIME_BUDGET_EXHAUSTED'].includes(
            reason.code,
          )
            ? 'budget-wait'
            : 'failed',
          code: reason.code,
        });
        failures.set(task.id, reason.code);
        if (['MODEL_CALL_BUDGET_EXHAUSTED', 'MODEL_TIME_BUDGET_EXHAUSTED'].includes(reason.code))
          exhaustedBudget = reason.code;
        if (reason.code === 'MODEL_AUTH_UNAVAILABLE') blockedByAuth = true;
        if (!reason.retryable || attempt === 1) break;
        if (reason.code !== 'MODEL_OUTPUT_INVALID' && !message.startsWith('review_'))
          await new Promise((resolve) =>
            setTimeout(resolve, 1000 + Math.floor(Math.random() * 1000)),
          );
      }
    }
    if (completed.has(task.id)) failures.delete(task.id);
    await publish('impact-review');
  });
  const seen = new Map<string, Comment>();
  for (const { comments } of completed.values())
    for (const comment of comments) {
      const key = JSON.stringify([
        comment.file,
        comment.side,
        comment.line,
        comment.end_line ?? comment.line,
        comment.category,
        comment.comment.trim(),
      ]);
      if (!seen.has(key) || seen.get(key)!.priority < comment.priority)
        seen.set(key, { ...comment, end_line: comment.end_line ?? comment.line });
    }
  let comments = [...seen.values()];
  if (input.severityLevel) comments = filterSeverityComments(comments, input.severityLevel);
  const concerns = new Set(
    comments.filter((comment) => comment.priority !== 'P0').map((comment) => comment.file),
  );
  comments = comments.filter((comment) => comment.priority !== 'P0' || !concerns.has(comment.file));
  const files = plan.files.map((file) => {
    const accepted = comments.filter((comment) => comment.file === file.path);
    const finished =
      file.disposition === 'required' &&
      file.tasks.length > 0 &&
      file.tasks.every((id) => completed.has(id));
    const some = file.tasks.some((id) => completed.has(id));
    return {
      fileId: file.id,
      path: file.path,
      status: finished
        ? ('reviewed' as const)
        : some
          ? ('partial' as const)
          : ('not-reviewed' as const),
      summary:
        file.disposition === 'excluded'
          ? `제외 정책: ${file.reason}`
          : accepted.length
            ? accepted.map((comment) => comment.comment).join('\n\n')
            : finished
              ? '제공된 변경 범위의 검토를 완료했으며 추가 의견은 없습니다.'
              : '아직 검토하지 못한 영역이 있습니다. 검토가 완료됐거나 문제가 없다는 판정이 아닙니다.',
    };
  });
  // File summaries are derived from accepted findings. No per-file model call.
  // A bounded hierarchy reduces only accepted review units; partial coverage stays explicit.
  let summaries = files
    .filter((file) => comments.some((comment) => comment.file === file.path))
    .map((file) =>
      JSON.stringify(
        comments
          .filter((comment) => comment.file === file.path)
          .map((comment) => ({
            file: comment.file,
            priority: comment.priority,
            comment: comment.comment,
          })),
      ),
    );
  if (!summaries.length && completed.size)
    summaries = [
      JSON.stringify({
        acceptedFindings: 0,
        completedGroups: completed.size,
        totalGroups: plan.tasks.length,
      }),
    ];
  let summary = `전체 ${plan.files.length}개 파일 중 ${files.filter((file) => file.status === 'reviewed').length}개 파일의 검토를 완료했습니다. 검토 의견 ${comments.length}건입니다.`;
  const limitations = [...new Set([...failures.values()])].map(
    (code) => `영향 그룹 검토 미완료 [${code}]`,
  );
  if (!input.model) limitations.push('모델 비활성화로 검토를 수행하지 않았습니다.');
  let summaryComplete = false;
  while (
    input.model &&
    !blockedByAuth &&
    !exhaustedBudget &&
    summaries.length &&
    modelCalls < input.maxModelCalls
  ) {
    const batches: string[][] = [];
    let batch: string[] = [],
      bytes = 0;
    for (const item of summaries) {
      const size = Buffer.byteLength(JSON.stringify(item)) + 2;
      if (size > bodyBudget - 4096) {
        limitations.push('그룹 요약 입력 크기 제한으로 전체 요약을 완성하지 못했습니다.');
        continue;
      }
      if (batch.length && bytes + size > bodyBudget - 4096) {
        batches.push(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(item);
      bytes += size;
    }
    if (batch.length) batches.push(batch);
    if (!batches.length) break;
    const next: string[] = [];
    for (const batch of batches) {
      if (modelCalls >= input.maxModelCalls) break;
      modelCalls++;
      try {
        const result = await input.model.review(
          JSON.stringify({
            acceptedGroups: batch,
            filesTotal: files.length,
            filesReviewed: files.filter((file) => file.status === 'reviewed').length,
            limitations,
          }),
          [],
          instructions,
          { stage: 'total-summary', skills: input.skills },
        );
        const value = legacyAnalysisReportSchema.parse(result.report).review;
        if (
          result.truncated ||
          value.is_error ||
          !value.summary.trim() ||
          !gradeSchema.safeParse(value.grade).success ||
          value.file_comments.length ||
          (value.grade === 'critical' && !comments.some((comment) => comment.priority === 'P3'))
        )
          throw Error('Invalid review result');
        next.push(value.summary);
      } catch (error) {
        if (
          error instanceof Error &&
          ['worker_draining', 'job_lease_lost', 'model_capacity_wait'].includes(error.message)
        )
          throw error;
        limitations.push('전체 요약 미완료: 검증된 파일별 의견을 유지합니다.');
      }
    }
    if (next.length !== batches.length) break;
    if (next.length === 1) {
      summary = next[0]!;
      summaryComplete = true;
      break;
    }
    if (next.length >= summaries.length) break;
    summaries = next;
  }
  if (completed.size && !summaryComplete)
    limitations.push('전체 요약 미완료: 파일별 검토 결과는 보존됩니다.');
  const max = priority(comments),
    grade = max === 'P3' ? 'critical' : 'adequate';
  const legacy = legacyAnalysisReportSchema.parse({
    schema_version: 1,
    staged_files: input.allFiles.map((file) => file.path),
    duration_ms: 0,
    exit_code: max === 'P3' ? 1 : 0,
    lint_findings: [],
    review: {
      summary,
      grade,
      blocking: max === 'P3',
      is_error: false,
      file_comments: comments,
      per_file_summaries: files.map((file) => ({
        file: file.path,
        summary: file.summary,
        priority: priority(comments.filter((comment) => comment.file === file.path)) ?? 'P1',
        grade,
        blocking: comments.some(
          (comment) => comment.file === file.path && comment.priority === 'P3',
        ),
      })),
    },
  });
  const windows = plan.tasks
    .filter((task) => task.kind === 'group')
    .flatMap((task) => task.targets.flatMap((target) => (target.window ? [target.window] : [])));
  const reviewed = new Set(
    plan.tasks
      .filter((task) => task.kind === 'group' && completed.has(task.id))
      .flatMap((task) => task.targets.map((target) => target.id)),
  );
  return {
    legacy,
    files,
    reviewStatus: !input.model ? 'unavailable' : completed.size ? 'model' : 'failed',
    limitations: [...new Set(limitations)],
    coverage: {
      windowsPlanned: windows.length,
      windowsReviewed: windows.filter((window) => reviewed.has(window.id)).length,
      modelCalls,
    },
    windows,
  };
}
