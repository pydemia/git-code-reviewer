import { describe, expect, it } from 'vitest';
import { mapConcurrent } from './concurrency.js';

describe('bounded analysis pool', () => {
  it.each([0, 5, 1.5, NaN])('rejects invalid concurrency %s', async (value) => {
    await expect(mapConcurrent([1], value, async (n) => n)).rejects.toThrow('concurrency');
  });
  it('does not return on failure until active work is drained or start queued work', async () => {
    const started: number[] = [],
      finished: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const result = mapConcurrent([0, 1, 2, 3], 2, async (n) => {
      started.push(n);
      if (n === 0) throw Error('worker_draining');
      await gate;
      finished.push(n);
      return n;
    }).catch((error) => {
      settled = true;
      throw error;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(result).rejects.toThrow('worker_draining');
    expect(started).toEqual([0, 1]);
    expect(finished).toEqual([1]);
  });
});
