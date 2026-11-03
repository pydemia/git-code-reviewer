import { describe, expect, it, vi } from 'vitest';
import { clientIdentity, reviewExecution, type OfflineBehavior } from '@gcr/client-contract';
import { resolveReviewExecution } from './review-execution.js';
import { KnowledgeSyncError } from './central-binding.js';
import type { CentralConnections } from './central-connection.js';
import { contentHash } from './local-identity.js';
const local = {
  mode: 'standalone' as const,
  profileId: 'profile',
  repositoryKey: 'a'.repeat(64),
  worktreeKey: 'b'.repeat(64),
};
const id = 'c'.repeat(64);
const audience = { serverId: 'server', tenantId: 'tenant', repositoryId: 'repo', userId: 'alice' };
const failure = (code: KnowledgeSyncError['code']) =>
  new KnowledgeSyncError(code, 'Synthetic failure');
function access(freshness: 'online' | 'offline') {
  return {
    client: { ...local, mode: 'centralized', audience },
    freshness,
    assertConnection: async () => {},
    cache: {
      binding: { id, audience },
      read: async () => ({ lastSynchronizedAt: Date.parse('2026-09-14T00:00:00.000Z') }),
    },
  } as Awaited<ReturnType<CentralConnections['review']>>;
}
const input = (offlineBehavior: OfflineBehavior = 'cache-then-standalone') => ({
  client: local,
  configuredMode: 'centralized' as const,
  connectionId: id,
  offlineBehavior,
});
describe('review execution fallback', () => {
  it('standalone never opens a central connection and retains its ordinary identity', async () => {
    const central = vi.fn(async () => access('online'));
    const result = await resolveReviewExecution({
      client: local,
      configuredMode: 'standalone',
      central,
    });
    expect(central).not.toHaveBeenCalled();
    expect(result.client.execution).toEqual({
      configuredMode: 'standalone',
      effectiveMode: 'standalone',
      knowledgeSource: 'local',
      fallbackReason: null,
    });
  });
  it.each(['cache-then-standalone', 'cache-only', 'standalone', 'pause'] as const)(
    'keeps verified online knowledge under %s',
    async (policy) => {
      const result = await resolveReviewExecution({
        ...input(policy),
        central: async (freshness) => access(freshness),
      });
      expect(result.client.mode).toBe('centralized');
      expect(result.execution.knowledgeSource).toBe('central-online');
      expect(result.execution.fallbackReason).toBeNull();
    },
  );
  it.each(['cache-then-standalone', 'cache-only'] as const)(
    'uses only an authorized offline cache under %s during transport outage',
    async (policy) => {
      const requests: string[] = [];
      const result = await resolveReviewExecution({
        ...input(policy),
        central: async (freshness) => {
          requests.push(freshness);
          if (freshness === 'online') throw failure('unavailable');
          return access(freshness);
        },
      });
      expect(requests).toEqual(['online', 'offline']);
      expect(result.client.mode).toBe('centralized');
      expect(result.execution.knowledgeSource).toBe('central-cache');
      expect(result.execution.fallbackReason).toBe('unavailable');
      expect(result.execution.lastSynchronizedAt).toBe('2026-09-14T00:00:00.000Z');
    },
  );
  it('standalone policy never tries central cache after failure', async () => {
    const central = vi.fn(async () => {
      throw failure('unavailable');
    });
    const result = await resolveReviewExecution({ ...input('standalone'), central });
    expect(central).toHaveBeenCalledTimes(1);
    expect(result.client.mode).toBe('standalone');
    expect(result.central).toBeUndefined();
    expect('audience' in result.client).toBe(false);
    expect(result.execution.lastSynchronizedAt).toBeUndefined();
  });
  it.each([
    'identity-unavailable',
    'revoked',
    'authentication-required',
    'invalid-manifest',
    'incompatible',
  ] as const)('does not turn %s into cached authorization', async (code) => {
    const central = vi.fn(async () => {
      throw failure(code);
    });
    const result = await resolveReviewExecution({ ...input(), central });
    expect(central).toHaveBeenCalledTimes(1);
    expect(result.client.mode).toBe('standalone');
    expect(result.execution.fallbackReason).toBe(code);
    await expect(resolveReviewExecution({ ...input('cache-only'), central })).rejects.toMatchObject(
      { code },
    );
  });
  it('uses local knowledge if the offline cache is expired or incomplete', async () => {
    const result = await resolveReviewExecution({
      ...input(),
      central: async (freshness) => {
        if (freshness === 'online') throw failure('unavailable');
        const value = access(freshness);
        value.cache.read = async () => {
          throw failure('invalid-manifest');
        };
        return value;
      },
    });
    expect(result.client.mode).toBe('standalone');
    expect(result.execution.fallbackReason).toBe('invalid-manifest');
  });
  it.each(['busy', 'superseded', 'cancelled', 'invalid-binding'] as const)(
    'never falls back on %s',
    async (code) => {
      await expect(
        resolveReviewExecution({
          ...input(),
          central: async () => {
            throw failure(code);
          },
        }),
      ).rejects.toMatchObject({ code });
    },
  );
  it('does not fallback for cancellation disguised as a transport timeout or for storage corruption', async () => {
    const abort = new AbortController();
    await expect(
      resolveReviewExecution({
        ...input(),
        signal: abort.signal,
        central: async () => {
          abort.abort();
          throw failure('timeout');
        },
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    const corrupt = new Error('Corrupt storage');
    await expect(
      resolveReviewExecution({
        ...input(),
        central: async () => {
          throw corrupt;
        },
      }),
    ).rejects.toBe(corrupt);
  });
  it('rejects a cross-profile connection rather than starting fallback', async () => {
    await expect(
      resolveReviewExecution({
        ...input(),
        central: async (freshness) => {
          const value = access(freshness);
          value.client.profileId = 'other';
          return value;
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid-binding' });
  });
  it('records a different identity for fallback and rejects inconsistent execution labels', async () => {
    const fallback = await resolveReviewExecution({
      ...input(),
      central: async () => {
        throw failure('unavailable');
      },
    });
    const standalone = await resolveReviewExecution({
      client: local,
      configuredMode: 'standalone',
    });
    expect(contentHash(fallback.client)).not.toBe(contentHash(standalone.client));
    expect(() => clientIdentity({ ...fallback.client, mode: 'centralized', audience })).toThrow();
    expect(() =>
      reviewExecution({ ...fallback.execution, knowledgeSource: 'central-online' }),
    ).toThrow();
    expect(() => reviewExecution({ ...fallback.execution, fallbackReason: null })).toThrow();
  });
});
