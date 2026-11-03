import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ReviewCodeReference } from './ReviewCodeReference.tsx';
import { parseReviewDiff, referencedCode } from './review-diff.ts';

const lines = parseReviewDiff(
  '@@ -10,3 +10,3 @@\n context\n-oldValue();\n+newValue("<script>");\n tail\n@@ -90 +90 @@\n-other();\n+changed();',
);
it('uses the requested side and never labels missing hunk lines as contiguous code', () => {
  expect(referencedCode(lines, 'mergeBase', 11).rows.map((row) => row.content)).toEqual([
    'context',
    'oldValue();',
    'tail',
  ]);
  expect(referencedCode(lines, 'head', 11).rows.map((row) => row.content)).toEqual([
    'context',
    'newValue("<script>");',
    'tail',
  ]);
  expect(referencedCode(lines, 'head', 50)).toEqual({ rows: [], partial: true });
  expect(referencedCode(lines, 'head', 11, 90).partial).toBe(true);
  const html = renderToStaticMarkup(
    <ReviewCodeReference path="src/code.ts" lines={lines} side="head" start={11} end={90} />,
  );
  expect(html).toContain('review-code-reference-gap');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('oldValue');
});
it('bounds long references and preserves unavailable and whole-file states', () => {
  const many = parseReviewDiff(
    '@@ -1,0 +1,1000 @@\n' + Array.from({ length: 1000 }, (_, i) => `+line ${i + 1}`).join('\n'),
  );
  const excerpt = referencedCode(many, 'head', 500, 900);
  expect(excerpt.rows).toHaveLength(12);
  expect(excerpt.partial).toBe(true);
  const props = {
    path: 'src/missing.ts',
    lines: [],
    side: 'head' as const,
    href: 'https://github.example/org/repo/blob/' + 'a'.repeat(40) + '/src/missing.ts#L11',
  };
  expect(renderToStaticMarkup(<ReviewCodeReference {...props} start={11} />)).toContain(
    '저장된 diff에 이 코드 범위가 없습니다',
  );
  expect(renderToStaticMarkup(<ReviewCodeReference {...props} />)).toBe('');
});
