import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { clientReviewReport, type ClientReviewReport, type LocalScope } from '@gcr/client-contract';
import { summarizeLocalReviews } from './local-review-observations.js';
const corpus = JSON.parse(
  readFileSync(
    new URL('../../../tests/fixtures/client-contract/reports.json', import.meta.url),
    'utf8',
  ),
);
const report = (name = 'clean') =>
  clientReviewReport(corpus.cases.find((entry: { name: string }) => entry.name === name).report);
const client = report().identity.client;
const scope: LocalScope = {
  kind: 'repository',
  profileId: client.profileId,
  repositoryKey: client.repositoryKey,
  worktreeKey: client.worktreeKey,
};
const options = { scope, days: 7 as const, now: new Date('2026-01-08T00:00:01.000Z') };
it('counts terminal states and recorded duration without inferring provider calls or billing', () => {
  const reports = [
    'clean',
    'partial',
    'failed',
    'cancelled',
    'needs-context',
    'executor-unavailable',
  ].map(report);
  const before = JSON.stringify(reports);
  const value = summarizeLocalReviews(reports, options);
  expect(value.coverage.includedRecords).toBe(6);
  expect(value.statuses).toEqual({
    completed: 1,
    partial: 1,
    failed: 1,
    cancelled: 1,
    'needs-context': 1,
    unavailable: 1,
  });
  expect(value.duration).toEqual({ startedRecords: 5, unstartedRecords: 1, reportedMs: 5000 });
  expect(value.findings).toEqual({ P0: 0, P1: 0, P2: 0, P3: 2 });
  expect(value.findingOutcomes).toEqual({ violation: 2 });
  expect(value.knowledge.unrecorded).toBe(6);
  expect([value.providerCalls, value.tokenUsage, value.billedCost]).toEqual([null, null, null]);
  expect(JSON.stringify(reports)).toBe(before);
});
it('uses the inclusive finish window, excludes future records, and deduplicates exact run IDs', () => {
  const boundary = report();
  const old = report();
  old.runId = 'old';
  old.requestedAt = old.startedAt = old.finishedAt = '2026-01-01T00:00:00.000Z';
  const future = report();
  future.runId = 'future';
  future.finishedAt = '2026-01-09T00:00:00.000Z';
  const value = summarizeLocalReviews([boundary, structuredClone(boundary), old, future], options);
  expect(value.coverage).toEqual({
    availableRecords: 3,
    includedRecords: 1,
    duplicateRecords: 1,
    futureRecords: 1,
    incompleteHistory: false,
    deletedOrUnsaved: 'unknown',
  });
});
it('rejects conflicting duplicates and other profile or worktree records even outside the window', () => {
  const conflict = report();
  conflict.summary = 'changed';
  expect(() => summarizeLocalReviews([report(), conflict], options)).toThrow('Conflicting');
  for (const field of ['profileId', 'repositoryKey', 'worktreeKey'] as const) {
    const r = report();
    r.identity.client[field] = field === 'profileId' ? 'other-profile' : 'a'.repeat(64);
    expect(() => summarizeLocalReviews([r], { ...options, now: new Date('2027-01-01') })).toThrow(
      'worktree',
    );
  }
});
it('distinguishes downloaded knowledge, offline cache and local fallback without claiming quality', () => {
  const audience = { serverId: 'server', tenantId: 'tenant', userId: 'user', repositoryId: 'repo' };
  const central = (source: 'central-online' | 'central-cache'): ClientReviewReport => {
    const r = report();
    r.runId = source;
    r.identity.client = {
      ...client,
      mode: 'centralized',
      audience,
      execution: {
        configuredMode: 'centralized',
        effectiveMode: 'centralized',
        knowledgeSource: source,
        fallbackReason: null,
        connectionId: 'a'.repeat(64),
      },
    };
    r.identity.context.centralSnapshot = {
      id: 'snapshot',
      hash: 'b'.repeat(64),
      audience,
      authorizationRevision: 'auth-1',
      offlineValidUntil: '2026-02-01T00:00:00.000Z',
    };
    r.identity.context.entries = [
      {
        origin: 'central',
        kind: 'policy',
        component: 'policy',
        id: 'policy',
        revision: 1,
        hash: 'c'.repeat(64),
      },
    ];
    return r;
  };
  const fallback = report();
  fallback.identity.client.execution = {
    configuredMode: 'centralized',
    effectiveMode: 'standalone',
    knowledgeSource: 'local',
    fallbackReason: 'timeout',
    connectionId: 'a'.repeat(64),
  };
  const value = summarizeLocalReviews(
    [central('central-online'), central('central-cache'), fallback],
    { ...options, incompleteHistory: true },
  );
  expect(value.knowledge).toEqual({
    local: 1,
    centralOnline: 1,
    centralCache: 1,
    unrecorded: 0,
    withPinnedSnapshot: 2,
    withSelectedPublicCriteria: 2,
    withLocalFallback: 1,
  });
  expect(value.coverage.incompleteHistory).toBe(true);
  const skillsOnly = central('central-online');
  skillsOnly.identity.context.entries[0]!.kind = 'skill';
  expect(summarizeLocalReviews([skillsOnly], options).knowledge.withSelectedPublicCriteria).toBe(0);
});
it('keeps finding outcomes separate and bounds model groups without losing review totals', () => {
  const reports = Array.from({ length: 33 }, (_, i) => {
    const r = report('partial');
    r.runId = `run-${i}`;
    r.identity.executor.model = `model-${i}`;
    return r;
  });
  reports[0]!.findings[0]!.outcome = 'incomplete';
  const value = summarizeLocalReviews(reports, options);
  expect(value.findingOutcomes).toEqual({ incomplete: 1, violation: 32 });
  expect(value.models).toHaveLength(32);
  expect(value.omittedModelGroups).toBe(1);
  expect(value.coverage.includedRecords).toBe(33);
});
it('rejects invalid windows, oversized input, and duration overflow', () => {
  expect(() => summarizeLocalReviews([], { ...options, days: 1 as 7 })).toThrow();
  expect(() => summarizeLocalReviews([], { ...options, now: new Date(NaN) })).toThrow();
  expect(() => summarizeLocalReviews(Array(20001).fill(report()), options)).toThrow();
  const a = report(),
    b = report();
  a.durationMs = Number.MAX_SAFE_INTEGER;
  b.runId = 'other';
  expect(() => summarizeLocalReviews([a, b], options)).toThrow('numeric range');
});
