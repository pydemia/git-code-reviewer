import {
  clientReviewReport,
  localScope,
  type ClientReviewReport,
  type LocalScope,
} from '@gcr/client-contract';
import { canonicalJson } from './local-identity.js';
export interface LocalReviewObservations {
  formatVersion: 1;
  observedAt: string;
  from: string;
  days: 7 | 30 | 90;
  coverage: {
    availableRecords: number;
    includedRecords: number;
    duplicateRecords: number;
    futureRecords: number;
    incompleteHistory: boolean;
    deletedOrUnsaved: 'unknown';
  };
  statuses: Record<string, number>;
  triggers: Record<string, number>;
  duration: { startedRecords: number; unstartedRecords: number; reportedMs: number };
  findings: { P0: number; P1: number; P2: number; P3: number };
  findingOutcomes: Record<string, number>;
  knowledge: {
    local: number;
    centralOnline: number;
    centralCache: number;
    unrecorded: number;
    withPinnedSnapshot: number;
    withSelectedPublicCriteria: number;
    withLocalFallback: number;
  };
  models: Array<{ executor: string; model: string; reviews: number }>;
  omittedModelGroups: number;
  providerCalls: null;
  tokenUsage: null;
  billedCost: null;
}
/** Summarize only already-authorized local history. No I/O, model calls or synchronization. */
export function summarizeLocalReviews(
  reports: readonly ClientReviewReport[],
  options: { scope: LocalScope; days: 7 | 30 | 90; now?: Date; incompleteHistory?: boolean },
): LocalReviewObservations {
  const scope = localScope(options.scope),
    now = options.now ?? new Date();
  if (
    scope.kind !== 'repository' ||
    ![7, 30, 90].includes(options.days) ||
    !Number.isFinite(now.getTime()) ||
    reports.length > 20000
  )
    throw Error('Invalid local observation scope or window');
  const from = new Date(now.getTime() - options.days * 86400000);
  const seen = new Map<string, string>();
  const out: LocalReviewObservations = {
    formatVersion: 1,
    observedAt: now.toISOString(),
    from: from.toISOString(),
    days: options.days,
    coverage: {
      availableRecords: 0,
      includedRecords: 0,
      duplicateRecords: 0,
      futureRecords: 0,
      incompleteHistory: options.incompleteHistory ?? false,
      deletedOrUnsaved: 'unknown',
    },
    statuses: {},
    triggers: {},
    duration: { startedRecords: 0, unstartedRecords: 0, reportedMs: 0 },
    findings: { P0: 0, P1: 0, P2: 0, P3: 0 },
    findingOutcomes: {},
    knowledge: {
      local: 0,
      centralOnline: 0,
      centralCache: 0,
      unrecorded: 0,
      withPinnedSnapshot: 0,
      withSelectedPublicCriteria: 0,
      withLocalFallback: 0,
    },
    models: [],
    omittedModelGroups: 0,
    providerCalls: null,
    tokenUsage: null,
    billedCost: null,
  };
  const models = new Map<string, { executor: string; model: string; reviews: number }>();
  for (const raw of reports) {
    const r = clientReviewReport(raw),
      client = r.identity.client;
    if (
      client.profileId !== scope.profileId ||
      client.repositoryKey !== scope.repositoryKey ||
      client.worktreeKey !== scope.worktreeKey ||
      !r.finishedAt
    )
      throw Error('Local observation history does not match this worktree');
    const bytes = canonicalJson(r),
      previous = seen.get(r.runId);
    if (previous !== undefined) {
      if (previous !== bytes) throw Error('Conflicting local review history');
      out.coverage.duplicateRecords++;
      continue;
    }
    seen.set(r.runId, bytes);
    out.coverage.availableRecords++;
    if (r.finishedAt > out.observedAt) {
      out.coverage.futureRecords++;
      continue;
    }
    if (r.finishedAt < out.from) continue;
    out.coverage.includedRecords++;
    out.statuses[r.status] = (out.statuses[r.status] ?? 0) + 1;
    out.triggers[r.trigger] = (out.triggers[r.trigger] ?? 0) + 1;
    if (r.startedAt) {
      out.duration.startedRecords++;
      out.duration.reportedMs += r.durationMs;
    } else out.duration.unstartedRecords++;
    for (const f of r.findings) {
      out.findings[f.severity]++;
      out.findingOutcomes[f.outcome] = (out.findingOutcomes[f.outcome] ?? 0) + 1;
    }
    const execution = client.execution;
    if (!execution) out.knowledge.unrecorded++;
    else if (execution.knowledgeSource === 'local') out.knowledge.local++;
    else if (execution.knowledgeSource === 'central-online') out.knowledge.centralOnline++;
    else out.knowledge.centralCache++;
    if (client.mode === 'standalone' && execution?.configuredMode === 'centralized')
      out.knowledge.withLocalFallback++;
    if (r.identity.context.centralSnapshot) out.knowledge.withPinnedSnapshot++;
    if (
      r.identity.context.entries.some(
        (e) => e.origin === 'central' && e.component === 'policy' && e.kind === 'policy',
      )
    )
      out.knowledge.withSelectedPublicCriteria++;
    const key = canonicalJson([r.identity.executor.id, r.identity.executor.model]);
    const m = models.get(key) ?? {
      executor: r.identity.executor.id,
      model: r.identity.executor.model,
      reviews: 0,
    };
    m.reviews++;
    models.set(key, m);
  }
  if (!Number.isSafeInteger(out.duration.reportedMs))
    throw Error('Local duration exceeds numeric range');
  out.models = [...models.values()]
    .sort(
      (a, b) =>
        b.reviews - a.reviews ||
        a.executor.localeCompare(b.executor) ||
        a.model.localeCompare(b.model),
    )
    .slice(0, 32);
  out.omittedModelGroups = models.size - out.models.length;
  return out;
}
