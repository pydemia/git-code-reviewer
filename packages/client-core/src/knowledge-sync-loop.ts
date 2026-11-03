import { KnowledgeSyncError } from './central-binding.js';

export type KnowledgeSyncState =
  | { phase: 'syncing' | 'ready' }
  | {
      phase: 'waiting' | 'stopped';
      reason: KnowledgeSyncError['code'] | 'local-storage';
      retryAt?: number;
    };

/** The host creates a loop only for an explicitly selected, trusted online
 * connection. This loop performs synchronization only, never model execution. */
export class KnowledgeSyncLoop {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private running: Promise<void> = Promise.resolve();
  private active = false;
  private failures = 0;
  private lastStarted = -Infinity;
  private readonly interval: number;
  constructor(
    private readonly options: {
      synchronize(signal: AbortSignal): Promise<unknown>;
      onState?(state: KnowledgeSyncState): void;
      intervalMs?: number;
      random?: () => number;
    },
  ) {
    this.interval = options.intervalMs ?? 300000;
    if (!Number.isInteger(this.interval) || this.interval < 1000 || this.interval > 86400000)
      throw new KnowledgeSyncError('invalid-binding', 'Invalid synchronization interval.');
  }
  start() {
    if (this.active) return;
    this.active = true;
    this.failures = 0;
    if (!this.controller) this.schedule(0);
  }
  /** Window focus after sleep or network recovery may bring synchronization
   * forward, but focus storms cannot overlap or bypass the retry backoff. */
  wake() {
    if (!this.active || this.controller || this.failures > 0) return;
    if (Date.now() - this.lastStarted >= 30000) this.schedule(0);
  }
  stop() {
    this.active = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }
  async settled() {
    await this.running;
  }
  private emit(state: KnowledgeSyncState) {
    try {
      this.options.onState?.(state);
    } catch {
      /* UI observers cannot change synchronization. */
    }
  }
  private jitter(milliseconds: number) {
    const random = this.options.random?.() ?? Math.random();
    const fraction = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0.5;
    return Math.round(milliseconds * (0.75 + fraction * 0.5));
  }
  private schedule(milliseconds: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.run();
    }, milliseconds);
    this.timer.unref?.();
  }
  private async run() {
    if (!this.active || this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    this.lastStarted = Date.now();
    this.emit({ phase: 'syncing' });
    try {
      await this.options.synchronize(controller.signal);
      if (!this.active || controller.signal.aborted) return;
      this.failures = 0;
      this.emit({ phase: 'ready' });
      this.schedule(this.jitter(this.interval));
    } catch (cause) {
      if (!this.active || controller.signal.aborted) return;
      const reason = cause instanceof KnowledgeSyncError ? cause.code : 'local-storage';
      if (
        ['unavailable', 'identity-unavailable', 'timeout', 'busy', 'superseded'].includes(reason)
      ) {
        const milliseconds = this.jitter(Math.min(60000, 1000 * 2 ** Math.min(this.failures++, 6)));
        this.emit({ phase: 'waiting', reason, retryAt: Date.now() + milliseconds });
        this.schedule(milliseconds);
      } else {
        this.active = false;
        this.emit({ phase: 'stopped', reason });
      }
    } finally {
      this.controller = undefined;
      if (this.active && controller.signal.aborted) this.schedule(0);
    }
  }
}
