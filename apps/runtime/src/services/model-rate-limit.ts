/** Read only bounded quota metadata; never retain a provider's error body or message. */
export async function modelRateLimit(response: Response, failures: number, now = Date.now()) {
  let error: Record<string, unknown> = {};
  const reader = response.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const timer = setTimeout(() => void reader.cancel().catch(() => {}), 1000);
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 16384) break;
        chunks.push(next.value);
      }
      if (size <= 16384) {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (
          value &&
          typeof value === 'object' &&
          'error' in value &&
          value.error &&
          typeof value.error === 'object' &&
          !Array.isArray(value.error)
        )
          error = value.error as Record<string, unknown>;
      }
    } catch {
      // Missing/malformed metadata falls back to conservative backoff.
    } finally {
      clearTimeout(timer);
      void reader.cancel().catch(() => {});
    }
  }
  const raw = response.headers.get('retry-after')?.trim();
  const seconds = raw && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : null;
  const headerTime = seconds !== null ? now + seconds * 1000 : raw ? Date.parse(raw) : NaN;
  const providerCode =
    error.type === 'usage_limit_reached' || error.code === 'usage_limit_reached'
      ? 'usage_limit_reached'
      : null;
  const reset = providerCode && typeof error.resets_at === 'number' ? error.resets_at * 1000 : NaN;
  const relative =
    providerCode && typeof error.resets_in_seconds === 'number'
      ? now + error.resets_in_seconds * 1000
      : NaN;
  // Recent failures are persisted in the account ledger, so a worker restart cannot
  // turn a repeated 429 into another first attempt. Server deadlines are never capped.
  const backoff = Math.min(900000, 30000 * 2 ** Math.min(5, Math.max(0, failures)));
  const until = Math.max(
    now + backoff,
    ...[headerTime, reset, relative].filter(
      (value) => Number.isFinite(value) && value > now && value < 8.64e15 - 1000,
    ),
  );
  return { retryAt: new Date(until + Math.floor(Math.random() * 1000)), providerCode };
}
