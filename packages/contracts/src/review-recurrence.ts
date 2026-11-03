import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const findingOccurrenceSchema = z.object({
  algorithm: z.literal('source-segment-v1'),
  key: hash,
  segmentHash: hash,
  path: z.string(),
});
export const reviewRecurrenceSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(['compared', 'no-baseline', 'unavailable']),
  reason: z.string(),
  baseline: z
    .object({
      analysisId: z.string().uuid(),
      headSha: z.string().regex(/^[a-f0-9]{40}$/),
      state: z.enum(['completed', 'partial']),
    })
    .nullable(),
  items: z.array(
    z.object({
      findingId: z.string().uuid(),
      status: z.enum(['observed-again', 'same-head', 'not-in-baseline', 'untracked', 'ambiguous']),
      previousFindingId: z.string().uuid().nullable(),
    }),
  ),
  unconfirmedPrevious: z.array(
    z.object({
      findingId: z.string().uuid(),
      title: z.string(),
      path: z.string(),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']),
    }),
  ),
});
export type ReviewRecurrence = z.infer<typeof reviewRecurrenceSchema>;
