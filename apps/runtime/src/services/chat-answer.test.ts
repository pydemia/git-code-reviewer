import { randomUUID } from 'node:crypto';
import type { ReviewReport } from '@gcr/review-contract';
import { chatCitationSchema } from '@gcr/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  answerReviewQuestion,
  buildChatReviewContext,
  parseChatReviewAnswer,
} from './chat-answer.js';
import type { ChatModel } from './chat-model.js';

const files = [
  { id: randomUUID(), path: 'src/storage.ts' },
  { id: randomUUID(), path: 'k8s/deployment.yaml' },
];
const coverage = {
  filesChanged: 2,
  filesExamined: 2,
  objectsExamined: 0,
  relationsExamined: 0,
  truncated: true,
  limitations: ['일부 파일 미검토'],
};
function reportFixture(): ReviewReport {
  return {
    schemaVersion: 1,
    compatibility: {
      commitDefenderSchemaVersion: 1,
      baselineRevision: '47dabfea718729b0ccc685ae173857476040d6ea',
    },
    analysisRevisionId: randomUUID(),
    snapshotId: randomUUID(),
    summary: '저장 경로와 배포 설정 변경',
    grade: 'adequate',
    hasCriticalFindings: false,
    coverage,
    versions: { model: 'synthetic' },
    durationMs: 1,
    impact: {
      summary: '파일 보존과 Pod 기동에 영향',
      affectedAreas: [],
      coverage,
      confidence: 'high',
    },
    perFileSummaries: files.map((file) => ({
      fileId: file.id,
      summary: `${file.path} 요약`,
      priority: 'P2',
      grade: 'adequate',
    })),
    findings: files.map((file, index) => {
      const anchor = {
        id: randomUUID(),
        fileId: file.id,
        side: index ? ('mergeBase' as const) : ('head' as const),
        startLine: index ? 50 : 10,
        endLine: index ? 57 : 14,
        artifactType: 'snapshot-diff',
      };
      return {
        id: randomUUID(),
        source: { kind: 'model', producer: 'synthetic' },
        title: index ? 'PVC 설정 확인' : '저장 경로 확인',
        problem: '확인할 문제',
        impact: '영향',
        recommendation: '수정 제안',
        priority: 'P2',
        category: 'setting',
        confidence: 'high',
        verification: { status: 'verified', checks: [], originalPriority: 'P2' },
        anchor,
        evidence: [anchor],
        fingerprint: file.id,
      };
    }),
  };
}

describe('grounded multi-location review chat', () => {
  it('keeps other files in context even when one finding is selected and returns only cited locations', async () => {
    const report = reportFixture();
    const generate = vi.fn<ChatModel['generate']>(async () =>
      JSON.stringify({
        content: '## Merge 전 확인\n- **저장 경로**를 확인하세요.\n- PVC도 확인하세요.',
        citationIds: ['E1', 'unknown', 'E2', 'E1'],
      }),
    );
    const answer = await answerReviewQuestion({
      chatModel: { name: 'synthetic', generate },
      report,
      files,
      question: '전체 PR merge 시 문제는?',
      scope: { findingId: report.findings[0]!.id },
      history: [{ role: 'user', content: '이전 질문' }],
      sessionId: 'session',
      reasoningEffort: 'high',
    });
    expect(answer.citations).toHaveLength(2);
    expect(answer.citations[0]).toMatchObject({
      fileId: files[0]!.id,
      line: 10,
      endLine: 14,
      side: 'head',
      label: 'src/storage.ts · L10–14 · 변경 코드',
    });
    expect(answer.citations[1]).toMatchObject({
      fileId: files[1]!.id,
      line: 50,
      endLine: 57,
      side: 'mergeBase',
    });
    answer.citations.forEach((citation) =>
      expect(chatCitationSchema.safeParse(citation).success).toBe(true),
    );
    const request = generate.mock.calls[0]![0] as unknown as {
      messages: Array<{ content: string }>;
      reasoningEffort: string;
    };
    expect(request.reasoningEffort).toBe('high');
    const context = JSON.parse(request.messages[1]!.content);
    expect(context.findings).toHaveLength(2);
    expect(context.files).toHaveLength(2);
    expect(context.coverage.limitations).toEqual(coverage.limitations);
    expect(context.analysisRevisionId).toBe(report.analysisRevisionId);
    expect(context.citationCatalog).toHaveLength(2);
    expect(request.messages.at(-1)!.content).toBe('전체 PR merge 시 문제는?');
  });

  it('does not attach the selected finding when the model cites nothing', () => {
    const { citations } = buildChatReviewContext(reportFixture(), files, {});
    expect(
      parseChatReviewAnswer('{"content":"범위가 부족합니다.","citationIds":[]}', citations)
        .citations,
    ).toEqual([]);
    expect(parseChatReviewAnswer('**기존 text-only 응답**', citations)).toEqual({
      content: '**기존 text-only 응답**',
      citations: [],
    });
    expect(parseChatReviewAnswer('{"content":"답변","citationIds":"invalid"}', citations)).toEqual({
      content: '답변',
      citations: [],
    });
  });

  it('handles fenced JSON and refuses invented IDs and model-supplied URLs/lines', () => {
    const { citations } = buildChatReviewContext(reportFixture(), files, {});
    const answer = parseChatReviewAnswer(
      '```json\n{"content":"검토","citationIds":["E2","__proto__","https://evil.example"],"citations":[{"line":999}]}\n```',
      citations,
    );
    expect(answer.citations).toEqual([citations.get('E2')]);
    expect(answer.content).toBe('검토');
  });

  it('includes anchors without evidence arrays and keeps multiple ranges on the same file distinct', () => {
    const report = reportFixture();
    const finding = report.findings[0]!;
    finding.evidence = [{ ...finding.anchor, id: randomUUID(), startLine: 30, endLine: 35 }];
    report.findings[1]!.evidence = [];
    const { citations } = buildChatReviewContext(report, files, {});
    expect([...citations.values()].map((citation) => citation.line)).toEqual([10, 30, 50]);
  });

  it('uses file-level links without inventing line 1 and excludes unknown files or non-diff evidence', () => {
    const report = reportFixture();
    const finding = report.findings[0]!;
    delete finding.anchor.startLine;
    delete finding.anchor.endLine;
    finding.evidence = [
      { ...finding.anchor, id: randomUUID(), fileId: randomUUID() },
      { ...finding.anchor, id: randomUUID(), artifactType: 'history' },
    ];
    const { citations } = buildChatReviewContext(report, files, {});
    expect(citations.size).toBe(2);
    expect(citations.get('E1')!.label).toContain('파일 전체');
    expect(citations.get('E1')!.line).toBeUndefined();
  });

  it('prioritizes selection without dropping coverage and explicitly reports context omissions', () => {
    const report = reportFixture();
    report.findings = Array.from({ length: 120 }, (_, i) => ({
      ...report.findings[i % 2]!,
      id: randomUUID(),
    }));
    const selected = report.findings.at(-1)!;
    const { context } = buildChatReviewContext(report, files, { findingId: selected.id });
    expect(context.findings[0]!.id).toBe(selected.id);
    expect(context.contextLimits.omittedFindings).toBe(40);
    expect(context.coverage).toEqual(coverage);
    const none = buildChatReviewContext({ ...report, findings: [] }, files, {});
    expect(none.citations.size).toBe(0);
  });

  it('does not mutate the immutable report and bounds the citation list', () => {
    const report = reportFixture();
    const original = JSON.stringify(report);
    const { citations } = buildChatReviewContext(report, files, {});
    expect(JSON.stringify(report)).toBe(original);
    const many = new Map(Array.from({ length: 40 }, (_, i) => [`E${i}`, citations.get('E1')!]));
    expect(
      parseChatReviewAnswer(
        JSON.stringify({ content: '답변', citationIds: [...many.keys()] }),
        many,
      ).citations,
    ).toHaveLength(24);
  });
});
