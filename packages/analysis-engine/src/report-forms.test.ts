import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { reviewAnalysisSchema, type ReviewFinding } from '@gcr/review-contract';
import { assembleReviewAnalysis, filterContradictoryPraise } from './report-forms.js';
import { loadBuiltInReviewSkills } from './skills.js';

const skills = loadBuiltInReviewSkills();
const [fileA, fileB] = [randomUUID(), randomUUID()];
function finding(fileId: string, priority: ReviewFinding['priority'], category = 'security') {
  return {
    id: randomUUID(),
    priority,
    category,
    anchor: {
      id: randomUUID(),
      fileId,
      side: 'head',
      startLine: 12,
      endLine: 15,
      artifactType: 'snapshot-diff',
    },
  } as ReviewFinding;
}
function assemble(
  findings: ReviewFinding[],
  overrides: Partial<Parameters<typeof assembleReviewAnalysis>[0]> = {},
) {
  return assembleReviewAnalysis({
    findings,
    skills,
    mode: 'ai-powered',
    reviewStatus: 'model',
    incomplete: false,
    files: [
      {
        fileId: fileA!,
        path: 'src/a.ts',
        status: 'reviewed',
        summary: '인증 우회 조건을 제거해야 합니다.',
      },
      { fileId: fileB!, path: 'src/b.ts', status: 'reviewed', summary: '추가 지적이 없습니다.' },
    ],
    coverage: { modelCalls: 4, windowsPlanned: 2, windowsReviewed: 2 },
    ...overrides,
  });
}

describe('Commit Defender report forms', () => {
  it('rejects duplicate segments and missing or cross-file summary references', () => {
    const result = assemble([finding(fileA!, 'P2'), finding(fileB!, 'P1')]);
    const duplicate = structuredClone(result);
    duplicate.units[1]!.segment.id = duplicate.units[0]!.segment.id;
    expect(() => reviewAnalysisSchema.parse(duplicate)).toThrow('일대일');
    const missing = structuredClone(result);
    missing.files[0]!.unitIds = [];
    expect(() => reviewAnalysisSchema.parse(missing)).toThrow('Overall Summary');
    const crossed = structuredClone(result);
    [crossed.files[0]!.unitIds, crossed.files[1]!.unitIds] = [
      crossed.files[1]!.unitIds,
      crossed.files[0]!.unitIds,
    ];
    expect(() => reviewAnalysisSchema.parse(crossed)).toThrow('파일이 다릅니다');
  });
  it('gives each unit one segment and groups units and representative priorities per file', () => {
    const comments = [
      finding(fileA!, 'P2'),
      finding(fileA!, 'P3'),
      finding(fileB!, 'P1', 'maintenance'),
    ];
    const result = assemble(comments);
    expect(result.status).toBe('blocked');
    expect(result.priority).toBe('P3');
    expect(result.units).toHaveLength(3);
    expect(new Set(result.units.map((unit) => unit.segment.id)).size).toBe(3);
    expect(result.units[0]!.segment).toMatchObject({ fileId: fileA, startLine: 12, endLine: 15 });
    expect(result.files[0]).toMatchObject({
      priority: 'P3',
      unitIds: comments.slice(0, 2).map((comment) => comment.id),
    });
    expect(result.files[1]!.priority).toBe('P1');
    expect(result.skills.bundleHash).toBe(skills.hash);
    expect(JSON.stringify(result.skills)).not.toContain('instructions');
  });
  it('does not call zero findings Praise or fabricate file-level line numbers', () => {
    const result = assemble([]);
    expect(result.status).toBe('pass');
    expect(result.priority).toBeNull();
    expect(result.files.every((file) => file.priority === null)).toBe(true);
    const fileLevel = finding(fileA!, 'P2');
    delete fileLevel.anchor.startLine;
    delete fileLevel.anchor.endLine;
    expect(assemble([fileLevel]).units[0]!.segment.startLine).toBeUndefined();
  });
  it('does not mix Praise with a concern in the same file', () => {
    const comments = [finding(fileA!, 'P0'), finding(fileA!, 'P1'), finding(fileB!, 'P0')];
    expect(filterContradictoryPraise(comments)).toEqual(comments.slice(1));
    expect(assemble(comments).units).toHaveLength(2);
  });
  it('never presents failed, skipped, disabled or demonstration analysis as PASS', () => {
    expect(assemble([], { incomplete: true }).status).toBe('incomplete');
    expect(
      assemble([], {
        files: [{ fileId: fileA!, path: 'a.ts', status: 'not-reviewed', summary: '생략' }],
      }).status,
    ).toBe('incomplete');
    expect(assemble([], { reviewStatus: 'failed' }).status).toBe('failed');
    expect(assemble([], { reviewStatus: 'unavailable', mode: 'disabled' }).status).toBe(
      'unavailable',
    );
    expect(
      assemble([finding(fileA!, 'P3')], { reviewStatus: 'fixture', mode: 'fixture' }).status,
    ).toBe('demo');
    expect(assemble([finding(fileA!, 'P3')], { incomplete: true }).status).toBe('blocked');
  });
  it('requires a configured perspective rather than silently relabeling a comment', () => {
    expect(() => assemble([finding(fileA!, 'P2', 'unknown-skill')])).toThrow('활성 perspective');
  });
});
