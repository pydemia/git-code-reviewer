import { describe, it, expect, vi } from 'vitest';
import { GitHubAccessTokenClient, GitHubPublicationSupersededError } from './index.js';
const target = {
  installationId: '1',
  apiBaseUrl: 'https://github.example/api/v3/',
  owner: 'team',
  name: 'repo',
};
const input = {
  pullNumber: 4,
  expectedHeadSha: 'a'.repeat(40),
  marker: '<!-- managed -->',
  body: '<!-- managed --> review',
  existingCommentId: 10,
};
const pull = () => ({
  number: 4,
  state: 'open',
  head: { sha: input.expectedHeadSha },
  base: { repo: { full_name: 'team/repo' } },
});
const comment = { id: 10, html_url: 'https://github.example/comment/10', body: input.body };
describe('publication freshness at the remote write boundary', () => {
  it.each(['head-changed', 'pull-closed'])(
    'refuses %s before updating a stored comment',
    async (reason) => {
      const current = pull();
      if (reason === 'head-changed') current.head.sha = 'b'.repeat(40);
      else current.state = 'closed';
      const calls: RequestInit[] = [];
      const client = new GitHubAccessTokenClient('fixture', async (_url, init) => {
        calls.push(init!);
        return Response.json(current);
      });
      await expect(client.upsertPullRequestComment(target, input)).rejects.toMatchObject({
        reason,
      });
      expect(calls.map((c) => c.method)).toEqual(['GET']);
      expect(new Headers(calls[0]!.headers).get('cache-control')).toBe('no-cache');
      expect(calls[0]!.signal).toBeDefined();
      expect(new Headers(calls[0]!.headers).has('if-none-match')).toBe(false);
    },
  );
  it.each([
    null,
    { ...pull(), number: 5 },
    { ...pull(), base: { repo: { full_name: 'other/repo' } } },
    { ...pull(), head: { sha: 'short' } },
  ])('refuses malformed or foreign remote responses', async (response) => {
    const fetch = vi.fn(async () => Response.json(response));
    const client = new GitHubAccessTokenClient('fixture', fetch);
    await expect(client.upsertPullRequestComment(target, input)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([304, 401, 403, 404, 429, 503])(
    'never writes when the fresh head read returns %s',
    async (status) => {
      const fetch = vi.fn(async () => new Response(null, { status }));
      const client = new GitHubAccessTokenClient('fixture', fetch);
      await expect(client.upsertPullRequestComment(target, input)).rejects.toThrow();
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
  it('rechecks after a missing stored comment and refuses a changed head during recovery', async () => {
    const calls: string[] = [];
    let heads = 0;
    const client = new GitHubAccessTokenClient('fixture', async (url, init) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${new URL(String(url)).pathname}`);
      if (String(url).endsWith('/pulls/4')) {
        const r = pull();
        if (++heads === 2) r.head.sha = 'b'.repeat(40);
        return Response.json(r);
      }
      if (method === 'PATCH') return Response.json({}, { status: 404 });
      return Response.json([]);
    });
    await expect(client.upsertPullRequestComment(target, input)).rejects.toMatchObject({
      reason: 'head-changed',
    });
    expect(calls.map((c) => c.split(' ')[0])).toEqual(['GET', 'PATCH', 'GET', 'GET']);
  });
  it('checks local ownership after each head read, including comment recovery', async () => {
    const calls: string[] = [];
    const client = new GitHubAccessTokenClient('fixture', async (url, init) => {
      const method = init?.method ?? 'GET';
      calls.push(method);
      if (String(url).endsWith('/pulls/4')) return Response.json(pull());
      if (method === 'PATCH') return Response.json({}, { status: 404 });
      if (method === 'POST') return Response.json(comment);
      return Response.json([]);
    });
    const beforeWrite = vi.fn(async () => {});
    await expect(
      client.upsertPullRequestComment(target, { ...input, beforeWrite }),
    ).resolves.toMatchObject({ outcome: 'created' });
    expect(beforeWrite).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(['GET', 'PATCH', 'GET', 'GET', 'POST']);
  });
  it('does not write after local target revocation during the head read', async () => {
    const fetch = vi.fn(async () => Response.json(pull()));
    const client = new GitHubAccessTokenClient('fixture', fetch);
    await expect(
      client.upsertPullRequestComment(target, {
        ...input,
        beforeWrite: async () => {
          throw new GitHubPublicationSupersededError('target-changed');
        },
      }),
    ).rejects.toMatchObject({ reason: 'target-changed' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('requires a full expected SHA before any request', async () => {
    const fetch = vi.fn(async () => Response.json(pull()));
    const client = new GitHubAccessTokenClient('fixture', fetch);
    await expect(
      client.upsertPullRequestComment(target, { ...input, expectedHeadSha: '' }),
    ).rejects.toThrow('full expected');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not create a duplicate when marker recovery reaches its pagination limit', async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        Array.from({ length: 100 }, (_, i) => ({
          id: i + 1,
          body: 'unrelated',
          html_url: 'https://github.example/comment/' + (i + 1),
        })),
      ),
    );
    const client = new GitHubAccessTokenClient('fixture', fetch);
    await expect(
      client.upsertPullRequestComment(target, { ...input, existingCommentId: null }),
    ).rejects.toThrow('pagination limit');
    expect(fetch).toHaveBeenCalledTimes(20);
  });
  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid stored comment id %s before requests',
    async (id) => {
      const fetch = vi.fn(async () => Response.json(pull()));
      const client = new GitHubAccessTokenClient('fixture', fetch);
      await expect(
        client.upsertPullRequestComment(target, { ...input, existingCommentId: id }),
      ).rejects.toThrow('safe comment ID');
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
