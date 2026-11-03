/** Debounced, serial automatic work. The host owns authorization and source capture;
 * this scheduler fences obsolete completions and leaves manual execution priority. */
export interface AutomaticTask<T> {
  key: string;
  generation: number;
  value: T;
  signal: AbortSignal;
  isCurrent(): boolean;
}
export interface AutomaticState {
  key: string;
  phase: 'waiting' | 'running' | 'finished' | 'failed' | 'cancelled';
  reason?: string;
  retryAt?: number;
}
interface Pending<T> {
  key: string;
  generation: number;
  value: T;
  at: number;
  priority: number;
}
export class AutomaticReviewScheduler<T> {
  private pending = new Map<string, Pending<T>>();
  private generations = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private active?: { key: string; controller: AbortController; promise: Promise<void> };
  private stopped = false;
  constructor(
    private readonly options: {
      run(task: AutomaticTask<T>): Promise<void | { retryAt?: number }>;
      busy?(): boolean;
      onState?(state: AutomaticState): void;
      now?(): number;
    },
  ) {}
  private now() {
    return (this.options.now ?? Date.now)();
  }
  submit(key: string, value: T, options: { debounceMs?: number; priority?: number } = {}) {
    if (this.stopped) return;
    const debounce = options.debounceMs ?? 3000;
    if (!Number.isFinite(debounce) || debounce < 0 || debounce > 3600000)
      throw Error('Invalid automatic review debounce');
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    if (this.active?.key === key) this.active.controller.abort('superseded');
    const at = this.now() + debounce;
    this.pending.set(key, { key, generation, value, at, priority: options.priority ?? 0 });
    this.options.onState?.({ key, phase: 'waiting', reason: 'debounce', retryAt: at });
    this.wake();
  }
  cancel(key: string) {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.pending.delete(key);
    if (this.active?.key === key) this.active.controller.abort('cancelled');
    this.options.onState?.({ key, phase: 'cancelled' });
    this.wake();
  }
  clear() {
    for (const key of this.generations.keys()) this.cancel(key);
  }
  dispose() {
    this.stopped = true;
    this.clear();
    clearTimeout(this.timer);
  }
  async settled() {
    await this.active?.promise;
  }
  wake() {
    clearTimeout(this.timer);
    if (this.stopped || this.active || !this.pending.size) return;
    const next = Math.min(...[...this.pending.values()].map((p) => p.at));
    this.timer = setTimeout(
      () => this.drain(),
      Math.max(0, next - this.now(), this.options.busy?.() ? 1000 : 0),
    );
    this.timer.unref?.();
  }
  private drain() {
    if (this.stopped || this.active) return;
    if (this.options.busy?.()) {
      this.wake();
      return;
    }
    const now = this.now();
    const next = [...this.pending.values()]
      .filter((p) => p.at <= now)
      .sort((a, b) => b.priority - a.priority || a.at - b.at)[0];
    if (!next) {
      this.wake();
      return;
    }
    this.pending.delete(next.key);
    const controller = new AbortController();
    const current = () =>
      !this.stopped &&
      !controller.signal.aborted &&
      this.generations.get(next.key) === next.generation;
    const active = { key: next.key, controller, promise: Promise.resolve() };
    this.active = active;
    active.promise = Promise.resolve().then(async () => {
      if (!current()) return;
      this.options.onState?.({ key: next.key, phase: 'running' });
      try {
        const result = await this.options.run({
          ...next,
          signal: controller.signal,
          isCurrent: current,
        });
        if (!current()) return;
        if (
          result?.retryAt &&
          Number.isSafeInteger(result.retryAt) &&
          result.retryAt > this.now()
        ) {
          this.pending.set(next.key, { ...next, at: result.retryAt });
          this.options.onState?.({
            key: next.key,
            phase: 'waiting',
            reason: 'budget',
            retryAt: result.retryAt,
          });
        } else this.options.onState?.({ key: next.key, phase: 'finished' });
      } catch {
        if (current()) this.options.onState?.({ key: next.key, phase: 'failed' });
      } finally {
        if (this.active === active) delete this.active;
        this.wake();
      }
    });
  }
}
