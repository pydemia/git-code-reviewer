import { describe, expect, it } from 'vitest';
import {
  buildPermanentFileUrl,
  FixtureGitHubClient,
  GitHubAccessTokenClient,
  GitHubRequestError,
} from './index.js';

const target = {
  installationId: '1',
  apiBaseUrl: 'https://github.example/api/v3/',
  owner: 'platform',
  name: 'reviewer-api',
};

describe('GitHub adapter', () => {
  const apiPull = (
    number: number,
    state: 'open' | 'closed' = 'open',
    mergedAt: string | null = null,
  ) => ({
    id: number,
    number,
    title: `Synthetic PR ${number}`,
    state,
    merged_at: mergedAt,
    draft: false,
    html_url: `https://github.example/org-name/repo-name/pull/${number}`,
    updated_at: '2026-09-09T00:00:00Z',
    user: { login: 'synthetic' },
    base: { sha: 'a'.repeat(40), ref: 'main' },
    head: { sha: 'b'.repeat(40), ref: 'branch' },
  });

  it('requests all PR states and preserves merged_at separately from closed state', async () => {
    const client = new GitHubAccessTokenClient('synthetic', async (input) => {
      expect(new URL(String(input)).searchParams.get('state')).toBe('all');
      return Response.json([
        apiPull(1),
        apiPull(2, 'closed'),
        apiPull(3, 'closed', '2026-09-09T00:00:00Z'),
      ]);
    });
    expect((await client.listPulls(target)).pulls).toMatchObject([
      { state: 'open', mergedAt: null },
      { state: 'closed', mergedAt: null },
      { state: 'closed', mergedAt: '2026-09-09T00:00:00Z' },
    ]);
  });

  it('does not truncate the history at the previous 20-page boundary', async () => {
    const pages: number[] = [];
    const client = new GitHubAccessTokenClient('synthetic', async (input, init) => {
      const page = Number(new URL(String(input)).searchParams.get('page'));
      pages.push(page);
      expect(new Headers(init?.headers).get('if-none-match')).toBe(page === 1 ? 'previous' : null);
      return Response.json(
        Array.from({ length: page < 21 ? 100 : 1 }, (_, i) =>
          apiPull((page - 1) * 100 + i + 1, 'closed'),
        ),
        { headers: { etag: 'first-page' } },
      );
    });
    const result = await client.listPulls(target, 'previous');
    expect(result.pulls).toHaveLength(2001);
    expect(pages).toHaveLength(21);
    expect(result.etag).toBe('first-page');
  });

  it('fails a partial fetch and preserves first-page conditional request semantics', async () => {
    let fail = true;
    const client = new GitHubAccessTokenClient('synthetic', async (input) => {
      if (!fail) return new Response(null, { status: 304 });
      return new URL(String(input)).searchParams.get('page') === '1'
        ? Response.json(Array.from({ length: 100 }, (_, i) => apiPull(i + 1)))
        : new Response(null, { status: 503 });
    });
    await expect(client.listPulls(target)).rejects.toBeInstanceOf(GitHubRequestError);
    fail = false;
    await expect(client.listPulls(target, 'etag')).resolves.toEqual({
      outcome: 'not-modified',
      etag: 'etag',
      pulls: [],
    });
  });
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
    const first = await client.listPulls(target);
    const second = await client.listPulls(target, first.etag);
    expect(first.outcome).toBe('updated');
    expect(second.outcome).toBe('not-modified');
  });

  it('uses bearer access tokens without putting them in the URL', async () => {
    let capturedUrl = '';
    let authorization = '';
    const client = new GitHubAccessTokenClient('secret-token', async (input, init) => {
      capturedUrl = String(input);
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return new Response('[]', { status: 200, headers: { etag: 'test' } });
    });
    await client.listPulls({
      installationId: 'unused',
      apiBaseUrl: 'https://github.example/api/v3/',
      owner: 'platform',
      name: 'reviewer-api',
    });
    expect(authorization).toBe('Bearer secret-token');
    expect(capturedUrl).not.toContain('secret-token');
    await expect(client.getGitCredential()).resolves.toEqual({
      username: 'git-code-reviewer',
      password: 'secret-token',
    });
  });

  it('collects PR conversation, review summaries, and inline review comments', async () => {
    const client = new GitHubAccessTokenClient('secret-token', async (input) => {
      const url = String(input);
      if (url.includes('/issues/7/comments')) {
        return Response.json([
          {
            id: 11,
            html_url: 'https://github.example/platform/reviewer-api/pull/7#issuecomment-11',
            body: '재시도 키는 유지해 주세요.',
            user: { login: 'minseo', type: 'User' },
            created_at: '2026-09-08T01:00:00Z',
            updated_at: '2026-09-08T01:00:00Z',
          },
        ]);
      }
      if (url.includes('/pulls/7/reviews')) {
        return Response.json([
          {
            id: 12,
            html_url: 'https://github.example/platform/reviewer-api/pull/7#pullrequestreview-12',
            body: '이 설계로 진행해도 됩니다.',
            user: { login: 'jaehyun', type: 'User' },
            commit_id: 'd91b7a4f19af10fcb571cefb2d8a61495166c11a',
            submitted_at: '2026-09-08T01:01:00Z',
          },
        ]);
      }
      return Response.json([
        {
          id: 13,
          html_url: 'https://github.example/platform/reviewer-api/pull/7#discussion_r13',
          body: '이 분기에서는 timeout을 다시 적용해야 합니다.',
          user: { login: 'sora', type: 'User' },
          path: 'src/retry.ts',
          line: 42,
          side: 'RIGHT',
          commit_id: 'd91b7a4f19af10fcb571cefb2d8a61495166c11a',
          in_reply_to_id: null,
          created_at: '2026-09-08T01:02:00Z',
          updated_at: '2026-09-08T01:03:00Z',
        },
      ]);
    });

    await expect(client.listPullRequestMessages(target, 7)).resolves.toMatchObject([
      { githubId: 11, kind: 'issue-comment', author: 'minseo' },
      { githubId: 12, kind: 'review', author: 'jaehyun' },
      { githubId: 13, kind: 'review-comment', path: 'src/retry.ts', line: 42 },
    ]);
  });

  it('preserves empty submitted review states, exact bodies and original positions without inventing resolution', async () => {
    const client = new GitHubAccessTokenClient('test-token', async (input) => {
      if (String(input).includes('/issues/7/comments')) return Response.json([]);
      if (String(input).includes('/pulls/7/reviews'))
        return Response.json([
          {
            id: 20,
            html_url: 'https://github.example/review/20',
            body: '',
            user: null,
            state: 'APPROVED',
            submitted_at: '2026-09-08T01:00:00Z',
          },
          {
            id: 21,
            html_url: 'https://github.example/review/21',
            body: null,
            user: null,
            state: 'DISMISSED',
            submitted_at: '2026-09-08T01:01:00Z',
          },
          {
            id: 22,
            html_url: 'https://github.example/review/22',
            body: 'private draft',
            user: null,
            state: 'PENDING',
          },
        ]);
      return Response.json([
        {
          id: 23,
          html_url: 'https://github.example/comment/23',
          body: '  preserve whitespace\n',
          user: null,
          path: 'src/retry.ts',
          line: null,
          original_line: 42,
          original_start_line: 40,
          start_line: null,
          side: 'RIGHT',
          original_commit_id: 'a'.repeat(40),
          commit_id: 'b'.repeat(40),
          pull_request_review_id: 20,
          in_reply_to_id: 19,
          diff_hunk: '@@ -1 +1 @@\n+ code',
          created_at: '2026-09-08T01:02:00Z',
          updated_at: '2026-09-08T01:03:00Z',
        },
      ]);
    });
    const messages = await client.listPullRequestMessages(target, 7);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      body: '',
      provenance: { reviewState: 'APPROVED', reviewGithubId: '20' },
    });
    expect(messages[1]).toMatchObject({ body: '', provenance: { reviewState: 'DISMISSED' } });
    expect(messages[2]).toMatchObject({
      body: '  preserve whitespace\n',
      line: null,
      inReplyToGithubId: 19,
      provenance: {
        originalLine: 42,
        originalStartLine: 40,
        originalCommitSha: 'a'.repeat(40),
        reviewGithubId: '20',
        threadResolved: null,
        threadOutdated: null,
      },
    });
    expect(messages.some((m) => m.githubId === 22)).toBe(false);
  });

  it('creates a managed PR timeline comment when none exists', async () => {
    const calls: Array<{ url: string; method: string; body: string | null }> = [];
    const client = new GitHubAccessTokenClient('secret-token', async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      if (String(input).endsWith('/pulls/7'))
        return Response.json({
          number: 7,
          state: 'open',
          head: { sha: 'b'.repeat(40) },
          base: { repo: { full_name: 'platform/reviewer-api' } },
        });
      if ((init?.method ?? 'GET') === 'GET') return Response.json([]);
      return Response.json(
        {
          id: 91,
          html_url: 'https://github.example/platform/reviewer-api/pull/7#issuecomment-91',
          body: '<!-- managed -->\n검토 결과',
        },
        { status: 201 },
      );
    });

    await expect(
      client.upsertPullRequestComment(target, {
        pullNumber: 7,
        expectedHeadSha: 'b'.repeat(40),
        marker: '<!-- managed -->',
        body: '<!-- managed -->\n검토 결과',
      }),
    ).resolves.toEqual({
      commentId: 91,
      commentUrl: 'https://github.example/platform/reviewer-api/pull/7#issuecomment-91',
      outcome: 'created',
    });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'POST']);
    expect(calls[0]!.url).toContain('/repos/platform/reviewer-api/issues/7/comments');
    expect(calls[2]!.body).toContain('검토 결과');
  });

  it('updates the stored comment without listing the PR timeline', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const client = new GitHubAccessTokenClient('secret-token', async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      if (String(input).endsWith('/pulls/7'))
        return Response.json({
          number: 7,
          state: 'open',
          head: { sha: 'b'.repeat(40) },
          base: { repo: { full_name: 'platform/reviewer-api' } },
        });
      return Response.json({
        id: 91,
        html_url: 'https://github.example/platform/reviewer-api/pull/7#issuecomment-91',
        body: '<!-- managed -->\n새 검토 결과',
      });
    });

    const result = await client.upsertPullRequestComment(target, {
      pullNumber: 7,
      expectedHeadSha: 'b'.repeat(40),
      marker: '<!-- managed -->',
      body: '<!-- managed -->\n새 검토 결과',
      existingCommentId: 91,
    });
    expect(result.outcome).toBe('updated');
    expect(calls).toEqual([
      { method: 'GET', url: 'https://github.example/api/v3/repos/platform/reviewer-api/pulls/7' },
      {
        method: 'PATCH',
        url: 'https://github.example/api/v3/repos/platform/reviewer-api/issues/comments/91',
      },
    ]);
  });

  it('recovers a managed comment after a crash before its id was persisted', async () => {
    const methods: string[] = [];
    const client = new GitHubAccessTokenClient('secret-token', async (_input, init) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (String(_input).endsWith('/pulls/7'))
        return Response.json({
          number: 7,
          state: 'open',
          head: { sha: 'b'.repeat(40) },
          base: { repo: { full_name: 'platform/reviewer-api' } },
        });
      if (method === 'GET') {
        return Response.json([
          {
            id: 34,
            html_url: 'https://github.example/platform/reviewer-api/pull/7#issuecomment-34',
            body: '<!-- managed -->\n이전 검토 결과',
          },
        ]);
      }
      return Response.json({
        id: 34,
        html_url: 'https://github.example/platform/reviewer-api/pull/7#issuecomment-34',
        body: '<!-- managed -->\n최신 검토 결과',
      });
    });

    const result = await client.upsertPullRequestComment(target, {
      pullNumber: 7,
      expectedHeadSha: 'b'.repeat(40),
      marker: '<!-- managed -->',
      body: '<!-- managed -->\n최신 검토 결과',
    });
    expect(result).toMatchObject({ commentId: 34, outcome: 'updated' });
    expect(methods).toEqual(['GET', 'GET', 'PATCH']);
  });

  it('classifies missing write permission as a non-retryable GitHub error', async () => {
    const client = new GitHubAccessTokenClient('read-only-token', async () =>
      Response.json(
        { message: 'Resource not accessible by personal access token' },
        { status: 403 },
      ),
    );
    await expect(
      client.upsertPullRequestComment(target, {
        pullNumber: 7,
        expectedHeadSha: 'b'.repeat(40),
        marker: '<!-- managed -->',
        body: '<!-- managed -->\n검토 결과',
      }),
    ).rejects.toMatchObject<Partial<GitHubRequestError>>({ status: 403, retryable: false });
  });
});
