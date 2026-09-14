import { afterEach, expect, it, vi } from 'vitest';
import { AutomaticReviewScheduler } from './automatic-scheduler.js';
afterEach(() => vi.useRealTimers());
it('debounces each worktree independently and gives ready stage work priority', async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  const scheduler = new AutomaticReviewScheduler<string>({
    run: async (task) => {
      calls.push(task.value);
    },
  });
  for (let i = 0; i < 10; i++) scheduler.submit('a/save', String(i));
  scheduler.submit('b/stage', 'stage', { priority: 1 });
  await vi.advanceTimersByTimeAsync(2999);
  expect(calls).toEqual([]);
  await vi.advanceTimersByTimeAsync(2);
  expect(calls).toEqual(['stage', '9']);
  scheduler.dispose();
});
it('waits for manual work without discarding the pending automatic source', async () => {
  vi.useFakeTimers();
  let busy = true;
  const run = vi.fn(async () => {});
  const scheduler = new AutomaticReviewScheduler({ run, busy: () => busy });
  scheduler.submit('repo', 'latest');
  await vi.advanceTimersByTimeAsync(5000);
  expect(run).not.toHaveBeenCalled();
  busy = false;
  scheduler.wake();
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(1);
  scheduler.dispose();
});
it('cancels obsolete work and does not publish its late completion or overlap its replacement', async () => {
  vi.useFakeTimers();
  const states: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const seen: Array<{ value: number; signal: AbortSignal; isCurrent(): boolean }> = [];
  const scheduler = new AutomaticReviewScheduler<number>({
    run: async (task) => {
      seen.push(task);
      if (task.value === 1) await gate;
    },
    onState: (s) => {
      states.push(`${s.key}:${s.phase}`);
    },
  });
  scheduler.submit('repo', 1);
  await vi.advanceTimersByTimeAsync(3000);
  expect(seen).toHaveLength(1);
  scheduler.submit('repo', 2);
  expect(seen[0]!.signal.aborted).toBe(true);
  expect(seen[0]!.isCurrent()).toBe(false);
  await vi.advanceTimersByTimeAsync(3000);
  expect(seen).toHaveLength(1);
  release();
  await scheduler.settled();
  await vi.advanceTimersByTimeAsync(1);
  expect(seen.map((t) => t.value)).toEqual([1, 2]);
  expect(states.filter((s) => s.endsWith(':finished'))).toHaveLength(1);
  scheduler.dispose();
});
it('keeps only the latest source while waiting for a durable budget retry and stops on pause', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const calls: string[] = [];
  const scheduler = new AutomaticReviewScheduler<string>({
    run: async (task) => {
      calls.push(task.value);
      return { retryAt: Date.now() + 600000 };
    },
  });
  scheduler.submit('repo', 'a');
  await vi.advanceTimersByTimeAsync(3000);
  expect(calls).toEqual(['a']);
  scheduler.submit('repo', 'b');
  await vi.advanceTimersByTimeAsync(3000);
  expect(calls).toEqual(['a', 'b']);
  scheduler.clear();
  await vi.advanceTimersByTimeAsync(900000);
  expect(calls).toEqual(['a', 'b']);
  scheduler.dispose();
});
