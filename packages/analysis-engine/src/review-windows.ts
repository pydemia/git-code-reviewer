import { createHash } from 'node:crypto';

export type ReviewWindowLine = { number: number; text: string; changed: boolean; core: boolean };
export type ReviewWindow = {
  id: string;
  fileId: string;
  path: string;
  side: 'head' | 'mergeBase';
  startLine: number;
  endLine: number;
  lines: ReviewWindowLine[];
  comparison: { side: 'head' | 'mergeBase'; lines: Array<Omit<ReviewWindowLine, 'core'>> };
};

type DiffLine = Omit<ReviewWindowLine, 'core'>;
type Hunk = { head: DiffLine[]; mergeBase: DiffLine[] };

/** Window는 모델 입력의 크기 단위다. Comment가 지정한 작은 범위가 실제 code segment다. */
export function buildReviewWindows(
  file: { id: string; path: string; patch: string },
  options: { coreLines?: number; overlapLines?: number } = {},
): ReviewWindow[] {
  const coreLines = options.coreLines ?? 80;
  const overlap = options.overlapLines ?? 12;
  if (
    !Number.isInteger(coreLines) ||
    coreLines < 1 ||
    coreLines > 500 ||
    !Number.isInteger(overlap) ||
    overlap < 0 ||
    overlap >= coreLines
  ) {
    throw new Error('Review window 크기 또는 overlap이 올바르지 않습니다.');
  }
  const windows: ReviewWindow[] = [];
  for (const hunk of parseHunks(file.patch)) {
    for (const side of ['head', 'mergeBase'] as const) {
      const lines = hunk[side];
      for (let offset = 0; offset < lines.length; offset += coreLines) {
        const core = lines.slice(offset, offset + coreLines);
        if (!core.some((line) => line.changed)) continue;
        const startLine = core[0]!.number;
        const endLine = core.at(-1)!.number;
        windows.push({
          id: createHash('sha256')
            .update(`${file.id}:${side}:${startLine}:${endLine}`)
            .digest('hex'),
          fileId: file.id,
          path: file.path,
          side,
          startLine,
          endLine,
          comparison: {
            side: side === 'head' ? 'mergeBase' : 'head',
            lines: hunk[side === 'head' ? 'mergeBase' : 'head'].slice(
              Math.max(0, offset - overlap),
              offset + coreLines + overlap,
            ),
          },
          lines: lines
            .slice(Math.max(0, offset - overlap), offset + coreLines + overlap)
            .map((line) => ({
              ...line,
              core: line.number >= startLine && line.number <= endLine,
            })),
        });
      }
    }
  }
  return windows;
}

export function formatReviewWindow(window: ReviewWindow): string {
  return [
    `File: ${window.path}`,
    `Window: ${window.id}; side=${window.side}; comment start must be in ${window.startLine}..${window.endLine}`,
    'Each row: line | core/context | change marker | source. Context rows explain boundaries; do not repeat comments from them.',
    ...(window.side === 'mergeBase'
      ? [
          'This is the OLD revision. Review risks INTRODUCED BY REMOVAL, not defects that this PR removes.',
        ]
      : []),
    ...window.lines.map(
      (line) =>
        `${line.number} | ${line.core ? 'core' : 'context'} | ${line.changed ? (window.side === 'head' ? '+' : '-') : ' '} | ${line.text}`,
    ),
    `Comparison context only (${window.comparison.side}); bounded excerpt, not necessarily line-aligned. Do not anchor comments here:`,
    ...window.comparison.lines.map(
      (line) =>
        `${line.number} | comparison | ${line.changed ? (window.comparison.side === 'head' ? '+' : '-') : ' '} | ${line.text}`,
    ),
  ].join('\n');
}

export function windowContainsComment(window: ReviewWindow, start: number, end = start): boolean {
  if (start === 0) return end === 0;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < window.startLine ||
    start > window.endLine ||
    end < start
  )
    return false;
  const available = new Set(window.lines.map((line) => line.number));
  if (end - start >= available.size) return false;
  for (let line = start; line <= end; line += 1) if (!available.has(line)) return false;
  return true;
}

function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let hunk: Hunk | undefined;
  let base = 0;
  let head = 0;
  let baseRemaining = 0;
  let headRemaining = 0;
  for (const row of patch.split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (match) {
      base = Number(match[1]);
      head = Number(match[3]);
      baseRemaining = Number(match[2] ?? 1);
      headRemaining = Number(match[4] ?? 1);
      hunk = { head: [], mergeBase: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk || (!baseRemaining && !headRemaining) || row.startsWith('\\')) continue;
    const marker = row[0];
    if (marker === ' ' && baseRemaining > 0 && headRemaining > 0) {
      hunk.head.push({ number: head++, text: row.slice(1), changed: false });
      hunk.mergeBase.push({ number: base++, text: row.slice(1), changed: false });
      baseRemaining -= 1;
      headRemaining -= 1;
    } else if (marker === '+' && headRemaining > 0) {
      hunk.head.push({ number: head++, text: row.slice(1), changed: true });
      headRemaining -= 1;
    } else if (marker === '-' && baseRemaining > 0) {
      hunk.mergeBase.push({ number: base++, text: row.slice(1), changed: true });
      baseRemaining -= 1;
    }
  }
  return hunks;
}
