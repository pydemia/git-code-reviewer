import { describe, expect, it } from 'vitest';
import {
  GitHubAccessTokenClient,
  GitHubConversationLimitError,
  type PullRequestMessageObservation,
} from './index.js';
import { enrichReviewThreads, reviewGraphqlUrl } from './review-threads.js';
const target = {
  apiBaseUrl: 'https://ghes.example/prefix/api/v3/',
  installationId: 'unused',
  owner: 'team',
  name: 'repo',
};
const pageInfo = { hasNextPage: false, endCursor: null };
const provenance = {
  provider: 'github-rest' as const,
  reviewState: null,
  reviewGithubId: null,
  originalCommitSha: null,
  originalLine: null,
  startLine: null,
  originalStartLine: null,
  startSide: null,
  subjectType: null,
  diffHunk: null,
  threadResolved: null,
  threadOutdated: null,
  commentNodeId: 'comment-A',
};
const message: PullRequestMessageObservation = {
  githubId: 1,
  kind: 'review-comment',
  author: 'fixture',
  authorType: 'User',
  body: 'source',
  path: 'a.ts',
  line: 1,
  side: 'RIGHT',
  commitSha: null,
  inReplyToGithubId: null,
  url: 'https://example.invalid/1',
  createdAt: '2026-09-15T00:00:00Z',
  updatedAt: '2026-09-15T00:00:00Z',
  provenance,
};
const thread = {
  id: 'thread-A',
  isResolved: true,
  isOutdated: false,
  comments: { nodes: [{ id: 'comment-A' }], pageInfo },
};
const response = (nodes: unknown[], info = pageInfo) => ({
  data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo: info } } } },
});
describe('read-only review thread evidence', () => {
  it('derives same-origin GitHub/GHES endpoints and preserves installation prefixes', () => {
    expect(reviewGraphqlUrl(target)?.href).toBe('https://ghes.example/prefix/api/graphql');
    expect(reviewGraphqlUrl({ ...target, apiBaseUrl: 'https://api.github.com/' })?.href).toBe(
      'https://api.github.com/graphql',
    );
    for (const apiBaseUrl of [
      'http://ghes.example/api/v3',
      'https://user:secret@ghes.example/api/v3',
      'https://ghes.example/unrecognized',
      'https://ghes.example/api/v3?token=secret',
    ])
      expect(reviewGraphqlUrl({ ...target, apiBaseUrl })).toBe(null);
  });
  it('uses REST node IDs and read-only GraphQL with existing token, then records explicit booleans', async () => {
    const calls: Array<{ url: string; method: string; query?: string }> = [];
    const client = new GitHubAccessTokenClient('synthetic-token', async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        ...(init?.body ? { query: JSON.parse(String(init.body)).query } : {}),
      });
      if (url.endsWith('/graphql')) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-token');
        expect(init?.redirect).toBe('error');
        return Response.json(response([thread]));
      }
      if (url.includes('/issues/') || url.includes('/reviews')) return Response.json([]);
      return Response.json([
        {
          id: 1,
          node_id: 'comment-A',
          html_url: message.url,
          body: 'source',
          user: null,
          path: 'a.ts',
          line: 1,
          created_at: message.createdAt,
          updated_at: message.updatedAt,
        },
      ]);
    });
    const result = await client.listPullRequestMessages(target, 7);
    expect(result[0]?.provenance).toMatchObject({
      threadObservation: 'observed',
      threadId: 'thread-A',
      threadResolved: true,
      threadOutdated: false,
    });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(calls.find((c) => c.method === 'POST')?.query).toMatch(/^query ReviewThreadEvidence/);
    expect(calls.every((c) => !c.url.includes('synthetic-token'))).toBe(true);
  });
  it('paginates comments and threads with scope checks', async () => {
    let calls = 0;
    const result = await enrichReviewThreads(target, 7, [message], async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init.body));
      if (body.query.includes('query ReviewThreadComments'))
        return Response.json({
          data: {
            node: {
              ...thread,
              pullRequest: { number: 7, repository: { nameWithOwner: 'team/repo' } },
            },
          },
        });
      if (body.variables.after) return Response.json(response([]));
      return Response.json(
        response(
          [
            {
              ...thread,
              comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'comments-1' } },
            },
          ],
          { hasNextPage: true, endCursor: 'threads-1' },
        ),
      );
    });
    expect(calls).toBe(3);
    expect(result[0]?.provenance?.threadResolved).toBe(true);
  });
  it('does not treat partial data, missing PR, failed permission or changing thread state as resolution', async () => {
    for (const body of [
      { ...response([thread]), errors: [{ type: 'FORBIDDEN' }] },
      { data: { repository: null } },
      { errors: [{ type: 'undefinedField' }] },
    ]) {
      const result = await enrichReviewThreads(target, 7, [message], async () =>
        Response.json(body),
      );
      expect(result[0]?.provenance?.threadResolved).toBeNull();
      expect(result[0]?.provenance?.threadOutdated).toBeNull();
      expect(result[0]?.provenance?.threadObservation).not.toBe('observed');
    }
    const failed = await enrichReviewThreads(target, 7, [message], async () => {
      throw Error('network');
    });
    expect(failed[0]?.provenance).toMatchObject({
      threadObservation: 'unavailable',
      threadId: null,
    });
    const missing = await enrichReviewThreads(target, 7, [message], async () =>
      Response.json(response([])),
    );
    expect(missing[0]?.provenance?.threadObservation).toBe('not-observed');
  });
  it('caps pagination without claiming partial scans are complete', async () => {
    let calls = 0;
    const result = await enrichReviewThreads(target, 7, [message], async () => {
      calls++;
      return Response.json(response([], { hasNextPage: true, endCursor: String(calls) }));
    });
    expect(calls).toBe(20);
    expect(result[0]?.provenance).toMatchObject({
      threadObservation: 'partial',
      threadResolved: null,
    });
  });
  it('rejects looping cursors and mismatched paged thread scope', async () => {
    for (const mismatch of [false, true]) {
      const result = await enrichReviewThreads(target, 7, [message], async (_url, init) => {
        const body = JSON.parse(String(init.body));
        if (body.query.includes('query ReviewThreadComments'))
          return Response.json({
            data: {
              node: {
                ...thread,
                pullRequest: { number: 8, repository: { nameWithOwner: 'another/repo' } },
              },
            },
          });
        return Response.json(
          response(
            mismatch
              ? [
                  {
                    ...thread,
                    comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same' } },
                  },
                ]
              : [],
            { hasNextPage: true, endCursor: 'same' },
          ),
        );
      });
      expect(result[0]?.provenance?.threadObservation).toBe('unavailable');
    }
  });
  it('reports REST pagination exhaustion instead of silently accepting a truncated conversation', async () => {
    let pages = 0;
    const client = new GitHubAccessTokenClient('fixture', async (input) => {
      if (!String(input).includes('/issues/')) return Response.json([]);
      pages++;
      return Response.json(
        Array.from({ length: 100 }, (_, i) => ({
          id: i + 1,
          html_url: 'https://example.invalid/comment',
          body: 'body',
          user: null,
          created_at: '2026-09-15T00:00:00Z',
          updated_at: '2026-09-15T00:00:00Z',
        })),
      );
    });
    await expect(client.listPullRequestMessages(target, 7)).rejects.toBeInstanceOf(
      GitHubConversationLimitError,
    );
    expect(pages).toBe(20);
  });
});
