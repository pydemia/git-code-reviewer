export type DiffLine = {
  content: string;
  kind: 'context' | 'added' | 'removed' | 'hunk';
  base: number | null;
  head: number | null;
};
export type DiffRow = { base: DiffLine | null; head: DiffLine | null };
export const priorityLabels = {
  P0: 'P0 Praise',
  P1: 'P1 Info',
  P2: 'P2 Warning',
  P3: 'P3 Critical',
};

export function parseReviewDiff(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let base = 0,
    head = 0,
    inHunk = false;
  for (const source of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(source);
    if (hunk) {
      base = Number(hunk[1]);
      head = Number(hunk[2]);
      inHunk = true;
      lines.push({ content: source, kind: 'hunk', base: null, head: null });
    } else if (source.startsWith('diff --git')) inHunk = false;
    else if (inHunk && source.startsWith('-'))
      lines.push({ content: source.slice(1), kind: 'removed', base: base++, head: null });
    else if (inHunk && source.startsWith('+'))
      lines.push({ content: source.slice(1), kind: 'added', base: null, head: head++ });
    else if (inHunk && source.startsWith(' '))
      lines.push({ content: source.slice(1), kind: 'context', base: base++, head: head++ });
  }
  return lines;
}

export function splitReviewDiff(lines: DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (line.kind === 'context' || line.kind === 'hunk') {
      rows.push({ base: line, head: line });
      index++;
      continue;
    }
    const removed: DiffLine[] = [],
      added: DiffLine[] = [];
    while (lines[index]?.kind === 'removed') removed.push(lines[index++]!);
    while (lines[index]?.kind === 'added') added.push(lines[index++]!);
    for (let row = 0; row < Math.max(removed.length, added.length); row++)
      rows.push({ base: removed[row] ?? null, head: added[row] ?? null });
  }
  return rows;
}

export function firstChangedLine(patch: string) {
  const lines = parseReviewDiff(patch);
  const line =
    lines.find((item) => item.kind === 'added') ?? lines.find((item) => item.kind === 'removed');
  return line
    ? {
        side: line.head === null ? ('mergeBase' as const) : ('head' as const),
        startLine: line.head ?? line.base ?? undefined,
      }
    : undefined;
}
