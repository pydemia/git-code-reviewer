import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { analyzeSnapshot, modelReviewFromText } from './index.js';
import { formatReviewMarkdown } from '@gcr/contracts';

it.each([false, true])(
  'retains model assessments through parsing and marks invalid linkage partial: %s',
  async (invalid) => {
    const file = {
      id: randomUUID(),
      path: 'cache.ts',
      previousPath: null,
      status: 'modified',
      additions: 1,
      deletions: 1,
      patch: '@@ -1 +1 @@\n-old();\n+cache[key];\n',
    };
    const raw = {
      summary: '캐시 키 검토',
      grade: 'adequate',
      file_comments: [
        {
          file: file.path,
          line: 1,
          end_line: 1,
          category: 'correctness',
          priority: 'P2',
          comment: '테넌트 격리 확인',
          criterion_assessments: [
            {
              id: invalid ? 'invented-private-id' : 'rule',
              revision: 3,
              hash: 'a'.repeat(64),
              outcome: 'uncertain',
              rationale: '<script>alert(1)</script> @someone Caller context is missing.',
              counterEvidence: {
                status: 'not-reviewed',
                explanation: '호출자 조건을 관측하지 못했습니다.',
              },
              title: 'FORGED TITLE',
              evaluator: 'verified',
            },
          ],
        },
      ],
    };
    const result = await analyzeSnapshot({
      analysisId: randomUUID(),
      snapshotId: randomUUID(),
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      patch: file.patch,
      files: [file],
      fixtureMode: false,
      model: {
        profile: 'synthetic',
        review: async () => modelReviewFromText(JSON.stringify(raw), [file.path]),
      },
      sharedCriteria: {
        pinHash: 'b'.repeat(64),
        contextHash: 'c'.repeat(64),
        criteria: [
          {
            id: 'rule',
            revision: 3,
            hash: 'a'.repeat(64),
            title: '공용 캐시 기준',
            targets: [{ path: file.path, side: 'source', hash: 'd'.repeat(64) }],
          },
        ],
      },
    });
    expect(result.report.findings).toHaveLength(1);
    const criteria = result.report.findings[0]!.criteria!;
    expect(criteria.status).toBe(invalid ? 'unavailable' : 'linked');
    expect(result.state).toBe(invalid ? 'partial' : 'completed');
    expect(JSON.stringify(result.report)).not.toContain('invented-private-id');
    expect(JSON.stringify(result.report)).not.toContain('FORGED TITLE');
    if (!invalid) {
      expect(criteria.items[0]).toMatchObject({
        title: '공용 캐시 기준',
        evaluator: 'model',
        outcome: 'uncertain',
      });
      const markdown = formatReviewMarkdown(result.report, [file]);
      expect(markdown).toContain('공용 캐시 기준');
      expect(markdown).toContain('판단 미완료');
      expect(markdown).not.toContain('<script>');
      expect(markdown).not.toContain('@someone');
    }
  },
);
