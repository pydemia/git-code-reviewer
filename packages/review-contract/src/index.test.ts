import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeLegacyReport, reviewReportSchema } from './index.js';

describe('Commit Defender v1 compatibility', () => {
  it('preserves grade, summaries, priority, category, source, and rule semantics', () => {
    const fileId = randomUUID();
    const report = normalizeLegacyReport(
      {
        schema_version: 1,
        staged_files: ['src/session.ts'],
        duration_ms: 42,
        exit_code: 1,
        lint_findings: [
          {
            file: 'src/session.ts',
            line: 4,
            col: 1,
            rule: 'S101',
            message: 'Unsafe assertion',
            severity: 'error',
          },
        ],
        review: {
          summary: '세션 처리를 보완해야 합니다.',
          blocking: true,
          is_error: false,
          grade: 'insufficient',
          file_comments: [
            {
              file: 'src/session.ts',
              line: 7,
              category: 'testing',
              priority: 'P2',
              comment: '동시성 test를 추가하세요.',
            },
          ],
          per_file_summaries: [
            {
              file: 'src/session.ts',
              summary: '동시성 검토 필요',
              priority: 'P3',
              blocking: true,
              grade: 'insufficient',
            },
          ],
        },
      },
      {
        analysisRevisionId: randomUUID(),
        snapshotId: randomUUID(),
        files: [{ id: fileId, path: 'src/session.ts', headLines: new Set([4, 7]) }],
        coverage: {
          filesChanged: 1,
          filesExamined: 1,
          objectsExamined: 0,
          relationsExamined: 0,
          truncated: false,
          limitations: [],
        },
        emptyImpact: {
          summary: '',
          affectedAreas: [],
          coverage: {
            filesChanged: 1,
            filesExamined: 1,
            objectsExamined: 0,
            relationsExamined: 0,
            truncated: false,
            limitations: [],
          },
          confidence: 'low',
        },
      },
    );
    expect(reviewReportSchema.parse(report).grade).toBe('insufficient');
    expect(report.perFileSummaries[0]).toMatchObject({ fileId, priority: 'P3' });
    expect(report.findings.map((finding) => finding.priority)).toEqual(['P3', 'P2']);
    expect(report.findings[0]?.source).toMatchObject({ kind: 'analyzer', rule: 'S101' });
    expect(report.hasCriticalFindings).toBe(true);
  });

  it('downgrades an unverified P3 instead of trusting text alone', () => {
    const report = normalizeLegacyReport(
      {
        schema_version: 1,
        staged_files: ['src/session.ts'],
        duration_ms: 1,
        exit_code: 1,
        lint_findings: [],
        review: {
          summary: '검토',
          blocking: true,
          is_error: false,
          grade: 'critical',
          file_comments: [
            {
              file: 'src/session.ts',
              line: 99,
              category: 'security',
              priority: 'P3',
              comment: '근거 없는 치명 주장',
            },
          ],
        },
      },
      {
        analysisRevisionId: randomUUID(),
        snapshotId: randomUUID(),
        files: [{ id: randomUUID(), path: 'src/session.ts', headLines: new Set([1]) }],
        coverage: {
          filesChanged: 1,
          filesExamined: 1,
          objectsExamined: 0,
          relationsExamined: 0,
          truncated: false,
          limitations: [],
        },
        emptyImpact: {
          summary: '',
          affectedAreas: [],
          coverage: {
            filesChanged: 1,
            filesExamined: 1,
            objectsExamined: 0,
            relationsExamined: 0,
            truncated: false,
            limitations: [],
          },
          confidence: 'low',
        },
      },
    );
    expect(report.findings[0]?.priority).toBe('P2');
    expect(report.findings[0]?.verification.status).toBe('limited');
    expect(report.hasCriticalFindings).toBe(false);
  });
});
