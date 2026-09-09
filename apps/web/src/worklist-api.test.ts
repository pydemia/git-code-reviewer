import { afterEach, expect, it, vi } from 'vitest';
import { loadWorklist } from './api.ts';

const repositoryId = '11111111-1111-4111-8111-111111111111';
const repository = {
  id: repositoryId,
  githubId: '1',
  tenantId: repositoryId,
  tenantSlug: 'default',
  tenantName: 'Default',
  owner: 'org-name',
  name: 'repo-name',
  webBaseUrl: 'https://github.example',
  lastPolledAt: '2026-09-09T00:00:00Z',
  nextPollAt: null,
  pollOutcome: 'updated',
  pollError: null,
};
const row = (number: number) => ({
  id: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
  number,
  title: `PR ${number}`,
  state: 'closed',
  mergedAt: number === 2 ? '2026-09-09T00:00:00Z' : null,
  draft: false,
  author: 'synthetic',
  htmlUrl: `https://github.example/org-name/repo-name/pull/${number}`,
  baseRef: 'main',
  baseSha: 'a'.repeat(40),
  headRef: 'branch',
  headSha: 'b'.repeat(40),
  updatedAt: '2026-09-09T00:00:00Z',
  observedAt: '2026-09-09T00:00:00Z',
  latestAnalysisId: null,
  analysisState: null,
  grade: null,
  attentionCount: 0,
});
afterEach(() => vi.unstubAllGlobals());

it('loads every filtered page and keeps merged rows, counts and poll health', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(url);
    if (url.startsWith('/api/v1/repositories?'))
      return Response.json({
        schemaVersion: 1,
        items: [{ ...repository, pollOutcome: 'failed', pollError: 'GITHUB_REQUEST_FAILED' }],
        nextCursor: null,
      });
    expect(url).toContain('state=closed');
    const next = url.includes('cursor=100');
    return Response.json({
      schemaVersion: 1,
      repositoryId,
      items: [row(next ? 2 : 1)],
      counts: { open: 3, closed: 2, all: 5 },
      nextCursor: next ? null : '100',
    });
  });
  const result = await loadWorklist(new AbortController().signal, repositoryId, 'closed');
  expect(result.items).toHaveLength(2);
  expect(result.items[0]!.mergedAt).not.toBeNull();
  expect(result).toMatchObject({
    counts: { open: 3, closed: 2, all: 5 },
    syncErrors: 1,
    pendingSync: 0,
  });
  expect(requests).toHaveLength(3);
});

it('rejects repeated pagination instead of looping or showing partial success', async () => {
  vi.stubGlobal('fetch', async (url: string) =>
    url === '/api/v1/repositories'
      ? Response.json({ schemaVersion: 1, items: [repository], nextCursor: null })
      : Response.json({ schemaVersion: 1, repositoryId, items: [row(1)], nextCursor: '100' }),
  );
  await expect(loadWorklist(new AbortController().signal, undefined, 'all')).rejects.toThrow(
    'pagination',
  );
});
