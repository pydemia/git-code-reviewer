import { afterEach, expect, it, vi } from 'vitest';
import { KnowledgeSyncLoop, type KnowledgeSyncState } from './knowledge-sync-loop.js';
import { KnowledgeSyncError } from './central-binding.js';
afterEach(() => vi.useRealTimers());
it('does no work until started, synchronizes periodically with jitter, and stops without more requests', async () => {
  vi.useFakeTimers();
  const synchronize = vi.fn(async () => {});
  const loop = new KnowledgeSyncLoop({ synchronize, random: () => 0 });
  await vi.advanceTimersByTimeAsync(600000);
  expect(synchronize).not.toHaveBeenCalled();
  loop.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(synchronize).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(224999);
  expect(synchronize).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(synchronize).toHaveBeenCalledTimes(2);
  loop.stop();
  await vi.advanceTimersByTimeAsync(600000);
  expect(synchronize).toHaveBeenCalledTimes(2);
});
it('backs off identity/network failures, caps retries, and resets after authenticated recovery', async () => {
  vi.useFakeTimers();
  const states: KnowledgeSyncState[] = [];
  let fail = true;
  const synchronize = vi.fn(async () => {
    if (fail) throw new KnowledgeSyncError('identity-unavailable', 'Unavailable');
  });
  const loop = new KnowledgeSyncLoop({
    synchronize,
    onState: (state) => states.push(state),
    random: () => 0.5,
  });
  loop.start();
  await vi.advanceTimersByTimeAsync(0);
  for (const milliseconds of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    const before = synchronize.mock.calls.length;
    loop.wake();
    await vi.advanceTimersByTimeAsync(milliseconds - 1);
    expect(synchronize).toHaveBeenCalledTimes(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(synchronize).toHaveBeenCalledTimes(before + 1);
  }
  fail = false;
  await vi.advanceTimersByTimeAsync(60000);
  expect(states.at(-1)).toEqual({ phase: 'ready' });
  fail = true;
  await vi.advanceTimersByTimeAsync(300000);
  expect(states.at(-1)).toEqual({
    phase: 'waiting',
    reason: 'identity-unavailable',
    retryAt: Date.now() + 1000,
  });
  loop.stop();
});
it.each(['revoked', 'authentication-required', 'incompatible', 'invalid-manifest'] as const)(
  'stops automatic retries on %s',
  async (code) => {
    vi.useFakeTimers();
    const synchronize = vi.fn(async () => {
      throw new KnowledgeSyncError(code, 'Rejected');
    });
    const states: KnowledgeSyncState[] = [];
    const loop = new KnowledgeSyncLoop({ synchronize, onState: (s) => states.push(s) });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    loop.wake();
    await vi.advanceTimersByTimeAsync(3600000);
    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toEqual({ phase: 'stopped', reason: code });
  },
);
it('coalesces wake events and aborts an in-flight request when deselected', async () => {
  vi.useFakeTimers();
  let abort: AbortSignal | undefined;
  const synchronize = vi.fn((signal: AbortSignal) => {
    abort = signal;
    return new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
  });
  const loop = new KnowledgeSyncLoop({ synchronize });
  loop.start();
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 10; i++) loop.wake();
  await vi.advanceTimersByTimeAsync(600000);
  expect(synchronize).toHaveBeenCalledTimes(1);
  loop.stop();
  await loop.settled();
  expect(abort?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(600000);
  expect(synchronize).toHaveBeenCalledTimes(1);
});
it('resynchronizes on wake after sleep and absorbs observer exceptions', async () => {
  vi.useFakeTimers();
  const synchronize = vi.fn(async () => {});
  const loop = new KnowledgeSyncLoop({
    synchronize,
    onState: () => {
      throw Error('UI disposed');
    },
  });
  loop.start();
  await vi.advanceTimersByTimeAsync(30000);
  loop.wake();
  loop.wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(synchronize).toHaveBeenCalledTimes(2);
  loop.wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(synchronize).toHaveBeenCalledTimes(2);
  loop.stop();
});
it('waits for an aborted owner to settle before restarting', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  let first = true;
  const synchronize = vi.fn(async () => {
    if (first) {
      first = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
  });
  const loop = new KnowledgeSyncLoop({ synchronize });
  loop.start();
  await vi.advanceTimersByTimeAsync(0);
  loop.stop();
  loop.start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(synchronize).toHaveBeenCalledTimes(1);
  release();
  await loop.settled();
  await vi.advanceTimersByTimeAsync(0);
  expect(synchronize).toHaveBeenCalledTimes(2);
  loop.stop();
});
