import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ReviewReportPanel } from './ReviewReportPanel.tsx';
import type { WorkspaceData } from './api.ts';

it('shows summary comment cards immediately and keeps duplicate rollups out of the overview', () => {
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
  expect(html).not.toContain('class="report-overview"');
  expect(html.split('Unique file summary')).toHaveLength(2);
  expect(html).toContain('aria-label="검토 의견"');
  expect(html).toContain('Validate input');
  expect(html).toContain('Unexpected access');
  expect(html).toContain('Validate before use');
  expect(html).toContain('변경 코드 · line 10');
  expect(html).toContain('6분 57초');
  expect(html).toContain('<details class="report-limitations">');
  expect(html).toContain('<details class="report-file-overview">');
  expect(html).not.toContain('<script>');
  expect(html).toContain('<code>&lt;script&gt;</code>');
});
