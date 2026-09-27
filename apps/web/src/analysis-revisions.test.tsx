import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { AnalysisRevisionSelect } from './AnalysisRevisionSelect.tsx';
import { loadAnalysisRevisions, type AnalysisRevision } from './api.ts';

afterEach(() => vi.unstubAllGlobals());
function revision(
  pullRevision: number,
  scope: 'collective' | 'personal' = 'collective',
): AnalysisRevision {
  return {
    id: randomUUID(),
    snapshotId: randomUUID(),
    revision: 1,
    pullRevision,
    revisionScope: scope,
    state: pullRevision === 3 ? 'analyzing' : 'partial',
    stage: null,
    progress: 0,
    createdAt: new Date().toISOString(),
    resolution: 'exact',
    mergeBaseSha: 'a'.repeat(40),
    baseSha: 'a'.repeat(40),
    headSha: String(pullRevision).repeat(40),
  };
}

it('shows PR sequence, commit and honest state, with an explicit link from historical to latest analysis', () => {
  const analyses = [revision(3), revision(2), revision(1)];
  const html = renderToStaticMarkup(
    <AnalysisRevisionSelect analyses={analyses} current={analyses[1]!} />,
  );
  expect(html).toContain('aria-label="분석 revision 선택"');
  expect(html).toContain('Revision 3 · 33333333 · 분석 중');
  expect(html).toContain('Revision 2 · 22222222 · 일부 검토');
  expect(html).toContain(`href="/reviews/${analyses[0]!.id}"`);
  expect(html).toContain(`value="${analyses[1]!.id}" selected=""`);
  expect(
    renderToStaticMarkup(<AnalysisRevisionSelect analyses={analyses} current={analyses[0]!} />),
  ).not.toContain('latest-revision-link');
  expect(
    renderToStaticMarkup(
      <AnalysisRevisionSelect analyses={[revision(1, 'personal')]} current={null} />,
    ),
  ).toContain('개인 Revision 1');
});

it('loads every authorized history page and rejects repeated cursors', async () => {
  const newer = revision(101),
    older = revision(1);
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    Response.json({
      schemaVersion: 1,
      items: String(url).includes('?cursor=') ? [older] : [newer],
      nextCursor: String(url).includes('?cursor=') ? null : newer.id,
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  expect(await loadAnalysisRevisions(randomUUID(), 1, new AbortController().signal)).toEqual([
    newer,
    older,
  ]);
  expect(fetcher.mock.calls).toHaveLength(2);
  expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  fetcher.mockImplementation(async () =>
    Response.json({ schemaVersion: 1, items: [newer], nextCursor: newer.id }),
  );
  await expect(
    loadAnalysisRevisions(randomUUID(), 1, new AbortController().signal),
  ).rejects.toThrow('cursor did not advance');
});

it('does not continue history requests after cancellation', async () => {
  const controller = new AbortController(),
    item = revision(3);
  const fetcher = vi.fn<typeof fetch>(async () => {
    controller.abort();
    return Response.json({ schemaVersion: 1, items: [item], nextCursor: item.id });
  });
  vi.stubGlobal('fetch', fetcher);
  await expect(loadAnalysisRevisions(randomUUID(), 1, controller.signal)).rejects.toThrow(
    'Aborted',
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});
