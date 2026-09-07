import { expect, it } from 'vitest';
import { firstChangedLine, parseReviewDiff, splitReviewDiff } from './review-diff.ts';

it('preserves old and new line numbers across hunks without phantom trailing lines', () => {
  const lines = parseReviewDiff(
    '@@ -5,2 +7,2 @@\n-old\n+new\n same\n@@ -40 +42 @@\n-old2\n+new2\n',
  );
  expect(lines.filter((line) => line.head !== null).map((line) => line.head)).toEqual([7, 8, 42]);
  expect(lines.filter((line) => line.base !== null).map((line) => line.base)).toEqual([5, 6, 40]);
  expect(splitReviewDiff(lines)[1]).toMatchObject({
    base: { base: 5, kind: 'removed' },
    head: { head: 7, kind: 'added' },
  });
});

it('keeps deletions in unified data and uses mergeBase for deleted-file navigation', () => {
  const patch = '@@ -1,2 +0,0 @@\n-a\n-b\n\\ No newline at end of file\n';
  expect(parseReviewDiff(patch)).toHaveLength(3);
  expect(splitReviewDiff(parseReviewDiff(patch))[1]?.head).toBeNull();
  expect(firstChangedLine(patch)).toEqual({ side: 'mergeBase', startLine: 1 });
});

it('aligns unequal edits and ignores file headers', () => {
  const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n-a\n+b\n+c\n';
  const rows = splitReviewDiff(parseReviewDiff(patch));
  expect(rows).toHaveLength(3);
  expect(rows[2]).toMatchObject({ base: null, head: { head: 2, content: 'c' } });
  expect(firstChangedLine(patch)).toEqual({ side: 'head', startLine: 1 });
  expect(firstChangedLine('Binary files differ')).toBeUndefined();
});
