import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { loadSelectedSourceHistory, historyReadRoute } from './review-history.js';
import { KnowledgeSyncError } from './central-binding.js';
import type { CentralSelection } from './central-selection.js';

const repo = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const guidanceId = '33333333-3333-4333-8333-333333333333';
const revision = 'a'.repeat(64),
  date = '2026-09-15T00:00:00.000Z';
const content = {
  summary: 'Request validation',
  detail: 'A past observation',
  recommendation: 'Check request constraints',
  categories: ['validation'],
  appliesTo: {
    languages: ['Python'],
    filePaths: ['schema.py'],
    symbols: [],
    contracts: ['Request-only validation'],
    branches: [],
  },
  counterEvidence: ['Database state belongs in service validation'],
  expiresAt: null,
};
const source = {
  id,
  pullRequestId: repo,
  kind: 'review-comment',
  authorLogin: 'reviewer',
  authorType: 'User',
  contentHash: createHash('sha256').update('Original observation').digest('hex'),
  body: 'Original observation',
  path: 'schema.py',
  line: 1,
  side: 'RIGHT',
  commitSha: null,
  inReplyToGithubId: null,
  observationHash: 'b'.repeat(64),
  htmlUrl: 'https://github.com/example/repo/pull/917#discussion_r1',
  githubCreatedAt: date,
  githubUpdatedAt: date,
  githubId: '1',
  upstreamState: 'present',
  parentId: null,
  reviewSourceId: null,
  replyCount: 0,
  lastObservedAt: date,
  provenance: null,
};
const guidance = {
  schemaVersion: 1,
  repositoryId: repo,
  id: guidanceId,
  revision: 2,
  state: 'active',
  needsReview: false,
  publicationRequested: true,
  content,
  source: {
    id,
    pullNumber: 917,
    htmlUrl: source.htmlUrl,
    contentHash: source.contentHash,
    observationHash: source.observationHash,
    upstreamState: 'present',
  },
  createdAt: date,
  reviewedAt: date,
};
const detail = { schemaVersion: 1, repositoryId: repo, revision, pullNumber: 917, item: source };
const page = {
  schemaVersion: 1,
  repositoryId: repo,
  revision,
  nextCursor: null,
  items: [],
  pull: {
    id: repo,
    number: 917,
    title: 'Historical PR',
    state: 'closed',
    htmlUrl: 'https://github.com/example/repo/pull/917',
    messageCount: 1,
    replyCount: 0,
    notReturnedCount: 0,
    coverage: {
      state: 'collected',
      lastCompleteAt: date,
      syncStartedAt: date,
      observedCount: 1,
      errorCode: null,
    },
  },
};
const selection = {
  items: [
    {
      component: 'collective',
      kind: 'memory',
      id: guidanceId,
      value: { memory: { sourceRevision: 2, content } },
    },
  ],
} as CentralSelection;

describe('source history captured for a local review', () => {
  it('uses central IDs only and keeps original source/version/counter-evidence', async () => {
    const requests: unknown[] = [];
    const result = await loadSelectedSourceHistory(selection, async (request) => {
      requests.push(request);
      return {
        data: (request.kind === 'guidance-detail'
          ? guidance
          : request.kind === 'message'
            ? detail
            : page) as never,
      };
    });
    expect(requests).toEqual([
      { kind: 'guidance-detail', guidanceId },
      { kind: 'message', pullNumber: 917, sourceId: id },
      { kind: 'messages', pullNumber: 917, parentId: id },
    ]);
    expect(result[0]).toMatchObject({
      source,
      apiRevision: revision,
      replies: [],
      repliesComplete: true,
    });
  });
  it.each(['source-changed', 'guidance-changed', 'thread-changed', 'needs-review'])(
    'omits %s instead of mixing revisions',
    async (reason) => {
      const result = await loadSelectedSourceHistory(selection, async (request) => ({
        data: (request.kind === 'guidance-detail'
          ? {
              ...guidance,
              ...(reason === 'needs-review' ? { needsReview: true } : {}),
              ...(reason === 'guidance-changed' ? { revision: 3 } : {}),
            }
          : request.kind === 'message'
            ? {
                ...detail,
                item: {
                  ...source,
                  ...(reason === 'source-changed' ? { contentHash: 'c'.repeat(64) } : {}),
                },
              }
            : {
                ...page,
                ...(reason === 'thread-changed' ? { revision: 'c'.repeat(64) } : {}),
              }) as never,
      }));
      expect(result).toEqual([]);
    },
  );
  it('keeps the base context on missing history but propagates revoked authority', async () => {
    expect(
      await loadSelectedSourceHistory(selection, async () => {
        throw new KnowledgeSyncError('unavailable', 'offline');
      }),
    ).toEqual([]);
    await expect(
      loadSelectedSourceHistory(selection, async () => {
        throw new KnowledgeSyncError('revoked', 'revoked');
      }),
    ).rejects.toMatchObject({ code: 'revoked' });
  });
  it('rejects local payload and unrelated query fields before HTTP', () => {
    expect(() => historyReadRoute(repo, { kind: 'pulls', diff: 'secret' })).toThrow();
    expect(() =>
      historyReadRoute(repo, {
        kind: 'message',
        pullNumber: 917,
        sourceId: id,
        cursor: 'unrelated',
      }),
    ).toThrow();
    expect(historyReadRoute(repo, { kind: 'guidance', sourceId: id }).route).toBe(
      `api/v1/repositories/${repo}/review-history/guidance?sourceId=${id}`,
    );
  });
});
