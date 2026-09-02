import { describe, expect, it } from 'vitest';
import { buildPermanentFileUrl, FixtureGitHubClient } from './index.js';

describe('GitHub adapter', () => {
  it('builds exact-SHA file links from trusted components', () => {
    expect(
      buildPermanentFileUrl(
        'https://github.example.internal',
        'platform',
        'reviewer-api',
        'd91b7a4f19af10fcb571cefb2d8a61495166c11a',
        'src/auth/session token.ts',
        118,
        132,
      ),
    ).toBe(
      'https://github.example.internal/platform/reviewer-api/blob/d91b7a4f19af10fcb571cefb2d8a61495166c11a/src/auth/session%20token.ts#L118-L132',
    );
  });

  it('rejects traversal and abbreviated SHAs', () => {
    expect(() =>
      buildPermanentFileUrl('https://github.example', 'o', 'r', 'abc123', '../secret'),
    ).toThrow();
  });

  it('honors fixture etags', async () => {
    const client = new FixtureGitHubClient();
    const target = {
      installationId: '1',
      apiBaseUrl: 'https://github.example/api/v3/',
      owner: 'platform',
      name: 'reviewer-api',
    };
    const first = await client.listOpenPulls(target);
    const second = await client.listOpenPulls(target, first.etag);
    expect(first.outcome).toBe('updated');
    expect(second.outcome).toBe('not-modified');
  });
});
