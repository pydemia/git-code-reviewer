import { createHash } from 'node:crypto';
import type { ReviewReport } from '@gcr/review-contract';
import { buildReviewWindows } from './review-windows.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Exact observed code and explanation identity, not a permanent rule ID or semantic defect proof. */
export function assignFindingOccurrences(
  report: ReviewReport,
  files: Array<{ id: string; path: string; patch: string }>,
  publicPolicyHash?: string,
) {
  const versions = Object.fromEntries(
    Object.entries(report.versions).sort(([a], [b]) => a.localeCompare(b)),
  );
  const sources = new Map(
    files.map((file) => {
      const sides = { head: new Map<number, string>(), mergeBase: new Map<number, string>() };
      const conflicts = new Set<string>();
      for (const window of buildReviewWindows(file))
        for (const line of window.lines) {
          const key = `${window.side}:${line.number}`,
            prior = sides[window.side].get(line.number);
          if (conflicts.has(key)) continue;
          if (prior !== undefined && prior !== line.text) {
            conflicts.add(key);
            sides[window.side].delete(line.number);
          } else sides[window.side].set(line.number, line.text);
        }
      return [file.id, { path: file.path, sides }] as const;
    }),
  );
  for (const finding of report.findings) {
    delete finding.occurrence;
    const file = sources.get(finding.anchor.fileId),
      start = finding.anchor.startLine,
      end = finding.anchor.endLine;
    if (
      finding.priority === 'P0' ||
      finding.verification.status !== 'verified' ||
      !file ||
      !start ||
      !end ||
      end < start ||
      end - start >= 500
    )
      continue;
    const lines = file.sides[finding.anchor.side],
      segment: string[] = [];
    for (let line = start; line <= end; line++) {
      const text = lines.get(line);
      if (text === undefined) break;
      segment.push(text);
    }
    if (segment.length !== end - start + 1) continue;
    const segmentHash = hash(segment);
    const criteria = (finding.criteria?.items ?? [])
      .map((item) => [item.id, item.revision, item.hash, item.outcome])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    finding.occurrence = {
      algorithm: 'source-segment-v1',
      path: file.path,
      segmentHash,
      key: hash({
        algorithm: 'source-segment-v1',
        path: file.path,
        side: finding.anchor.side,
        segmentHash,
        producer: finding.source.producer,
        kind: finding.source.kind,
        rule: finding.source.rule ?? null,
        category: finding.category,
        problem: finding.problem,
        criteria,
        versions,
        publicPolicyHash: publicPolicyHash ?? null,
      }),
    };
  }
}
