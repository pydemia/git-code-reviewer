import type { Database, DatabaseClient } from '@gcr/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixtureGitHubClient } from '@gcr/github';
import { startPollScheduler } from './repositories.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('poll scheduler leadership', () => {
  it('retries the advisory lock after the previous server releases it', async () => {
    vi.useFakeTimers();
    const first = candidate(false);
    const second = candidate(true);
    const database = {
      connect: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Database;
    const logger = { info: vi.fn(), error: vi.fn() };

    const stop = await startPollScheduler(database, new FixtureGitHubClient(), logger);
    expect(database.connect).toHaveBeenCalledTimes(1);
    expect(first.release).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(database.connect).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      { component: 'poll-scheduler' },
      'poll scheduler leadership acquired',
    );

    await stop();
    expect(second.query).toHaveBeenLastCalledWith('select pg_advisory_unlock($1)', [746_278_432]);
    expect(second.release).toHaveBeenCalledOnce();
  });
});

function candidate(acquired: boolean) {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ acquired }] }),
    release: vi.fn(),
  } as unknown as DatabaseClient;
}
