import type { Database, DatabaseClient } from '@gcr/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixtureGitHubClient } from '@gcr/github';
import { loadConfig } from '../config.js';
import { createGitHubReader, startPollScheduler } from './repositories.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('GitHub reader selection', () => {
  it('uses repository credentials instead of a global reader in registry mode', async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://example.invalid/reviewer',
      GITHUB_MODE: 'registry',
      CREDENTIAL_REGISTRY_ENABLED: 'true',
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
    });

    await expect(createGitHubReader(config)).resolves.toBeNull();
  });
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
