import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { ReviewReport } from '@gcr/review-contract';
import { compareReviewOccurrences } from './review-recurrence.js';
const finding = (key: string | undefined, title = 'same observed issue') => ({
  id: randomUUID(),
  title,
  priority: 'P2',
  ...(key
    ? {
        occurrence: {
          algorithm: 'source-segment-v1',
          key,
          segmentHash: 'b'.repeat(64),
          path: 'cache.ts',
        },
      }
    : {}),
});
const report = (findings: ReturnType<typeof finding>[]) => ({ findings }) as ReviewReport;
const baseline = { analysisId: randomUUID(), headSha: 'a'.repeat(40), state: 'partial' as const };
it('distinguishes same-head retry from another SHA and retains all current findings', () => {
  const previous = report([finding('c'.repeat(64))]),
    current = report([finding('c'.repeat(64)), finding('d'.repeat(64))]);
  const result = compareReviewOccurrences(current, previous, 'b'.repeat(40), baseline);
  expect(result.items.map((x) => x.status)).toEqual(['observed-again', 'not-in-baseline']);
  expect(current.findings).toHaveLength(2);
  expect(result.unconfirmedPrevious).toEqual([]);
  expect(
    compareReviewOccurrences(current, previous, baseline.headSha, baseline).items[0]!.status,
  ).toBe('same-head');
});
it.each(['before', 'after'])('refuses ambiguous identical source occurrences in %s', (side) => {
  const previous = report([finding('c'.repeat(64))]),
    current = report([finding('c'.repeat(64))]);
  (side === 'before' ? previous : current).findings.push(
    finding('c'.repeat(64)) as ReviewReport['findings'][number],
  );
  const result = compareReviewOccurrences(current, previous, 'b'.repeat(40), baseline);
  expect(result.items.every((x) => x.status === 'ambiguous' && x.previousFindingId === null)).toBe(
    true,
  );
  expect(result.unconfirmedPrevious).toHaveLength(previous.findings.length);
});
it('keeps unmatched and untracked prior observations as unconfirmed, never fixed', () => {
  const previous = report([finding('c'.repeat(64)), finding(undefined)]),
    current = report([finding(undefined)]);
  const result = compareReviewOccurrences(current, previous, 'b'.repeat(40), baseline);
  expect(result.items[0]!.status).toBe('untracked');
  expect(result.unconfirmedPrevious).toHaveLength(2);
  expect(JSON.stringify(result)).not.toContain('fixed');
});
