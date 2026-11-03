/** Read-only refresh, paused in hidden tabs and serialized across timer/focus events. */
export function startVisiblePolling(
  refresh: (signal: AbortSignal) => Promise<void>,
  onError: () => void,
  intervalMs = 30_000,
) {
  const controller = new AbortController();
  let running = false;
  let timer: ReturnType<typeof setTimeout>;
  const poll = async () => {
    if (controller.signal.aborted || running) return;
    clearTimeout(timer);
    if (!document.hidden) {
      running = true;
      try {
        await refresh(controller.signal);
      } catch {
        if (!controller.signal.aborted) onError();
      } finally {
        running = false;
      }
    }
    if (!controller.signal.aborted) timer = setTimeout(() => void poll(), intervalMs);
  };
  const wake = () => void poll();
  window.addEventListener('focus', wake);
  document.addEventListener('visibilitychange', wake);
  void poll();
  return () => {
    controller.abort();
    clearTimeout(timer);
    window.removeEventListener('focus', wake);
    document.removeEventListener('visibilitychange', wake);
  };
}
