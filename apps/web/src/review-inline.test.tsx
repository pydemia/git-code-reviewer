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

it.each(['split', 'unified'] as const)(
  'highlights only the anchor, not every line in the range (%s)',
  (mode) => {
    const html = renderToStaticMarkup(
      <ReviewDiff
        fileId="file"
        mode={mode}
        patch={'@@ -0,0 +1,3 @@\n+one\n+two\n+three'}
        target={{ fileId: 'file', side: 'head', startLine: 1, endLine: 3, request: 1 }}
      />,
    );
    expect(html.split('review-code-row selected-line')).toHaveLength(2);
    expect(html).toContain('data-selected-line="1"');
  },
);

it('groups same-line comments and shows out-of-diff notes without fabricating an anchor', () => {
  const make = (id: string, fileId: string, startLine: number) => ({
    id,
    anchor: { fileId, side: 'head', startLine },
    title: id,
    problem: id,
    category: 'correctness',
    priority: 'P2',
  });
  const html = renderToStaticMarkup(
    <ReviewDiff
      fileId="file"
      mode="split"
      patch={'@@ -0,0 +1 @@\n+one'}
      target={null}
      findings={
        [
          make('first', 'file', 1),
          make('second', 'file', 1),
          make('missing', 'file', 99),
          make('other', 'other', 1),
        ] as NonNullable<WorkspaceData['report']>['findings']
      }
    />,
  );
  expect(html).toContain('변경 코드 line 1 · 검토 의견 2개');
  for (const id of ['first', 'second', 'missing'])
    expect(html.split(`data-finding-id="${id}"`)).toHaveLength(2);
  expect(html).not.toContain('data-finding-id="other"');
  expect(html).not.toContain('aria-label="변경 코드 line 99');
  expect(html).toContain('data-anchored="false"');
});
