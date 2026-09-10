import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { reviewSeverityLevelSchema, type ReviewSeverityLevel } from '@gcr/contracts';
import { analyzeSnapshot, modelReviewFromText, type ReviewModel } from './index.js';
import { loadBuiltInReviewSkills } from './skills.js';
import { filterSeverityComments } from './review-severity.js';

const priorities = ['P0', 'P1', 'P1', 'P1', 'P2', 'P3'];
const expected: Record<ReviewSeverityLevel, string[]> = {
  lean: ['P3'],
  generous: ['P2', 'P3'],
  moderate: ['P1', 'P1', 'P2', 'P3'],
  rigorous: ['P1', 'P1', 'P1', 'P2', 'P3'],
  severe: priorities,
};

describe('Commit Defender Severity Level', () => {
  it.each(reviewSeverityLevelSchema.options)(
    'filters %s without upgrading or suppressing P3',
    (level) => {
      const comments = ['one.ts', 'two.ts'].flatMap((file) =>
        priorities.map((priority) => ({ file, priority })),
      );
      const filtered = filterSeverityComments(comments, level);
      for (const file of ['one.ts', 'two.ts'])
        expect(
          filtered.filter((comment) => comment.file === file).map((comment) => comment.priority),
        ).toEqual(expected[level]);
    },
  );

  it.each(reviewSeverityLevelSchema.options)(
    'applies %s across windows before both summary stages',
    async (severityLevel) => {
      const calls: Array<{ stage: string; data: string; instructions: string }> = [];
      const model: ReviewModel = {
        profile: 'synthetic',
        async review(data, files, instructions, context) {
          const stage = context!.stage;
          calls.push({ stage, data, instructions: instructions ?? '' });
          const core = Number(/must be in (\d+)/.exec(data)?.[1] ?? 1);
          return modelReviewFromText(
            JSON.stringify({
              summary: '선택한 분석 범위의 검토 결과입니다.',
              grade: stage === 'unit-comment-block' ? 'critical' : 'adequate',
              file_comments:
                stage === 'unit-comment-block'
                  ? priorities
                      .map((priority, index) => ({
                        file: files[0],
                        side: 'head',
                        line: core,
                        end_line: core,
                        category: 'correctness',
                        priority,
                        comment: `${core}:${index} 검토 근거`,
                      }))
                      .flatMap((comment) =>
                        comment.priority === 'P3'
                          ? [{ ...comment, priority: 'P1' }, comment]
                          : [comment],
                      )
                  : [],
            }),
            files,
          );
        },
      };
      const patch =
        '@@ -0,0 +1,180 @@\n' +
        Array.from({ length: 180 }, (_, n) => `+const v${n} = ${n};`).join('\n');
      const output = await analyzeSnapshot({
        analysisId: randomUUID(),
        snapshotId: randomUUID(),
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        patch,
        files: [
          {
            id: randomUUID(),
            path: 'one.ts',
            previousPath: null,
            status: 'added',
            additions: 180,
            deletions: 0,
            patch,
          },
        ],
        fixtureMode: false,
        skills: { bundle: loadBuiltInReviewSkills(), versionId: null, version: null },
        severityLevel,
        model,
        prompt: { version: 1, hash: 'c'.repeat(64), instructions: '' },
      });
      expect(calls.filter((call) => call.stage === 'unit-comment-block').length).toBeGreaterThan(1);
      expect(
        calls.every((call) => call.instructions.includes(`Severity Level): ${severityLevel}`)),
      ).toBe(true);
      const units = JSON.parse(calls.find((call) => call.stage === 'overall-summary')!.data)
        .unit_comment_blocks as Array<{ priority: string }>;
      expect(units.filter((unit) => unit.priority === 'P3').length).toBeGreaterThan(1);
      expect(units.some((unit) => unit.priority === 'P0')).toBe(false); // 같은 파일의 Praise/concern 모순 제거
      if (severityLevel === 'moderate')
        expect(units.filter((unit) => unit.priority === 'P1')).toHaveLength(2);
      if (severityLevel === 'lean')
        expect(units.every((unit) => unit.priority === 'P3')).toBe(true);
      expect(output.report.analysis?.units).toHaveLength(units.length);
      expect(output.report.versions.severity).toBe(severityLevel);
      expect(output.state).toBe('completed'); // 의도적인 severity 필터는 coverage 실패가 아니다.
      expect(output.report.analysis?.status).toBe('blocked');
    },
  );
});
