import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ReviewDiff } from './ReviewDiff.tsx';
import type { WorkspaceData } from './api.ts';

it.each(['split', 'unified'] as const)(
  'renders comments on both sides without requiring selection (%s)',
  (mode) => {
    const findings = [
      {
        id: 'old',
        anchor: { fileId: 'file', side: 'mergeBase', startLine: 1, endLine: 1 },
        title: 'Removed validation',
        problem: 'Removed validation',
        priority: 'P2',
        category: 'correctness',
      },
      {
        id: 'new',
        anchor: { fileId: 'file', side: 'head', startLine: 1, endLine: 1 },
        title: 'New input',
        problem: 'New input',
        priority: 'P2',
        category: 'security',
      },
      {
        id: 'whole',
        anchor: { fileId: 'file', side: 'head' },
        title: 'File note',
        problem: 'File note',
        priority: 'P1',
        category: 'maintenance',
      },
    ] as NonNullable<WorkspaceData['report']>['findings'];
    const html = renderToStaticMarkup(
      <ReviewDiff
        fileId="file"
        patch={'@@ -1 +1 @@\n-old\n+new'}
        mode={mode}
        target={null}
        findings={findings}
      />,
    );
    for (const finding of findings)
      expect(html.split(`data-finding-id="${finding.id}"`)).toHaveLength(2);
    expect(html).toContain('이전 코드');
    expect(html).toContain('변경 코드');
    expect(html).toContain('aria-label="이전 코드 line 1 · 검토 의견 1개"');
    expect(html).toContain('aria-label="변경 코드 line 1 · 검토 의견 1개"');
    expect(html).toContain('aria-controls="review-comment-old"');
    expect(html).toContain('id="review-comment-old"');
    expect(html).toContain('aria-controls="review-comment-new"');
    expect(html).not.toContain('aria-controls="review-comment-whole"');
  },
);
