import { randomUUID } from 'node:crypto';
import { sourcePath } from '@gcr/client-contract';
import { contentHash } from './local-identity.js';
import {
  observeAutomaticRepository,
  observeAutomaticWorkingTree,
  observeAutomaticFile,
  newlyStagedPaths,
  type AutomaticIndexChange,
} from './automatic-source.js';
import { captureLocalSource, type FrozenLocalSource } from './source-snapshot.js';
import { LocalServiceError, type ServiceJobs, type ServiceRegistration } from './service-jobs.js';

export type WatchTrigger = 'stage' | 'save';
interface Observation {
  head: string | null;
  fingerprint: string;
  files: Array<{ path: string; hash: string | null }>;
  index?: AutomaticIndexChange[];
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
  externalChanges?: boolean;
  editor?: {
    autoSave: boolean;
    sessions: Array<{ id: string; pid: number }>;
    events: Array<{ path: string; hash: string | null; allowed: boolean }>;
    unclassified: string[];
    transition?: { at: number; kind: 'attached' | 'clean-detach' | 'process-exit' };
  };
}
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function editorSession(input: unknown): { id: string; pid: number; autoSave: boolean } {
  const value = input as { id: string; pid: number; autoSave: boolean };
  if (
    !value ||
    !uuidPattern.test(value.id) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.autoSave !== 'boolean'
  )
    throw new LocalServiceError('service-invalid');
  return { id: value.id, pid: value.pid, autoSave: value.autoSave };
}
function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
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
  if (input.observed.index !== undefined) {
    if (
      input.trigger !== 'stage' ||
      !Array.isArray(input.observed.index) ||
      input.observed.index.length !== input.observed.files.length
    )
      throw new LocalServiceError('service-invalid');
    for (const change of input.observed.index) {
      sourcePath(change.path);
      if (
        !/^[AMDTU]$/.test(change.status) ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(change.oldOid) ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(change.oid) ||
        !/^\d{6}$/.test(change.oldMode) ||
        !/^\d{6}$/.test(change.mode) ||
        !input.observed.files.some(
          (file) => file.path === change.path && file.hash === contentHash(change),
        )
      )
        throw new LocalServiceError('service-invalid');
    }
  }
  for (const file of [...input.pendingPaths, ...input.reviewPaths]) sourcePath(file);
  if (input.externalChanges !== undefined && typeof input.externalChanges !== 'boolean')
    throw new LocalServiceError('service-invalid');
  if (input.editor) {
    if (
      input.trigger !== 'save' ||
      typeof input.editor.autoSave !== 'boolean' ||
      !Array.isArray(input.editor.sessions) ||
      input.editor.sessions.length > 16 ||
      !Array.isArray(input.editor.events) ||
      input.editor.events.length > 512 ||
      !Array.isArray(input.editor.unclassified) ||
      input.editor.unclassified.length > 512
    )
      throw new LocalServiceError('service-invalid');
    for (const session of input.editor.sessions)
      editorSession({ ...session, autoSave: input.editor.autoSave });
    for (const event of input.editor.events) {
      sourcePath(event.path);
      if (
        typeof event.allowed !== 'boolean' ||
        (event.hash !== null && !/^[a-f0-9]{64}$/.test(event.hash))
      )
        throw new LocalServiceError('service-invalid');
    }
    input.editor.unclassified.forEach((file) => sourcePath(file));
  }
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
      index: index.changes,
    };
  }
  // Configure/status/disable are called from inside the service mutation queue.
  async configure(
    reg: ServiceRegistration,
    input: {
      triggers: unknown;
      externalChanges?: unknown;
      minimumSaveIntervalMs?: unknown;
      editor?: unknown;
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
    const editor = input.editor === undefined ? undefined : editorSession(input.editor);
    if (editor && (!triggers.includes('save') || !processAlive(editor.pid)))
      throw new LocalServiceError('service-denied');
    if (
      triggers.some((t) => !reg.triggers.includes(t)) ||
      (triggers.includes('save') && input.externalChanges !== true && !editor)
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
      if (trigger === 'save' && !editor && old?.editor?.sessions.length)
        throw new LocalServiceError('service-busy');
      if (
        old?.enabled &&
        old.registrationRevision === reg.revision &&
        old.minimumSaveIntervalMs === minimumSaveIntervalMs &&
        (trigger !== 'save' ||
          ((old.externalChanges ?? true) === (input.externalChanges === true) &&
            old.editor?.autoSave === editor?.autoSave))
      ) {
        if (editor && trigger === 'save') {
          const sessions = old.editor!.sessions.filter((session) => session.id !== editor.id);
          const next = {
            ...old,
            editor: {
              ...old.editor!,
              sessions: [...sessions, { id: editor.id, pid: editor.pid }],
              transition: { at: this.now(), kind: 'attached' as const },
            },
          };
          await this.options.jobs.writeWatch(next);
        }
        continue;
      }
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
        externalChanges: trigger === 'save' && input.externalChanges === true,
        ...(trigger === 'save' && editor
          ? {
              editor: {
                autoSave: editor.autoSave,
                sessions: [{ id: editor.id, pid: editor.pid }],
                events: [],
                unclassified: [],
                transition: { at: this.now(), kind: 'attached' as const },
              },
            }
          : {}),
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
        externalChanges: w.trigger === 'save' && (w.externalChanges ?? true),
        editorSessions: w.editor?.sessions.length ?? 0,
        editorTransition: w.editor?.transition ?? null,
        unclassifiedFiles: w.editor?.unclassified ?? [],
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
  /** Editor events carry hashes, never document text. All methods use the service mutation queue. */
  async editorSave(
    reg: ServiceRegistration,
    input: { sessionId: unknown; file: unknown; hash?: unknown; reason: unknown },
  ) {
    const state = await this.editorState(reg, input.sessionId);
    const file = sourcePath(input.file);
    if (!['manual', 'auto', 'external', 'dirty'].includes(String(input.reason)))
      throw new LocalServiceError('service-invalid');
    const observed = await observeAutomaticFile(reg.root, file, reg.options.excludePatterns);
    if (!observed) return { status: 'excluded' };
    if (input.reason !== 'dirty' && input.hash !== observed.hash) return { status: 'superseded' };
    const allowed =
      input.reason === 'manual' ||
      (input.reason === 'auto' && state.editor!.autoSave) ||
      (input.reason === 'external' && state.externalChanges === true);
    const previous = state.editor!.events.find((event) => event.path === file);
    if (input.reason !== 'dirty' && previous?.hash === observed.hash)
      return { status: 'unchanged' };
    const events = [
      ...state.editor!.events.filter((event) => event.path !== file),
      { path: file, hash: observed.hash, allowed },
    ];
    const pending = new Set(state.pendingPaths);
    if (allowed && observed.changed) pending.add(file);
    else pending.delete(file);
    const receipt = state.receiptId ? await this.options.jobs.job(state.receiptId) : undefined;
    const cancel =
      receipt && ['queued', 'running'].includes(receipt.state) && state.reviewPaths.includes(file);
    const next: ServiceWatch = {
      ...state,
      changedAt: this.now(),
      pendingPaths: [...pending].sort(),
      editor: {
        ...state.editor!,
        events,
        unclassified: state.editor!.unclassified.filter((p) => p !== file),
      },
      cancelIds: [
        ...new Set([
          ...state.cancelIds,
          ...(cancel ? [receipt.id] : []),
          ...(state.intent ? [state.intent.id] : []),
        ]),
      ],
    };
    delete next.intent;
    await this.options.jobs.writeWatch(next);
    await this.flushCancellations(next);
    return { status: allowed && observed.changed ? 'pending' : 'suppressed' };
  }
  async detachEditor(reg: ServiceRegistration, sessionId: unknown) {
    const state = await this.editorState(reg, sessionId);
    const observed = await this.observe(reg, 'save');
    // Observe under the guard before releasing it. Writes not classified by the
    // editor during shutdown cannot become retrospective external Save requests.
    const next = await this.applyObservation(state, observed);
    next.editor!.sessions = next.editor!.sessions.filter((session) => session.id !== sessionId);
    next.editor!.transition = { at: this.now(), kind: 'clean-detach' };
    await this.options.jobs.writeWatch(next);
    return this.status(reg.key);
  }
  private async editorState(reg: ServiceRegistration, sessionId: unknown) {
    const state = await this.options.jobs.watch(reg.key, 'save');
    const session = state?.editor?.sessions.find((s) => s.id === sessionId);
    if (
      !state?.enabled ||
      state.registrationRevision !== reg.revision ||
      !reg.triggers.includes('save') ||
      !session ||
      !processAlive(session.pid)
    )
      throw new LocalServiceError('service-denied');
    return state;
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
          return this.applyObservation(expected, observed);
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
  private async applyObservation(expected: ServiceWatch, observed: Observation) {
    let current = structuredClone(expected);
    delete current.problem;
    const receipt = current.receiptId ? await this.options.jobs.job(current.receiptId) : undefined;
    current.lastSubmittedAt = Math.max(current.lastSubmittedAt, receipt?.startedAt ?? 0);
    const guarded = !!current.editor?.sessions.length;
    const external = current.trigger === 'stage' || (!guarded && (current.externalChanges ?? true));
    const events = new Map(current.editor?.events.map((event) => [event.path, event]) ?? []);
    const before = new Map(current.observed.files.map((file) => [file.path, file.hash]));
    const changed = observed.files.filter(
      (file) =>
        observed.head !== current.observed.head ||
        !before.has(file.path) ||
        before.get(file.path) !== file.hash,
    );
    if (current.editor) {
      const alive = current.editor.sessions.filter((session) => processAlive(session.pid));
      if (alive.length !== current.editor.sessions.length) {
        current.editor.unclassified = [
          ...new Set([
            ...current.editor.unclassified,
            ...changed
              .filter((file) => events.get(file.path)?.hash !== file.hash)
              .map((file) => file.path),
          ]),
        ];
        current.editor.sessions = alive;
        current.editor.transition = { at: this.now(), kind: 'process-exit' };
      }
    }
    if (observed.fingerprint !== current.observed.fingerprint) {
      const live = receipt && ['queued', 'running'].includes(receipt.state);
      let added = changed.map((file) => file.path);
      if (current.trigger === 'stage' && observed.head === current.observed.head) {
        const reg = await this.options.jobs.registration(current.repository);
        if (!reg) throw new LocalServiceError('service-denied');
        // Older watches retained hashes only. Establish immutable-blob history
        // once; preserve already pending work without guessing the missing delta.
        added =
          current.observed.index && observed.index
            ? await newlyStagedPaths(
                { ...current.observed, root: reg.root, changes: current.observed.index },
                { ...observed, root: reg.root, changes: observed.index },
              )
            : [];
      }
      const paths = new Set([
        ...current.pendingPaths,
        ...(live && (current.trigger !== 'stage' || added.length) ? current.reviewPaths : []),
        ...(external ? added : []),
      ]);
      const pendingIntent = current.intent?.id;
      delete current.intent;
      current = {
        ...current,
        observed,
        changedAt: this.now(),
        pendingPaths: observed.files
          .filter(
            (file) =>
              paths.has(file.path) &&
              (external ||
                (events.get(file.path)?.allowed && events.get(file.path)?.hash === file.hash)),
          )
          .map((file) => file.path),
        cancelIds: [
          ...new Set([
            ...current.cancelIds,
            ...(live ? [receipt.id] : []),
            ...(pendingIntent ? [pendingIntent] : []),
          ]),
        ],
      };
      if (external && current.editor)
        current.editor.unclassified = current.editor.unclassified.filter(
          (file) => !changed.some((f) => f.path === file),
        );
      await this.options.jobs.writeWatch(current);
      current = await this.flushCancellations(current);
    } else {
      if (current.trigger === 'stage' && !current.observed.index && observed.index)
        current.observed = observed;
      if (contentHash(current) !== contentHash(expected))
        await this.options.jobs.writeWatch(current);
    }
    return current;
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
