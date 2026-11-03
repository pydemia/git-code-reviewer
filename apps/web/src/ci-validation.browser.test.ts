import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CiValidationView } from '@gcr/contracts';

const analysisId = 'd84921da-c1af-4f42-aaef-520206c46808';
const otherId = 'a0b5e6e5-9d32-4866-90a3-c14897a650a4';
const evidence: CiValidationView = {
  schemaVersion: 1,
  analysisId,
  observedAt: '2026-09-15T00:00:00.000Z',
  status: 'verified',
  reason: '서명과 분석 입력이 일치합니다.',
  input: null,
  evidence: [
    {
      checkRunId: '201',
      runId: '101',
      attempt: 1,
      issuer: 'https://ci.example/issuer',
      keyId: 'owned',
      payloadHash: 'a'.repeat(64),
      issuedAt: '2026-09-14T23:59:00.000Z',
      expiresAt: '2026-09-15T01:00:00.000Z',
      checks: [
        {
          id: 'regression',
          name: '권한 회귀 검사',
          outcome: 'failed',
          command: 'pnpm test',
          expected: 'exit 0',
          actual: '<script>window.injected=true</script> ' + 'LongCIOutput'.repeat(30),
          exitCode: 1,
        },
      ],
    },
  ],
  rejected: [{ checkRunId: '202', reason: 'input-mismatch' }],
};
describe.sequential('central CI evidence in Chrome', () => {
  let server: ViteDevServer, browser: Browser, page: Page, origin: string;
  const requests: string[] = [],
    errors: string[] = [];
  let reject = false,
    delayed = false,
    release: (() => void) | undefined;
  beforeAll(async () => {
    server = await createServer({
      root: path.resolve('apps/web'),
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        {
          name: 'owned-ci-ui',
          resolveId(id) {
            if (id === '/__ci.js') return id;
          },
          load(id) {
            if (id === '/__ci.js')
              return `import React from 'react';import {createRoot} from 'react-dom/client';import {CiValidationEvidence} from '/src/CiValidationEvidence.tsx';import '/src/styles.css';const root=createRoot(document.getElementById('root'));window.showCI=(id)=>root.render(React.createElement(CiValidationEvidence,{key:id,analysisId:id}));window.showCI('${analysisId}');`;
          },
          configureServer(vite) {
            vite.middlewares.use((req, res, next) => {
              if (req.url !== '/__ci') return next();
              void vite
                .transformIndexHtml(
                  '/__ci',
                  '<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Owned CI</title></head><body><main style="max-width:900px;margin:24px auto;padding:16px"><div id="root"></div></main><script type="module" src="/__ci.js"></script></body></html>',
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
      requests.push(route.request().method() + ' ' + new URL(route.request().url()).pathname);
      if (delayed)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      await route
        .fulfill(reject ? { status: 403, json: { error: 'denied' } } : { json: evidence })
        .catch(() => undefined);
    });
  });
  afterAll(async () => {
    release?.();
    await browser?.close();
    await server?.close();
  });
  it.each([1360, 420])(
    'loads only on request, preserves failed results, and fits %s px',
    async (width) => {
      reject = false;
      requests.length = 0;
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(origin + '/__ci');
      await page.getByText('중앙 CI 검증 근거', { exact: true }).click();
      expect(requests).toHaveLength(0);
      await page.getByRole('button', { name: 'CI 근거 조회', exact: true }).click();
      await page.getByRole('heading', { name: '권한 회귀 검사 · 실패', exact: true }).waitFor();
      expect(requests).toEqual([`GET /api/v1/analyses/${analysisId}/ci-validation`]);
      expect(await page.evaluate(() => 'injected' in window)).toBe(false);
      await page.getByText('채택하지 않은 CI 근거 · 1개', { exact: true }).click();
      await page.getByText('Check 202: input-mismatch', { exact: true }).waitFor();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    },
  );
  it('clears old evidence when refresh fails', async () => {
    reject = true;
    await page.getByRole('button', { name: '다시 조회', exact: true }).click();
    await page.getByRole('alert').waitFor();
    expect(
      await page.getByRole('heading', { name: '권한 회귀 검사 · 실패', exact: true }).count(),
    ).toBe(0);
  });
  it('discards a late response after navigating to another analysis', async () => {
    reject = false;
    delayed = true;
    await page.getByRole('button', { name: 'CI 근거 조회', exact: true }).click();
    await viWait(() => Boolean(release));
    await page.evaluate(
      (id) => (window as unknown as { showCI: (id: string) => void }).showCI(id),
      otherId,
    );
    release?.();
    delayed = false;
    await page.getByText('중앙 CI 검증 근거', { exact: true }).click();
    expect(
      await page.getByRole('heading', { name: '권한 회귀 검사 · 실패', exact: true }).count(),
    ).toBe(0);
    await page.getByRole('button', { name: 'CI 근거 조회', exact: true }).click();
    await page.getByRole('alert').waitFor(); // The response belongs to the previous analysis.
    expect(errors).toEqual([]);
  });
});
async function viWait(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('Request did not start');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
