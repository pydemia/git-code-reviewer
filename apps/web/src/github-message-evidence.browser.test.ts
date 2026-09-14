import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const source = {
  id: '10000000-0000-4000-8000-000000000001',
  pullRequestId: '10000000-0000-4000-8000-000000000002',
  kind: 'review-comment',
  authorLogin: 'reviewer',
  authorType: 'User',
  body: '검토 원문',
  contentHash: 'a'.repeat(64),
  observationHash: 'b'.repeat(64),
  path: 'src/retry.ts',
  line: null,
  side: 'RIGHT',
  commitSha: 'c'.repeat(40),
  inReplyToGithubId: '19',
  htmlUrl: 'https://example.invalid/comment/20',
  githubCreatedAt: '2026-09-15T00:00:00Z',
  githubUpdatedAt: '2026-09-15T00:00:00Z',
  state: 'available',
  provenance: {
    provider: 'github-rest',
    reviewState: 'APPROVED',
    reviewGithubId: '18',
    originalLine: 42,
    originalStartLine: 40,
    originalCommitSha: 'd'.repeat(40),
    startLine: null,
    startSide: null,
    subjectType: 'line',
    diffHunk: '@@ -1 +1 @@\n+ <script>window.injected=true</script>',
    threadResolved: null,
    threadOutdated: null,
  },
};
const snapshot = {
  githubId: '20',
  kind: source.kind,
  authorLogin: source.authorLogin,
  authorType: source.authorType,
  body: '과거 원문 <script>window.injected=true</script>',
  contentHash: source.contentHash,
  path: source.path,
  line: source.line,
  side: source.side,
  commitSha: source.commitSha,
  inReplyToGithubId: source.inReplyToGithubId,
  htmlUrl: source.htmlUrl,
  githubCreatedAt: source.githubCreatedAt,
  githubUpdatedAt: source.githubUpdatedAt,
  provenance: { ...source.provenance, reviewState: 'CHANGES_REQUESTED' },
};

describe.sequential('PR message evidence in Chrome', () => {
  let server: ViteDevServer, browser: Browser, page: Page, origin: string;
  const requests: string[] = [],
    errors: string[] = [];
  let reject = false;
  beforeAll(async () => {
    server = await createServer({
      root: path.resolve('apps/web'),
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        {
          name: 'owned-pr-message-fixture',
          resolveId(id) {
            if (id === '/__pr-evidence.js') return id;
          },
          load(id) {
            if (id === '/__pr-evidence.js')
              return `import React from 'react';import {createRoot} from 'react-dom/client';
        import {GitHubMessageEvidence} from '/src/GitHubMessageEvidence.tsx';import '/src/styles.css';
        createRoot(document.getElementById('root')).render(React.createElement(GitHubMessageEvidence,{
          repositoryId:'10000000-0000-4000-8000-000000000003',pullNumber:7,source:${JSON.stringify(source)}}));`;
          },
          configureServer(vite) {
            vite.middlewares.use((req, res, next) => {
              if (req.url !== '/__pr-evidence') return next();
              void vite
                .transformIndexHtml(
                  '/__pr-evidence',
                  '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PR evidence fixture</title></head><body><main style="max-width:900px;margin:24px auto;padding:16px"><article class="memory-source"><div>검토 대화</div><div id="root"></div></article></main><script type="module" src="/__pr-evidence.js"></script></body></html>',
                )
                .then((html) => {
                  res.setHeader('content-type', 'text/html');
                  res.end(html);
                });
            });
          },
        },
      ],
    });
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw Error('loopback required');
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/**', async (route) => {
      requests.push(route.request().method() + ' ' + route.request().url());
      if (reject) return route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN' } } });
      const older = new URL(route.request().url()).searchParams.has('cursor');
      await route.fulfill({
        json: {
          schemaVersion: 1,
          sourceId: source.id,
          items: [
            {
              id: older ? '1' : '2',
              observationHash: 'a'.repeat(64),
              observedAt: '2026-09-15T00:00:00Z',
              syncStartedAt: '2026-09-15T00:00:00Z',
              snapshot: { ...snapshot, body: older ? '최초 원문' : snapshot.body },
            },
          ],
          nextCursor: older ? null : '2',
        },
      });
    });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });
  it('loads history only on disclosure, pages through evidence and renders source as inert text', async () => {
    await page.goto(origin + '/__pr-evidence');
    await page.getByText('리뷰 상태: 승인', { exact: true }).waitFor();
    expect(requests).toHaveLength(0);
    expect(await page.getByText(/현재 위치:/).textContent()).toContain('현재 줄 미확인');
    expect(await page.getByText(/원래 위치:/).textContent()).toContain(':40–42');
    const disclosure = page.getByText('수집한 변경 이력', { exact: true });
    await disclosure.focus();
    await page.keyboard.press('Enter');
    await page.getByText(/과거 원문 <script>/).waitFor();
    expect(await page.evaluate(() => 'injected' in window)).toBe(false);
    expect(requests).toHaveLength(1);
    await page.getByRole('button', { name: '이전 이력', exact: true }).click();
    await page.getByText('최초 원문', { exact: true }).waitFor();
    await page.getByRole('button', { name: '최근 이력', exact: true }).click();
    await page.getByText(/과거 원문 <script>/).waitFor();
    expect(requests.every((value) => value.startsWith('GET '))).toBe(true);
    await mkdir('artifacts/operations/P12-review-provenance', { recursive: true });
    for (const width of [1100, 420]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: `artifacts/operations/P12-review-provenance/evidence-${width}.png`,
        fullPage: true,
      });
    }
    expect(errors).toEqual([]);
  });
  it('clears loaded history on close and displays access errors without retaining prior evidence', async () => {
    const disclosure = page.getByText('수집한 변경 이력', { exact: true });
    await disclosure.click();
    reject = true;
    await disclosure.click();
    await page.getByRole('alert').waitFor();
    expect(await page.getByText(/과거 원문 <script>/).count()).toBe(0);
    reject = false;
    await page.getByRole('button', { name: '다시 시도' }).click();
    await page.getByText(/과거 원문 <script>/).waitFor();
    expect(errors).toEqual([]);
  });
});
