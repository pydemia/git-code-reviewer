import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ReviewReportPanel } from './ReviewReportPanel.tsx';
import type { WorkspaceData } from './api.ts';

it('separates PR and expanded file summaries from detailed FNB comments', () => {
  const coverage = {
    filesExamined: 1,
    filesChanged: 1,
    objectsExamined: 0,
    relationsExamined: 0,
    limitations: ['Coverage limitation'],
    truncated: true,
  };
  const report: NonNullable<WorkspaceData['report']> = {
    schemaVersion: 1,
    analysisRevisionId: 'analysis',
    snapshotId: 'snapshot',
    hasCriticalFindings: false,
    context: {
      repositoryId: 'repository',
      owner: 'owner',
      name: 'repo',
      pullNumber: 1,
      pullTitle: 'Review',
      snapshotId: 'snapshot',
      baseSha: 'base',
      headSha: 'head',
    },
    impact: { summary: '', affectedAreas: [], coverage, confidence: 'low' },
    summary: 'src/main.ts: Unique file summary',
    grade: 'adequate',
    durationMs: 417238,
    coverage,
    versions: { model: 'synthetic' },
    perFileSummaries: [
      { fileId: 'file', summary: 'Unique file summary', priority: 'P2', grade: 'adequate' },
    ],
    findings: [
      {
        id: 'finding',
        title: 'Validate input',
        problem: 'Do not trust `<script>` input',
        impact: 'Unexpected access',
        recommendation: 'Validate before use',
        priority: 'P2',
        category: 'security',
        anchor: { id: 'anchor', fileId: 'file', side: 'head', startLine: 10, artifactType: 'diff' },
        source: { kind: 'model', producer: 'synthetic' },
        confidence: 'high',
        verification: { status: 'verified', checks: [], originalPriority: 'P2' },
        evidence: [],
        fingerprint: 'fingerprint',
        links: [],
      },
    ],
    links: [],
  };
  const html = renderToStaticMarkup(
    <ReviewReportPanel
      report={report}
      files={[{ id: 'file', path: 'src/main.ts' }] as WorkspaceData['files']}
      section="summary"
      selectedFindingId={null}
      onFileSelect={() => {}}
      onFindingSelect={() => {}}
    />,
  );
  expect(html).toContain('PR 전체 요약');
  expect(html).toContain('별도의 PR 전체 요약이 없습니다');
  expect(html.indexOf('PR 전체 요약')).toBeLessThan(html.indexOf('파일별 검토'));
  expect(html.split('Unique file summary')).toHaveLength(2);
  expect(html).not.toContain('aria-label="검토 의견"');
  expect(html).not.toContain('Validate input');
  expect(html).toContain('6분 57초');
  expect(html).toContain('코드 품질:');
  expect(html).toContain('class="review-grade grade-positive"');
  expect(html).toContain('>양호</span>');
  expect(html).toContain('P2 Warning');
  expect(html).toContain('분석 완료 · 제한 있음');
  expect(html).toContain('검토 범위 내');
  expect(html).toContain('href="/guide#review-grades"');
  expect(html).not.toContain('Grade: adequate');
  expect(html).toContain('<details class="report-limitations">');
  expect(html).toContain('<details class="report-file-overview" open="">');

  const comments = renderToStaticMarkup(
    <ReviewReportPanel
      report={report}
      files={[]}
      section="comments"
      selectedFindingId="finding"
      onFileSelect={() => {}}
      onFindingSelect={() => {}}
    />,
  );
  expect(comments).toContain('aria-label="검토 의견"');
  expect(comments).toContain('Validate input');
  expect(comments).toContain('Unexpected access');
  expect(comments).toContain('Validate before use');
  expect(comments).toContain('변경 코드 · line 10');
  expect(comments).toContain('코드 위치 확인');
  expect(comments).not.toContain('Unique file summary');
  expect(comments).not.toContain('<script>');
  expect(comments).toContain('<code>&lt;script&gt;</code>');

  const overview = 'PR 전체의 변경 의도와 영향입니다. '.repeat(50);
  const full = renderToStaticMarkup(
    <ReviewReportPanel
      report={{ ...report, summary: overview }}
      files={[]}
      section="summary"
      selectedFindingId={null}
      onFileSelect={() => {}}
      onFindingSelect={() => {}}
    />,
  );
  expect(full).toContain(overview.trim());
  expect(full).not.toContain('<details class="report-overview"');
  expect(full.indexOf(overview.trim())).toBeLessThan(full.indexOf('파일별 검토'));

  const noIssues: typeof report = {
    ...report,
    summary: 'PR 전체 변경 설명은 유지합니다.',
    findings: [],
    analysis: {
      format: 'commit-defender-total-summary-v1',
      status: 'incomplete',
      mode: 'ai-powered',
      priority: null,
      units: [],
      files: [
        {
          fileId: 'file',
          path: 'src/main.ts',
          status: 'reviewed',
          summary:
            '검토 범위를 모두 확인했으며 추가로 지적할 사항은 없습니다. 다만 제공된 범위만 검토했습니다.',
          priority: null,
          unitIds: [],
        },
      ],
      skills: { bundleHash: 'hash', versionId: null, version: null, entries: [] },
      coverage: { filesCompleted: 1, windowsPlanned: 2, windowsReviewed: 2, modelCalls: 4 },
    },
  };
  const short = renderToStaticMarkup(
    <ReviewReportPanel
      report={noIssues}
      files={[]}
      section="summary"
      selectedFindingId={null}
      onFindingSelect={() => {}}
      onFileSelect={() => {}}
    />,
  );
  expect(short).toContain('검토한 변경 범위에서 문제가 발견되지 않았습니다.');
  expect(short).not.toContain('추가로 지적할 사항');
  expect(short).toContain('PR 전체 변경 설명은 유지합니다.');
  expect(short).toContain('Coverage limitation');
  expect(short).toContain('분석 제한 1건');

  for (const versions of [{ model: 'fixture' }, { model: 'disabled' }, { review: 'failed' }]) {
    const unavailable = renderToStaticMarkup(
      <ReviewReportPanel
        report={{ ...report, versions }}
        files={[]}
        section="summary"
        selectedFindingId={null}
        onFileSelect={() => {}}
        onFindingSelect={() => {}}
      />,
    );
    expect(unavailable).not.toContain('class="review-grade');
    expect(unavailable).not.toContain('기본 요구를 충족');
  }
});
