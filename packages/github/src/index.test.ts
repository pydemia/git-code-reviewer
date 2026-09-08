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
    const first = await client.listOpenPulls(target);
    const second = await client.listOpenPulls(target, first.etag);
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
    await client.listOpenPulls({
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

  it('creates a managed PR timeline comment when none exists', async () => {
    const calls: Array<{ url: string; method: string; body: string | null }> = [];
    const client = new GitHubAccessTokenClient('secret-token', async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
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
        marker: '<!-- managed -->',
        body: '<!-- managed -->\n검토 결과',
      }),
    ).resolves.toEqual({
      commentId: 91,
      commentUrl: 'https://github.example/platform/reviewer-api/pull/7#issuecomment-91',
      outcome: 'created',
    });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    expect(calls[0]!.url).toContain('/repos/platform/reviewer-api/issues/7/comments');
    expect(calls[1]!.body).toContain('검토 결과');
  });

  it('updates the stored comment without listing the PR timeline', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const client = new GitHubAccessTokenClient('secret-token', async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return Response.json({
        id: 91,
        html_url: 'https://github.example/platform/reviewer-api/pull/7#issuecomment-91',
        body: '<!-- managed -->\n새 검토 결과',
      });
    });

    const result = await client.upsertPullRequestComment(target, {
      pullNumber: 7,
      marker: '<!-- managed -->',
      body: '<!-- managed -->\n새 검토 결과',
      existingCommentId: 91,
    });
    expect(result.outcome).toBe('updated');
    expect(calls).toEqual([
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
      marker: '<!-- managed -->',
      body: '<!-- managed -->\n최신 검토 결과',
    });
    expect(result).toMatchObject({ commentId: 34, outcome: 'updated' });
    expect(methods).toEqual(['GET', 'PATCH']);
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
        marker: '<!-- managed -->',
        body: '<!-- managed -->\n검토 결과',
      }),
    ).rejects.toMatchObject<Partial<GitHubRequestError>>({ status: 403, retryable: false });
  });
});
