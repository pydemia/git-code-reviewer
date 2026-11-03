import { describe, expect, it } from 'vitest';
import { modelRateLimit } from './model-rate-limit.js';

describe('provider quota cooldown metadata', () => {
  const now = 1789782000000;
  it('honors a body-only usage reset beyond the execution deadline', async () => {
    const reset = now + 5 * 3600000;
    const value = await modelRateLimit(
      Response.json(
        {
          error: {
            type: 'usage_limit_reached',
            resets_at: reset / 1000,
            message: 'private upstream message',
          },
        },
        { status: 429, headers: { 'retry-after': '1' } },
      ),
      0,
      now,
    );
    expect(value.providerCode).toBe('usage_limit_reached');
    expect(value.retryAt.getTime()).toBeGreaterThanOrEqual(reset);
    expect(value.retryAt.getTime()).toBeLessThan(reset + 1000);
    expect(JSON.stringify(value)).not.toContain('private');
  });
  it('uses the later valid relative reset or HTTP Retry-After', async () => {
    const value = await modelRateLimit(
      Response.json(
        {
          error: {
            type: 'usage_limit_reached',
            resets_in_seconds: 7200,
          },
        },
        { status: 429, headers: { 'retry-after': new Date(now + 3 * 3600000).toUTCString() } },
      ),
      4,
      now,
    );
    expect(value.retryAt.getTime()).toBeGreaterThanOrEqual(now + 3 * 3600000);
  });
  it('backs off repeated failures without an authoritative reset', async () => {
    const first = await modelRateLimit(new Response('busy', { status: 429 }), 0, now);
    const repeated = await modelRateLimit(new Response('busy', { status: 429 }), 5, now);
    expect(first.retryAt.getTime()).toBeGreaterThanOrEqual(now + 30000);
    expect(repeated.retryAt.getTime()).toBeGreaterThanOrEqual(now + 900000);
    expect(repeated.retryAt.getTime()).toBeLessThan(now + 901000);
  });
  it('bounds unknown and oversized error bodies and rejects invalid reset values', async () => {
    for (const body of [
      JSON.stringify({ error: { type: 'unknown', resets_at: (now + 86400000) / 1000 } }),
      JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: 'tomorrow' } }),
      JSON.stringify({
        error: { type: 'usage_limit_reached', resets_at: (now + 86400000) / 1000 },
        padding: 'x'.repeat(20000),
      }),
    ]) {
      const value = await modelRateLimit(new Response(body, { status: 429 }), 0, now);
      expect(value.retryAt.getTime()).toBeLessThan(now + 31000);
    }
  });
  it('cancels a stalled error stream instead of occupying a model slot indefinitely', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    await modelRateLimit(new Response(stream, { status: 429 }), 0, now);
    expect(cancelled).toBe(true);
  });
});
