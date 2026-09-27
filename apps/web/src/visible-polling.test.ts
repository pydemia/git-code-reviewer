import { afterEach, expect, it, vi } from 'vitest';
import { startVisiblePolling } from './visible-polling.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('refreshes visible data on timer and focus, skips hidden tabs, and aborts on disposal', async () => {
  vi.useFakeTimers();
  const windowTarget = new EventTarget(),
    documentTarget = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('window', windowTarget);
  vi.stubGlobal('document', documentTarget);
  const refresh = vi.fn(async (signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
    }),
    error = vi.fn();
  const stop = startVisiblePolling(refresh, error);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  documentTarget.hidden = true;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  documentTarget.hidden = false;
  documentTarget.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledTimes(3);
  windowTarget.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledTimes(4);
  stop();
  expect(refresh.mock.calls[0]![0].aborted).toBe(true);
  windowTarget.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(refresh).toHaveBeenCalledTimes(4);
  expect(error).not.toHaveBeenCalled();
});
it('never overlaps focus/timer requests and reports failure without starting model work', async () => {
  vi.useFakeTimers();
  const windowTarget = new EventTarget();
  vi.stubGlobal('window', windowTarget);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  let reject!: (error: Error) => void;
  const refresh = vi.fn(
    () =>
      new Promise<void>((_resolve, rejectRequest) => {
        reject = rejectRequest;
      }),
  );
  const error = vi.fn(),
    stop = startVisiblePolling(refresh, error);
  windowTarget.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  reject(Error('offline'));
  await vi.advanceTimersByTimeAsync(0);
  expect(error).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  stop();
  reject(Error('aborted'));
  await vi.advanceTimersByTimeAsync(0);
  expect(error).toHaveBeenCalledTimes(1);
});
