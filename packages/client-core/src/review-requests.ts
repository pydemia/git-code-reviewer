import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  clientReviewReport,
  executionIdentity,
  reviewRequestRecord,
  reviewStartLedger,
  reviewTrigger,
  type ClientReviewReport,
  type ExecutionIdentity,
  type ReviewRequestRecord,
  type ReviewTrigger,
} from '@gcr/client-contract';
import { LocalRecordStore, type LocalRecordOptions } from './local-records.js';
import { LocalStoreError } from './local-errors.js';
import { contentHash, defaultLocalDataDirectory } from './local-identity.js';
export class ReviewRequestError extends Error {
  constructor(
    readonly code:
      | 'request-busy'
      | 'request-interrupted'
      | 'request-deferred'
      | 'request-lost'
      | 'request-invalid',
    readonly retryAt?: number,
    readonly deferredReason?: 'manual-priority' | 'review-budget',
  ) {
    super(
      {
        'request-busy': 'Another process is updating this review request.',
        'request-interrupted':
          'A previous process may have started this review. Its outcome must be checked before another execution.',
        'request-deferred':
          'Manual review priority, the automatic budget or minimum interval defers this request.',
        'request-lost': 'This process no longer owns the review request.',
        'request-invalid':
          'The review request does not match its profile, worktree or saved result.',
      }[code],
    );
    this.name = 'ReviewRequestError';
  }
}
export function reviewRequestKey(input: ExecutionIdentity) {
  const identity = executionIdentity(input);
  // A successful 304 changes an observation time, not the source or knowledge
  // that a model reviewed. Mode/source/fallback provenance remains in the key.
  if (identity.client.execution) delete identity.client.execution.lastSynchronizedAt;
  return contentHash(identity);
}
export type ReviewRequestLease = { key: string; token: string; generation: number };
export type ReviewStartLimits = { minimumIntervalMs?: number; maximumReviewsPerHour?: number };
type State = { revision: number; value: ReviewRequestRecord };
type ManualPriority = {
  version: 1;
  observedAt: number;
  holders: Array<{ token: string; deadline: number }>;
};
/** Encrypted per-profile/worktree journal. A running lease never silently
 * reverts to queued: a stopped heartbeat cannot prove that the model stopped. */
export class ReviewRequests {
  private constructor(
    private readonly records: LocalRecordStore,
    private readonly now: () => number,
  ) {}
  static async open(options: LocalRecordOptions & { now?: () => number }) {
    if (options.scope.kind !== 'repository') throw new ReviewRequestError('request-invalid');
    const records = await LocalRecordStore.open({
      ...options,
      dataDirectory: path.join(
        options.dataDirectory ?? defaultLocalDataDirectory(),
        'review-requests',
      ),
    });
    return new ReviewRequests(records, options.now ?? Date.now);
  }
  close() {
    this.records.close();
  }
  private time(previous = 0) {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || now < previous)
      throw new ReviewRequestError('request-invalid');
    return now;
  }
  private checkIdentity(identity: ExecutionIdentity) {
    const scope = this.records.scope,
      client = identity.client;
    if (
      scope.kind !== 'repository' ||
      scope.profileId !== client.profileId ||
      scope.repositoryKey !== client.repositoryKey ||
      scope.worktreeKey !== client.worktreeKey
    )
      throw new ReviewRequestError('request-invalid');
  }
  private async state(key: string): Promise<State | undefined> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new ReviewRequestError('request-invalid');
    const row = await this.records.read('settings', key);
    if (!row || row.deleted) return undefined;
    const value = reviewRequestRecord(row.value);
    this.checkIdentity(value.identity);
    this.time(value.updatedAt);
    if (value.key !== key || reviewRequestKey(value.identity) !== key)
      throw new ReviewRequestError('request-invalid');
    return { revision: row.revision, value };
  }
  private async put(state: State | undefined, value: ReviewRequestRecord) {
    await this.records.write(
      'settings',
      value.key,
      reviewRequestRecord(value),
      state?.revision ?? 0,
    );
    return value;
  }
  private async retry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        return await work();
      } catch (cause) {
        if (!(cause instanceof LocalStoreError) || cause.code !== 'revision-conflict') throw cause;
      }
    }
    throw new ReviewRequestError('request-busy');
  }
  private async priorityState() {
    // Auxiliary records share the completion-receipt namespace, not the settings
    // request index, so older readers can still list their existing requests.
    const row = await this.records.read('chats', 'manual_priority');
    if (row?.deleted) throw new ReviewRequestError('request-invalid');
    const value = (row?.value ?? { version: 1, observedAt: 0, holders: [] }) as ManualPriority;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.observedAt) ||
      value.observedAt < 0 ||
      !Array.isArray(value.holders) ||
      value.holders.length > 64 ||
      value.holders.some(
        (holder) =>
          !holder ||
          !/^[a-f0-9-]{36}$/.test(holder.token) ||
          !Number.isSafeInteger(holder.deadline) ||
          holder.deadline < 0 ||
          holder.deadline > value.observedAt + 30000,
      ) ||
      new Set(value.holders.map((holder) => holder.token)).size !== value.holders.length
    )
      throw new ReviewRequestError('request-invalid');
    const now = this.time(value.observedAt);
    return {
      revision: row?.revision ?? 0,
      value: {
        ...value,
        observedAt: now,
        holders: value.holders.filter((holder) => holder.deadline > now),
      },
    };
  }
  /** A caller renews its priority while waiting for or executing a manual review.
   * Expiration releases scheduling priority only; it never retries an unknown model. */
  async prioritizeManual(token?: string) {
    const selected = token ?? randomUUID();
    return this.retry(async () => {
      const state = await this.priorityState();
      const existing = state.value.holders.find((holder) => holder.token === selected);
      if (token && !existing) throw new ReviewRequestError('request-lost');
      if (!existing && state.value.holders.length >= 64)
        throw new ReviewRequestError('request-busy');
      state.value.holders = [
        ...state.value.holders.filter((holder) => holder.token !== selected),
        { token: selected, deadline: state.value.observedAt + 30000 },
      ];
      await this.records.write('chats', 'manual_priority', state.value, state.revision);
      return selected;
    });
  }
  async releaseManualPriority(token: string) {
    await this.retry(async () => {
      const state = await this.priorityState();
      state.value.holders = state.value.holders.filter((holder) => holder.token !== token);
      await this.records.write('chats', 'manual_priority', state.value, state.revision);
    });
  }
  async manualPriorityRetryAt() {
    const state = await this.priorityState();
    return state.value.holders.length
      ? Math.min(
          state.value.observedAt + 2000,
          ...state.value.holders.map((holder) => holder.deadline),
        )
      : undefined;
  }
  private async admitAutomatic() {
    await this.retry(async () => {
      const state = await this.priorityState();
      if (state.value.holders.length)
        throw new ReviewRequestError(
          'request-deferred',
          Math.min(
            state.value.observedAt + 2000,
            ...state.value.holders.map((holder) => holder.deadline),
          ),
          'manual-priority',
        );
      // This CAS orders an automatic admission against concurrent manual entry.
      // Reviews already admitted continue; a later manual request does not kill them.
      await this.records.write('chats', 'manual_priority', state.value, state.revision);
    });
  }
  async enqueue(input: ExecutionIdentity, reason: ReviewTrigger) {
    const identity = executionIdentity(input);
    this.checkIdentity(identity);
    reviewTrigger(reason);
    const key = reviewRequestKey(identity);
    return this.retry(async () => {
      const state = await this.state(key);
      if (state) {
        if (state.value.reasons.includes(reason)) return state.value;
        return this.put(state, {
          ...state.value,
          reasons: [...state.value.reasons, reason].sort(),
          updatedAt: this.time(state.value.updatedAt),
        });
      }
      const now = this.time();
      return this.put(undefined, {
        formatVersion: 1,
        key,
        identity,
        reasons: [reason],
        state: 'queued',
        generation: 0,
        createdAt: now,
        updatedAt: now,
        owner: null,
        resultId: null,
      });
    });
  }
  async get(key: string) {
    return (await this.state(key))?.value;
  }
  async list() {
    const rows: ReviewRequestRecord[] = [];
    for (const id of await this.records.listIds('settings')) {
      if (id === 'budget') continue;
      const row = await this.get(id);
      if (row) rows.push(row);
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async claim(key: string, options: { leaseMs?: number; retryFinishedGeneration?: number } = {}) {
    const leaseMs = options.leaseMs ?? 30000;
    if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 120000)
      throw new ReviewRequestError('request-invalid');
    return this.retry(async () => {
      const state = await this.state(key);
      if (!state) throw new ReviewRequestError('request-invalid');
      const now = this.time(state.value.updatedAt);
      if (state.value.owner && state.value.owner.deadline > now)
        return { kind: 'waiting' as const, request: state.value };
      if (state.value.state === 'running') {
        const request = await this.put(state, {
          ...state.value,
          state: 'interrupted',
          // Interruption fences the owner token; it does not start another attempt.
          // Keep the attempt number so its completion receipt can be reconciled.
          owner: null,
          updatedAt: now,
        });
        return { kind: 'interrupted' as const, request };
      }
      if (state.value.state === 'interrupted')
        return { kind: 'interrupted' as const, request: state.value };
      if (
        state.value.state === 'finished' &&
        options.retryFinishedGeneration !== state.value.generation
      )
        return { kind: 'finished' as const, request: state.value };
      const token = randomUUID(),
        generation = state.value.generation + 1;
      const request = await this.put(state, {
        ...state.value,
        state: 'claimed',
        generation,
        updatedAt: now,
        owner: { token, deadline: now + leaseMs },
        resultId: null,
      });
      return { kind: 'acquired' as const, request, lease: { key, token, generation } };
    });
  }
  private async owned(lease: ReviewRequestLease) {
    const state = await this.state(lease.key);
    if (
      !state ||
      state.value.generation !== lease.generation ||
      state.value.owner?.token !== lease.token ||
      state.value.owner.deadline <= this.time()
    )
      throw new ReviewRequestError('request-lost');
    return state;
  }
  async heartbeat(lease: ReviewRequestLease, leaseMs = 30000) {
    if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 120000)
      throw new ReviewRequestError('request-invalid');
    await this.retry(async () => {
      const state = await this.owned(lease),
        now = this.time(state.value.updatedAt);
      await this.put(state, {
        ...state.value,
        updatedAt: now,
        owner: { token: lease.token, deadline: now + leaseMs },
      });
    });
  }
  async begin(lease: ReviewRequestLease, reason: ReviewTrigger, limits: ReviewStartLimits = {}) {
    reviewTrigger(reason);
    const minimum = limits.minimumIntervalMs ?? 0,
      maximum = limits.maximumReviewsPerHour ?? 1000;
    if (
      !Number.isInteger(minimum) ||
      minimum < 0 ||
      minimum > 3600000 ||
      !Number.isInteger(maximum) ||
      maximum < 1 ||
      maximum > 1000
    )
      throw new ReviewRequestError('request-invalid');
    const owned = await this.owned(lease);
    if (owned.value.state !== 'claimed') throw new ReviewRequestError('request-lost');
    if (reason !== 'manual') await this.admitAutomatic();
    await this.retry(async () => {
      await this.owned(lease);
      const row = await this.records.read('settings', 'budget');
      if (row?.deleted) throw new ReviewRequestError('request-invalid');
      const ledger = row
        ? reviewStartLedger(row.value)
        : { formatVersion: 1 as const, observedAt: 0, reservations: [] };
      const now = this.time(ledger.observedAt);
      const reservations = ledger.reservations.filter((r) => r.at > now - 3600000);
      if (reservations.some((r) => r.key === lease.key && r.generation === lease.generation))
        return;
      const last = reservations.filter((r) => r.reason === reason).at(-1);
      const retryAt = Math.max(
        reservations.length >= maximum
          ? reservations[reservations.length - maximum]!.at + 3600000
          : 0,
        last ? last.at + minimum : 0,
      );
      if (retryAt > now) throw new ReviewRequestError('request-deferred', retryAt);
      reservations.push({ key: lease.key, generation: lease.generation, at: now, reason });
      await this.records.write(
        'settings',
        'budget',
        reviewStartLedger({ formatVersion: 1, observedAt: now, reservations }),
        row?.revision ?? 0,
      );
    });
    // A conservative budget reservation may survive a crash before this CAS;
    // no provider may be called unless running ownership is persisted as well.
    await this.retry(async () => {
      const state = await this.owned(lease);
      if (state.value.state !== 'claimed') throw new ReviewRequestError('request-lost');
      await this.put(state, {
        ...state.value,
        state: 'running',
        updatedAt: this.time(state.value.updatedAt),
      });
    });
  }
  async finish(lease: ReviewRequestLease, report: ClientReviewReport) {
    const parsed = clientReviewReport(report);
    if (reviewRequestKey(parsed.identity) !== lease.key || !parsed.finishedAt)
      throw new ReviewRequestError('request-invalid');
    return this.retry(async () => {
      const state = await this.owned(lease);
      if (state.value.state !== 'running') throw new ReviewRequestError('request-lost');
      return this.put(state, {
        ...state.value,
        state: 'finished',
        owner: null,
        resultId: parsed.runId,
        updatedAt: this.time(state.value.updatedAt),
      });
    });
  }
  /** Record the returned terminal report before saving history. This is a pointer
   * and digest, not another copy of private report/source content. Older clients
   * ignore this separate record and can still decode the request journal. */
  async prepareCompletion(lease: ReviewRequestLease, report: ClientReviewReport) {
    const parsed = clientReviewReport(report);
    if (reviewRequestKey(parsed.identity) !== lease.key || !parsed.finishedAt)
      throw new ReviewRequestError('request-invalid');
    const state = await this.owned(lease);
    if (state.value.state !== 'running') throw new ReviewRequestError('request-lost');
    const id = `completion_${lease.key}_${lease.generation}`;
    const value = {
      version: 1,
      key: lease.key,
      generation: lease.generation,
      reportId: parsed.runId,
      reportHash: contentHash(parsed),
    };
    const old = await this.records.read('chats', id);
    if (old) {
      if (old.deleted || contentHash(old.value) !== contentHash(value))
        throw new ReviewRequestError('request-invalid');
      return;
    }
    await this.records.write('chats', id, value, 0);
  }
  /** Reattach only this attempt's terminal report. Never claim or run a model.
   * A missing receipt/history leaves interruption visible; lease expiry alone
   * does not establish that an external executor stopped. */
  async reconcile(
    key: string,
    generation: number,
    input: {
      loadReport(id: string): Promise<ClientReviewReport | undefined>;
      assertValid(): Promise<unknown>;
    },
  ) {
    if (!Number.isSafeInteger(generation) || generation < 1)
      throw new ReviewRequestError('request-invalid');
    return this.retry(async () => {
      let state = await this.state(key);
      if (!state || state.value.generation !== generation)
        throw new ReviewRequestError('request-invalid');
      const now = this.time(state.value.updatedAt);
      if (state.value.owner && state.value.owner.deadline > now) return { request: state.value };
      if (state.value.state === 'running') {
        const value = await this.put(state, {
          ...state.value,
          state: 'interrupted',
          owner: null,
          updatedAt: now,
        });
        state = (await this.state(key))!;
        if (state.value.generation !== generation || state.value.state !== value.state)
          throw new ReviewRequestError('request-lost');
      }
      if (!['interrupted', 'finished'].includes(state.value.state)) return { request: state.value };
      await input.assertValid();
      const row = await this.records.read('chats', `completion_${key}_${generation}`);
      const receipt = row && !row.deleted ? (row.value as Record<string, unknown>) : undefined;
      if (
        receipt &&
        (receipt.version !== 1 ||
          receipt.key !== key ||
          receipt.generation !== generation ||
          typeof receipt.reportId !== 'string' ||
          typeof receipt.reportHash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(receipt.reportHash))
      )
        throw new ReviewRequestError('request-invalid');
      if (!receipt && state.value.state !== 'finished') return { request: state.value };
      const id = state.value.resultId ?? String(receipt!.reportId);
      const report = await input.loadReport(id);
      if (!report) return { request: state.value };
      const parsed = clientReviewReport(report);
      if (
        parsed.runId !== id ||
        !parsed.finishedAt ||
        reviewRequestKey(parsed.identity) !== key ||
        (receipt && (receipt.reportId !== id || receipt.reportHash !== contentHash(parsed)))
      )
        throw new ReviewRequestError('request-invalid');
      await input.assertValid();
      if (state.value.state === 'finished') {
        if ((await this.state(key))?.revision !== state.revision)
          throw new ReviewRequestError('request-lost');
        return { request: state.value, report: parsed };
      }
      const request = await this.put(state, {
        ...state.value,
        state: 'finished',
        owner: null,
        resultId: parsed.runId,
        updatedAt: this.time(state.value.updatedAt),
      });
      return { request, report: parsed };
    });
  }
  async release(lease: ReviewRequestLease) {
    await this.retry(async () => {
      const state = await this.owned(lease);
      await this.put(state, {
        ...state.value,
        state: state.value.state === 'running' ? 'interrupted' : 'queued',
        owner: null,
        updatedAt: this.time(state.value.updatedAt),
      });
    });
  }
}

export async function executeReviewRequest(input: {
  storage: LocalRecordOptions;
  identity: ExecutionIdentity;
  reason?: ReviewTrigger;
  signal?: AbortSignal;
  retryFinished?: boolean;
  limits?: ReviewStartLimits;
  assertValid?(): Promise<unknown>;
  onRequest?(request: ReviewRequestRecord): Promise<void>;
  loadReport(id: string): Promise<ClientReviewReport | undefined>;
  saveReport(report: ClientReviewReport): Promise<unknown>;
  run(signal: AbortSignal): Promise<ClientReviewReport>;
}) {
  const queue = await ReviewRequests.open(input.storage);
  const controller = new AbortController(),
    cancel = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', cancel, { once: true });
  if (input.signal?.aborted) cancel();
  let lease: ReviewRequestLease | undefined;
  let manualPriority: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: Promise<void> = Promise.resolve();
  let lost = false;
  const check = () => {
    if (controller.signal.aborted) throw new ReviewRequestError('request-lost');
  };
  const beat = () => {
    timer = setTimeout(() => {
      heartbeat = (async () => {
        if (manualPriority) await queue.prioritizeManual(manualPriority);
        if (lease) await queue.heartbeat(lease);
      })().then(
        () => {
          if (!controller.signal.aborted) beat();
        },
        () => {
          lost = true;
          controller.abort();
        },
      );
    }, 10000);
    timer.unref?.();
  };
  try {
    check();
    const request = await queue.enqueue(input.identity, input.reason ?? 'manual');
    if ((input.reason ?? 'manual') === 'manual') {
      manualPriority = await queue.prioritizeManual();
      beat();
    }
    while (true) {
      check();
      const claimed = await queue.claim(
        request.key,
        request.state === 'finished' && input.retryFinished
          ? { retryFinishedGeneration: request.generation }
          : {},
      );
      if (claimed.kind === 'interrupted') throw new ReviewRequestError('request-interrupted');
      if (claimed.kind === 'waiting') {
        await delay(250, undefined, { signal: controller.signal });
        continue;
      }
      if (claimed.kind === 'finished') {
        const report = await input.loadReport(claimed.request.resultId!);
        if (!report || reviewRequestKey(clientReviewReport(report).identity) !== request.key)
          throw new ReviewRequestError('request-invalid');
        await input.assertValid?.();
        check();
        await input.onRequest?.(claimed.request);
        check();
        return { report, reused: true, persisted: true, recorded: true, requestKey: request.key };
      }
      lease = claimed.lease;
      await input.onRequest?.(claimed.request);
      break;
    }
    if (!manualPriority) beat();
    await input.assertValid?.();
    check();
    await queue.begin(lease, input.reason ?? 'manual', input.limits);
    check();
    const report = clientReviewReport(await input.run(controller.signal));
    if (reviewRequestKey(report.identity) !== request.key || !report.finishedAt)
      throw new ReviewRequestError('request-invalid');
    if (lost) throw new ReviewRequestError('request-lost');
    let persisted = false;
    // Failure to store an auxiliary recovery receipt must not suppress history.
    await queue.prepareCompletion(lease, report).catch(() => undefined);
    try {
      await input.saveReport(report);
      persisted = true;
    } catch {
      /* Preserve the observed report even if history cannot be saved. */
    }
    clearTimeout(timer);
    await heartbeat;
    // An in-flight heartbeat may have scheduled another timer while saving.
    clearTimeout(timer);
    let recorded = false;
    if (persisted && !lost) {
      try {
        await queue.finish(lease, report);
        recorded = true;
      } catch {
        /* Ownership/completion remains unconfirmed. */
      }
    }
    if (!recorded) await queue.release(lease).catch(() => undefined);
    lease = undefined;
    return { report, reused: false, persisted, recorded, requestKey: request.key };
  } finally {
    clearTimeout(timer);
    controller.abort();
    await heartbeat;
    if (lease) await queue.release(lease).catch(() => undefined);
    if (manualPriority) await queue.releaseManualPriority(manualPriority).catch(() => undefined);
    input.signal?.removeEventListener('abort', cancel);
    queue.close();
  }
}
