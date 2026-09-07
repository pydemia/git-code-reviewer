import { describe, expect, it } from 'vitest';
import { buildReviewWindows, formatReviewWindow, windowContainsComment } from './review-windows.js';

describe('bounded review windows', () => {
  const file = {
    id: 'file-id',
    path: 'src/service.ts',
    patch: '@@ -9,3 +19,3 @@\n context\n-old\n+new\n tail\n@@ -80 +90 @@\n-removed\n+added\n',
  };
  it('preserves exact base/head and multi-hunk lines without phantom trailing lines', () => {
    const windows = buildReviewWindows(file);
    expect(windows.map((window) => [window.side, window.startLine, window.endLine])).toEqual([
      ['head', 19, 21],
      ['mergeBase', 9, 11],
      ['head', 90, 90],
      ['mergeBase', 80, 80],
    ]);
    expect(windows[0]!.lines[1]).toEqual({ number: 20, text: 'new', changed: true, core: true });
    expect(formatReviewWindow(windows[1]!)).toContain('risks INTRODUCED BY REMOVAL');
    expect(formatReviewWindow(windows[0]!)).toContain('20 | core | + | new');
  });
  it('overlaps context while assigning each changed line to exactly one core', () => {
    const windows = buildReviewWindows(
      {
        ...file,
        patch:
          '@@ -0,0 +1,9 @@\n' + Array.from({ length: 9 }, (_, n) => `+line${n + 1}`).join('\n'),
      },
      { coreLines: 4, overlapLines: 1 },
    );
    expect(windows.map((window) => [window.startLine, window.endLine])).toEqual([
      [1, 4],
      [5, 8],
      [9, 9],
    ]);
    expect(windows[1]!.lines.map((line) => line.number)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(windowContainsComment(windows[1]!, 4)).toBe(false);
    expect(windowContainsComment(windows[1]!, 8, 9)).toBe(true);
    expect(windowContainsComment(windows[1]!, 8, 10)).toBe(false);
    expect(
      windows.flatMap((window) =>
        window.lines.filter((line) => line.core).map((line) => line.number),
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
  it('does not invent lines for metadata-only or binary changes', () => {
    expect(buildReviewWindows({ ...file, patch: 'Binary files differ' })).toEqual([]);
    expect(buildReviewWindows({ ...file, patch: '@@ -1 +1 @@\n unchanged\n' })).toEqual([]);
    expect(() => buildReviewWindows(file, { coreLines: 1, overlapLines: 1 })).toThrow();
    expect(windowContainsComment(buildReviewWindows(file)[0]!, 0)).toBe(true);
    expect(windowContainsComment(buildReviewWindows(file)[0]!, 0, 2)).toBe(false);
  });
});
