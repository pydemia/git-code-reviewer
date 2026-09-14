import { randomUUID } from 'node:crypto';
import { sourcePath } from '@gcr/client-contract';
import { contentHash } from './local-identity.js';
import { observeAutomaticRepository, observeAutomaticWorkingTree } from './automatic-source.js';
import { captureLocalSource, type FrozenLocalSource } from './source-snapshot.js';
import { LocalServiceError, type ServiceJobs, type ServiceRegistration } from './service-jobs.js';

export type WatchTrigger = 'stage' | 'save';
interface Observation {
  head: string | null;
  fingerprint: string;
  files: Array<{ path: string; hash: string | null }>;
}
export interface ServiceWatch {
  version: 1;
  repository: string;
  registrationRevision: number;
  trigger: WatchTrigger;
  enabled: boolean;
  minimumSaveIntervalMs: number;
  observed: Observation;
  pendingPaths: string[];
  changedAt: number;
  lastSubmittedAt: number;
  receiptId?: string;
  reviewPaths: string[];
  cancelIds: string[];
  intent?: { id: string; source: FrozenLocalSource };
  problem?: string;
}
export function validateServiceWatch(input: ServiceWatch): ServiceWatch {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (
    !input ||
    input.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(input.repository) ||
    !['stage', 'save'].includes(input.trigger) ||
    typeof input.enabled !== 'boolean' ||
    !Number.isSafeInteger(input.registrationRevision) ||
    input.registrationRevision < 1 ||
    !Number.isSafeInteger(input.minimumSaveIntervalMs) ||
    input.minimumSaveIntervalMs < 10000 ||
    input.minimumSaveIntervalMs > 3600000 ||
    !Array.isArray(input.pendingPaths) ||
    !Array.isArray(input.reviewPaths) ||
    !Array.isArray(input.cancelIds) ||
    !Array.isArray(input.observed?.files) ||
    !/^[a-f0-9]{64}$/.test(input.observed.fingerprint)
  )
    throw new LocalServiceError('service-invalid');
  if (
    ![input.changedAt, input.lastSubmittedAt].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    input.observed.files.length > 512 ||
    input.pendingPaths.length > 512 ||
    input.reviewPaths.length > 512 ||
    input.cancelIds.length > 2 ||
    input.cancelIds.some((id) => !uuid.test(id)) ||
    (input.receiptId !== undefined && !uuid.test(input.receiptId)) ||
    (input.intent !== undefined && (!uuid.test(input.intent.id) || !input.intent.source)) ||
    (input.observed.head !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.observed.head))
  )
    throw new LocalServiceError('service-invalid');
  for (const file of input.observed.files) {
    sourcePath(file.path);
    if (file.hash !== null && !/^[a-f0-9]{64}$/.test(file.hash))
      throw new LocalServiceError('service-invalid');
  }
  for (const file of [...input.pendingPaths, ...input.reviewPaths]) sourcePath(file);
  return input;
}

/** Uses the service's single mutation queue and review runner. Polling never starts
 * another executor; it records a fixed source intent before submitting a receipt. */
export class ServiceWatcher {
  problem: string | undefined;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling: Promise<void> | undefined;
  constructor(
    private readonly options: {
      jobs: ServiceJobs;
      serial<T>(work: () => Promise<T>): Promise<T>;
      cancel(id: string): Promise<unknown>;
      wake(): void;
      now?: () => number;
    },
  ) {}
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private async observe(reg: ServiceRegistration, trigger: WatchTrigger): Promise<Observation> {
    if (trigger === 'save')
      return observeAutomaticWorkingTree(reg.root, reg.options.excludePatterns);
    const index = await observeAutomaticRepository(reg.root, reg.options.excludePatterns);
    const files = index.changes.map((change) => ({ path: change.path, hash: contentHash(change) }));
    return {
      head: index.head,
      fingerprint: contentHash({ head: index.head, files }),
      files,
    };
  }
  // Configure/status/disable are called from inside the service mutation queue.
  async configure(
    reg: ServiceRegistration,
    input: {
      triggers: unknown;
      externalChanges?: unknown;
      minimumSaveIntervalMs?: unknown;
    },
  ) {
    if (
      !Array.isArray(input.triggers) ||
      !input.triggers.length ||
      input.triggers.some((t) => t !== 'save' && t !== 'stage') ||
      (input.externalChanges !== undefined && typeof input.externalChanges !== 'boolean')
    )
      throw new LocalServiceError('service-invalid');
    const triggers = [...new Set(input.triggers)] as WatchTrigger[];
    if (
      triggers.some((t) => !reg.triggers.includes(t)) ||
      (triggers.includes('save') && input.externalChanges !== true)
    )
      throw new LocalServiceError('service-denied');
    const minimumSaveIntervalMs = input.minimumSaveIntervalMs ?? 600000;
    if (
      !Number.isSafeInteger(minimumSaveIntervalMs) ||
      Number(minimumSaveIntervalMs) < 10000 ||
      Number(minimumSaveIntervalMs) > 3600000
    )
      throw new LocalServiceError('service-invalid');
    const replacements: ServiceWatch[] = [];
    for (const trigger of triggers) {
      const old = await this.options.jobs.watch(reg.key, trigger);
      if (
        old?.enabled &&
        old.registrationRevision === reg.revision &&
        old.minimumSaveIntervalMs === minimumSaveIntervalMs
      )
        continue;
      replacements.push({
        version: 1,
        repository: reg.key,
        registrationRevision: reg.revision,
        trigger,
        enabled: true,
        minimumSaveIntervalMs: Number(minimumSaveIntervalMs),
        observed: await this.observe(reg, trigger),
        pendingPaths: [],
        reviewPaths: [],
        cancelIds: [],
        changedAt: this.now(),
        lastSubmittedAt: 0,
      });
    }
    for (const trigger of ['stage', 'save'] as const) {
      if (!triggers.includes(trigger) || replacements.some((w) => w.trigger === trigger))
        await this.disable(reg.key, trigger);
    }
    for (const state of replacements) await this.options.jobs.writeWatch(state);
    return this.status(reg.key);
  }
  async disable(repository: string, trigger?: WatchTrigger) {
    for (const state of await this.options.jobs.watches()) {
      if (state.repository !== repository || (trigger && state.trigger !== trigger)) continue;
      // Persist revocation before cancellation, including an intent whose submit reply was lost.
      const disabled = {
        ...state,
        enabled: false,
        pendingPaths: [],
        cancelIds: [
          ...new Set(
            [...state.cancelIds, state.receiptId, state.intent?.id].filter(
              (id): id is string => !!id,
            ),
          ),
        ],
      };
      delete disabled.intent;
      await this.options.jobs.writeWatch(disabled);
      await this.flushCancellations(disabled);
    }
  }
  async status(repository: string) {
    const states = (await this.options.jobs.watches()).filter((w) => w.repository === repository);
    return Promise.all(
      states.map(async (w) => ({
        trigger: w.trigger,
        enabled: w.enabled,
        registrationRevision: w.registrationRevision,
        externalChanges: w.trigger === 'save',
        minimumSaveIntervalMs: w.minimumSaveIntervalMs,
        observedHash: w.observed.fingerprint,
        pendingFiles: w.pendingPaths.length,
        pendingUntil: w.pendingPaths.length
          ? Math.max(
              w.changedAt + 3000,
              w.trigger === 'save' ? w.lastSubmittedAt + w.minimumSaveIntervalMs : 0,
            )
          : null,
        receipt: w.receiptId ? await this.options.jobs.job(w.receiptId) : null,
        problem: w.problem ?? null,
      })),
    );
  }
  start() {
    if (this.stopped || this.timer || this.polling) return;
    const next = () => {
      this.timer = undefined;
      void this.poll()
        .then(
          () => {
            this.problem = undefined;
          },
          () => {
            this.problem = 'watch-store-unavailable';
          },
        )
        .finally(() => {
          if (!this.stopped) {
            this.timer = setTimeout(next, 2000);
            this.timer.unref?.();
          }
        });
    };
    this.timer = setTimeout(next, 0);
    this.timer.unref?.();
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.polling?.catch(() => {
      this.problem = 'watch-store-unavailable';
    });
  }
  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return (this.polling ??= this.scan().finally(() => {
      this.polling = undefined;
    }));
  }
  private async scan() {
    const { jobs, serial } = this.options;
    const states = await serial(() => jobs.watches());
    for (let state of states) {
      if (this.stopped) continue;
      try {
        state = await serial(async () => {
          const current = await jobs.watch(state.repository, state.trigger);
          return current ? this.flushCancellations(current) : state;
        });
        if (!state.enabled) continue;
        const reg = await serial(() => jobs.registration(state.repository));
        if (
          !reg ||
          reg.revision !== state.registrationRevision ||
          !reg.triggers.includes(state.trigger)
        ) {
          await serial(() => this.disable(state.repository, state.trigger));
          continue;
        }
        // Finish a durable intent before observing newer input. The same ID always
        // carries the same payload, including after a crash between submit and acknowledgement.
        state = await serial(async () => {
          const current = await jobs.watch(state.repository, state.trigger);
          if (!current || contentHash(current) !== contentHash(state)) return state;
          return this.flushIntent(current);
        });
        const observed = await this.observe(reg, state.trigger);
        const expected = state;
        const updated = await serial(async () => {
          if (this.stopped || !(await this.current(expected))) return;
          let current = structuredClone(expected);
          delete current.problem;
          const receipt = current.receiptId ? await jobs.job(current.receiptId) : undefined;
          // A budget-delayed receipt can start long after submission. Preserve
          // its actual service start in the durable Save interval as well.
          current.lastSubmittedAt = Math.max(current.lastSubmittedAt, receipt?.startedAt ?? 0);
          if (observed.fingerprint !== current.observed.fingerprint) {
            const before = new Map(current.observed.files.map((f) => [f.path, f.hash]));
            const changed = observed.files
              .filter(
                (f) =>
                  observed.head !== current.observed.head ||
                  !before.has(f.path) ||
                  before.get(f.path) !== f.hash,
              )
              .map((f) => f.path);
            const live = receipt && ['queued', 'running'].includes(receipt.state);
            const paths = new Set([
              ...current.pendingPaths,
              ...(live ? current.reviewPaths : []),
              ...changed,
            ]);
            current = {
              ...current,
              observed,
              changedAt: this.now(),
              pendingPaths: observed.files.filter((f) => paths.has(f.path)).map((f) => f.path),
              cancelIds: live
                ? [...new Set([...current.cancelIds, receipt.id])]
                : current.cancelIds,
            };
            // A removed/returned-to-base file also supersedes the old frozen input.
            await jobs.writeWatch(current);
            current = await this.flushCancellations(current);
          } else if (contentHash(current) !== contentHash(expected)) await jobs.writeWatch(current);
          return current;
        });
        if (
          !updated ||
          !updated.pendingPaths.length ||
          this.now() <
            Math.max(
              updated.changedAt + 3000,
              updated.trigger === 'save'
                ? updated.lastSubmittedAt + updated.minimumSaveIntervalMs
                : 0,
            )
        )
          continue;
        const snapshot = captureLocalSource({
          cwd: reg.root,
          kind: updated.trigger === 'stage' ? 'index' : 'working-tree',
          paths: updated.pendingPaths,
          ...(updated.trigger === 'save' ? { includeUntracked: updated.pendingPaths } : {}),
          excludePatterns: reg.options.excludePatterns,
        });
        let source: FrozenLocalSource;
        try {
          source = snapshot.freeze();
        } finally {
          snapshot.close();
        }
        const confirmed = await this.observe(reg, updated.trigger);
        if (confirmed.fingerprint !== updated.observed.fingerprint) continue;
        await serial(async () => {
          if (this.stopped || !(await this.current(updated))) return;
          if (!source.selected.length) {
            await jobs.writeWatch({ ...updated, pendingPaths: [] });
            return;
          }
          const intent = { ...updated, intent: { id: randomUUID(), source } };
          await jobs.writeWatch(intent);
          await this.flushIntent(intent);
        });
      } catch {
        await serial(async () => {
          const current = await jobs.watch(state.repository, state.trigger);
          if (
            current?.enabled &&
            current.registrationRevision === state.registrationRevision &&
            current.problem !== 'watch-observation-unavailable'
          )
            await jobs.writeWatch({ ...current, problem: 'watch-observation-unavailable' });
        });
      }
    }
  }
  private async current(expected: ServiceWatch) {
    const current = await this.options.jobs.watch(expected.repository, expected.trigger);
    const reg = await this.options.jobs.registration(expected.repository);
    return (
      current?.enabled &&
      reg?.revision === expected.registrationRevision &&
      reg.triggers.includes(expected.trigger) &&
      contentHash(current) === contentHash(expected)
    );
  }
  private async flushIntent(state: ServiceWatch) {
    if (!state.intent || !state.enabled) return state;
    const job = await this.options.jobs.submit({
      id: state.intent.id,
      repository: state.repository,
      registrationRevision: state.registrationRevision,
      trigger: state.trigger,
      watch: true,
      source: state.intent.source,
    });
    const next = {
      ...state,
      receiptId: job.id,
      lastSubmittedAt: this.now(),
      reviewPaths: state.pendingPaths,
      pendingPaths: [],
    };
    delete next.intent;
    await this.options.jobs.writeWatch(next);
    this.options.wake();
    return next;
  }
  private async flushCancellations(state: ServiceWatch) {
    if (!state.cancelIds.length) return state;
    for (const id of state.cancelIds) {
      const job = await this.options.jobs.job(id);
      if (job && ['queued', 'running'].includes(job.state)) await this.options.cancel(id);
    }
    const next = { ...state, cancelIds: [] };
    await this.options.jobs.writeWatch(next);
    return next;
  }
}
