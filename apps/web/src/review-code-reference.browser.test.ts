import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { beforeAll, afterAll, it, expect } from 'vitest';

let server: ViteDevServer, browser: Browser, origin: string;
beforeAll(async () => {
  server = await createServer({
    root: path.resolve('apps/web'),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'code-reference-fixture',
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url !== '/__reference') return next();
            void vite
              .transformIndexHtml(
                '/__reference',
                `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main style="max-width:760px;margin:24px auto;padding:12px"><h1>코드 참조 검증 · 합성 자료</h1><div id="root"></div></main><script type="module">
        import React from 'react';import{createRoot}from'react-dom/client';import{ReviewCodeReference}from'/src/ReviewCodeReference.tsx';import{parseReviewDiff}from'/src/review-diff.ts';import'/src/styles.css';
        createRoot(document.getElementById('root')).render(React.createElement(ReviewCodeReference,{path:'src/very-long-directory-name/authorization/check-permissions.ts',commit:'${'a'.repeat(40)}',href:'https://github.example/org/repo/blob/${'a'.repeat(40)}/src/check.ts#L12-L13',side:'head',start:12,end:13,lines:parseReviewDiff('@@ -10,4 +10,4 @@\\n export function authorize(user, resource) {\\n-  return true;\\n+  const allowed = user.permissions.includes(resource.permission);${' '.repeat(3)}// ${'long content '.repeat(20)}\\n+  if (!allowed) throw new Error("Forbidden");\\n   return allowed;\\n }')}));</script></body></html>`,
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
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});
it.each([1360, 420])(
  'renders file and line references with keyboard scrolling at %s px',
  async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 700 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(origin + '/__reference');
      const figure = page.getByRole('figure');
      await figure.waitFor();
      await expect.poll(() => figure.locator('.referenced-line').count()).toBe(2);
      const link = figure.getByRole('link');
      await link.focus();
      expect(await link.getAttribute('href')).toContain('/blob/' + 'a'.repeat(40));
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.className)).toBe(
        'review-code-reference-scroll',
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        await page
          .locator('.review-code-reference-scroll')
          .evaluate((e) => e.scrollWidth > e.clientWidth),
      ).toBe(true);
      expect(errors).toEqual([]);
      await mkdir('artifacts/operations/usage-code-view-2026-09-19', { recursive: true });
      await page.screenshot({
        path: `artifacts/operations/usage-code-view-2026-09-19/code-reference-synthetic-${width}.png`,
      });
    } finally {
      await page.close();
    }
  },
);
