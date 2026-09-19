import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
describe('group review progress in Chrome', () => {
  let server: ViteDevServer, browser: Browser, page: Page, origin: string;
  let failResume = false,
    reader = false;
  const requests: string[] = [];
  beforeAll(async () => {
    server = await createServer({
      root: path.resolve('apps/web'),
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        {
          name: 'owned-tasks-ui',
          resolveId(id) {
            if (id === '/__tasks.js') return id;
          },
          load(id) {
            if (id === '/__tasks.js')
              return `import React from 'react';import{createRoot}from'react-dom/client';import{ReviewTaskProgress}from'/src/ReviewTaskProgress.tsx';import'/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(ReviewTaskProgress,{analysisId:'synthetic',state:'partial'}));`;
          },
          configureServer(vite) {
            vite.middlewares.use((req, res, next) => {
              if (req.url !== '/__tasks') return next();
              void vite
                .transformIndexHtml(
                  '/__tasks',
                  '<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main style="max-width:900px;margin:24px auto"><div id="root"></div></main><script type="module" src="/__tasks.js"></script></body></html>',
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
    if (!address || typeof address === 'string') throw Error('Loopback required');
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    page = await browser.newPage();
    await page.route('**/api/**', async (route) => {
      requests.push(route.request().method());
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: failResume ? 409 : 202,
          json: failResume
            ? { error: { message: 'PR head가 변경되어 재개할 수 없습니다.' } }
            : { analysisId: 'continued' },
        });
        return;
      }
      await route.fulfill({
        json: {
          planHash: 'synthetic',
          filesTotal: 1045,
          filesExcluded: 2,
          tasks: [
            { state: 'completed', count: 128, retryAt: null },
            { state: 'budget-wait', count: 281, retryAt: null },
          ],
          canResume: !reader,
          maxAdditionalModelCalls: 512,
        },
      });
    });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });
  it.each([1360, 420])(
    'shows coverage and explicit additional budget without overflow at %s px',
    async (width) => {
      await page.setViewportSize({ width, height: 700 });
      await page.goto(origin + '/__tasks');
      await page.getByText('묶음 검토 128/409', { exact: true }).waitFor();
      expect(await page.getByText('예산 대기 281', { exact: true }).count()).toBe(1);
      expect(await page.getByText(/최대 512회 추가 호출/).count()).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await mkdir('artifacts/operations/large-pr-1024-2026-09-19', { recursive: true });
      await page.screenshot({
        path: `artifacts/operations/large-pr-1024-2026-09-19/group-progress-synthetic-${width}.png`,
      });
    },
  );
  it('keeps failure visible and re-enables the button for keyboard users', async () => {
    failResume = true;
    const button = page.getByRole('button', { name: '남은 검토 재개' });
    await button.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('alert').waitFor();
    expect(await button.isEnabled()).toBe(true);
    expect(await page.getByRole('alert').innerText()).toContain('PR head');
    expect(requests.filter((method) => method === 'POST')).toHaveLength(1);
  });
  it('hides continuation from a reader', async () => {
    reader = true;
    await page.goto(origin + '/__tasks');
    await page.getByText('묶음 검토 128/409', { exact: true }).waitFor();
    expect(await page.getByRole('button', { name: '남은 검토 재개' }).count()).toBe(0);
  });
});
