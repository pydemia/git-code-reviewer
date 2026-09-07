import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { loadAnalysisWorkspace } from './api.ts';

afterEach(() => vi.unstubAllGlobals());

it('loads an in-progress revision and diff without requesting a missing report', async () => {
  const repositoryId = randomUUID(),
    analysisId = randomUUID(),
    snapshotId = randomUUID(),
    fileId = randomUUID();
  const analysis = {
    id: analysisId,
    snapshotId,
    revision: 1,
    state: 'analyzing',
    stage: 'unit-comment-block',
    progress: 35,
    createdAt: new Date().toISOString(),
    resolution: 'exact',
    mergeBaseSha: 'a'.repeat(40),
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
  };
  const pull = {
    schemaVersion: 1,
    repositoryId,
    owner: 'owner',
    name: 'repo',
    webBaseUrl: 'https://github.example',
    id: randomUUID(),
    number: 2,
    title: 'Review in progress',
    state: 'open',
    draft: false,
    author: 'author',
    htmlUrl: 'https://github.example/owner/repo/pull/2',
    baseRef: 'main',
    headRef: 'feature',
    baseSha: analysis.baseSha,
    headSha: analysis.headSha,
    updatedAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
  };
  const file = {
    id: fileId,
    path: 'src/main.ts',
    previousPath: null,
    status: 'modified',
    additions: 1,
    deletions: 1,
    patch: '@@ -1 +1 @@\n-old\n+new',
  };
  const responses: Record<string, unknown> = {
    [`/api/v1/analyses/${analysisId}/status`]: {
      schemaVersion: 1,
      repositoryId,
      pullNumber: 2,
      analysis,
    },
    [`/api/v1/repositories/${repositoryId}/pulls/2`]: pull,
    [`/api/v1/repositories/${repositoryId}/pulls/2/analyses`]: {
      schemaVersion: 1,
      items: [analysis],
    },
    [`/api/v1/snapshots/${snapshotId}/files`]: { schemaVersion: 1, snapshotId, items: [file] },
    [`/api/v1/snapshots/${snapshotId}/diff`]: {
      schemaVersion: 1,
      patch: file.patch,
      files: [file],
    },
    [`/api/v1/snapshots/${snapshotId}/commits`]: { schemaVersion: 1, commits: [] },
  };
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const value = responses[String(url)];
    if (!value) throw Error(`Unexpected request: ${url}`);
    return Response.json(value);
  });
  vi.stubGlobal('fetch', fetcher);
  const workspace = await loadAnalysisWorkspace(analysisId, new AbortController().signal);
  expect(workspace.report).toBeNull();
  expect(workspace.analysis?.state).toBe('analyzing');
  expect(workspace.diff?.files[0]?.patch).toContain('+new');
  expect(workspace.files[0]?.path).toBe('src/main.ts');
  expect(fetcher.mock.calls.some(([url]) => String(url) === `/api/v1/analyses/${analysisId}`)).toBe(
    false,
  );
});
