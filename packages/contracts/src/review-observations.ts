import { z } from 'zod';
const count = z.number().int().nonnegative();
export const reportObservationSchema = z.object({
  schemaVersion: z.literal(1),
  reviewStatus: z.enum(['model', 'fixture', 'failed', 'unavailable', 'unknown']),
  durationMs: count,
  findings: z.object({ P0: count, P1: count, P2: count, P3: count }),
  criteria: z.object({
    violation: count,
    satisfied: count,
    uncertain: count,
    notReported: count,
    unavailable: count,
  }),
  recurrence: z.object({
    status: z.enum(['compared', 'no-baseline', 'unavailable', 'unrecorded']),
    repeated: count,
    unconfirmedPrevious: count,
  }),
});
export const reviewObservationsSchema = z.object({
  schemaVersion: z.literal(1),
  repositoryId: z.string().uuid(),
  observedAt: z.string().datetime(),
  window: z.object({
    days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
    from: z.string().datetime(),
    runLimit: count,
    includedRuns: count,
    truncated: z.boolean(),
  }),
  pulls: z.object({
    included: count,
    states: z.record(z.string(), count),
    latestAtObservedHead: count,
    latestAtOtherHead: count,
    reports: count,
    recordedReports: count,
    fixtureReports: count,
    reviewStatuses: z.record(z.string(), count),
    unrecordedReports: count,
    findings: reportObservationSchema.shape.findings,
    criteria: reportObservationSchema.shape.criteria,
    recurrence: z.object({
      comparedReports: count,
      unavailableReports: count,
      repeated: count,
      unconfirmedPrevious: count,
    }),
  }),
  effort: z.object({
    recordedDurations: count,
    fixtureDurations: count,
    unrecordedDurations: count,
    totalReportedDurationMs: count,
    ledgerAttempts: count,
    ledgerStates: z.record(z.string(), count),
    runsWithLedger: count,
    runsWithoutLedger: count,
    inputBytes: count,
    billedCost: z.null(),
    tokenUsage: z.null(),
  }),
  decisions: z.array(z.object({ state: z.string(), outcome: z.string(), count })),
  publication: z.array(
    z.object({
      component: z.enum(['policy', 'collective']),
      state: z.string(),
      releaseSequence: count,
      publishedInWindow: count,
    }),
  ),
  downloads: z.object({
    since: z.string().datetime().nullable(),
    bestEffort: z.literal(true),
    responses: z.array(
      z.object({
        route: z.enum(['manifest', 'bundle']),
        status: count,
        count,
        totalDurationMs: count,
      }),
    ),
  }),
  local: z.object({ execution: z.literal('unknown'), applied: z.literal('unknown') }),
  quality: z.object({ falsePositiveRate: z.null(), incidentReduction: z.null() }),
});
export type ReportObservation = z.infer<typeof reportObservationSchema>;
export type ReviewObservations = z.infer<typeof reviewObservationsSchema>;
