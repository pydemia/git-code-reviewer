import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ClientCredential } from '@gcr/contracts';
import { centralConnectionInput } from '@gcr/client-contract';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const credential: ClientCredential = {
  id: id(1),
  name: '업무용 Mac',
  clientId: 'commit-defender',
  tenantId: id(2),
  repositoryIds: [id(3)],
  scopes: ['knowledge:read'],
  createdAt: '2026-09-14T00:00:00.000Z',
  expiresAt: '2099-10-14T00:00:00.000Z',
  revokedAt: null,
};
const token = `gcr_key_${id(1)}_${'S'.repeat(43)}`;
const repository = {
  id: id(3),
  githubId: '3',
  tenantId: id(2),
  tenantSlug: 'engineering',
  tenantName: 'Engineering',
  owner: 'example',
  name: 'reviewer',
  webBaseUrl: 'https://github.example.test',
  lastPolledAt: null,
  nextPollAt: null,
  pollOutcome: null,
  pollError: null,
};

describe.sequential('client connection management in Chrome', () => {
  let server: ViteDevServer, browser: Browser, context: BrowserContext, page: Page, origin: string;
  let items: ClientCredential[], requests: unknown[], enabled: boolean, loseResponse: boolean;
  let connection: ReturnType<typeof centralConnectionInput>;
  const pageErrors: string[] = [];
  beforeAll(async () => {
    connection = centralConnectionInput({
      serverUrl: 'https://review.example.test',
      serverId: id(4),
      tenantId: id(2),
      repositoryId: id(3),
      ca: null,
      trustedKeys: [
        {
          id: 'fixture',
          pem: await readFile(
            'deploy/environments/prism-dev/certs/knowledge-signing-public.pem',
            'utf8',
          ),
        },
      ],
    });
    server = await createServer({
      root: path.resolve('apps/web'),
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        {
          name: 'owned-client-connection-fixture',
          resolveId(id) {
            if (id === '/__client-entry.js') return id;
          },
          load(id) {
            if (id === '/__client-entry.js')
              return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {ClientCredentialsPanel} from '/src/ClientCredentialsPanel.tsx'; import '/src/styles.css';
          createRoot(document.getElementById('root')).render(React.createElement(ClientCredentialsPanel));`;
          },
          configureServer(vite) {
            vite.middlewares.use((request, response, next) => {
              if (request.url !== '/__client-fixture') return next();
              void vite
                .transformIndexHtml(
                  '/__client-fixture',
                  '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Client connection fixture</title></head><body><main id="root" style="max-width:760px;margin:24px auto;padding:16px"></main><script type="module" src="/__client-entry.js"></script></body></html>',
                )
                .then((html) => {
                  response.setHeader('content-type', 'text/html');
                  response.end(html);
                });
            });
          },
        },
      ],
    });
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw Error('Expected owned loopback Vite server');
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  }, 30000);
  beforeEach(async () => {
    items = [];
    requests = [];
    enabled = true;
    loseResponse = false;
    context = await browser.newContext({
      viewport: { width: 1200, height: 1000 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.name));
    await page.route('**/api/v1/client-auth/config', (route) =>
      route.fulfill({
        json: {
          schemaVersion: 1,
          serverId: id(4),
          methods: enabled ? ['api-key'] : [],
          clientIds: enabled ? ['commit-defender', 'gcr-cli'] : [],
          scopes: enabled ? ['knowledge:read', 'reviews:submit', 'feedback:submit'] : [],
        },
      }),
    );
    await page.route('**/api/v1/repositories', (route) =>
      route.fulfill({ json: { schemaVersion: 1, items: [repository], nextCursor: null } }),
    );
    await page.route('**/api/v1/me/client-connection-config?*', (route) => {
      expect(new URL(route.request().url()).searchParams.get('repositoryId')).toBe(id(3));
      return route.fulfill({ json: connection });
    });
    await page.route('**/api/v1/me/client-credentials*', async (route) => {
      if (route.request().method() === 'POST') {
        requests.push(route.request().postDataJSON());
        items = [credential];
        if (loseResponse) {
          await route.abort('failed');
          return;
        }
        await route.fulfill({ status: 201, json: { schemaVersion: 1, ...credential, token } });
      } else await route.fulfill({ json: { schemaVersion: 1, items, nextCursor: null } });
    });
    await page.route(`**/api/v1/me/client-credentials/${id(1)}`, (route) => {
      expect(route.request().method()).toBe('DELETE');
      items = items.map((item) => ({ ...item, revokedAt: '2026-09-14T01:00:00.000Z' }));
      return route.fulfill({ status: 204 });
    });
  });
  afterEach(async () => {
    await context?.close();
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
    expect(pageErrors).toEqual([]);
  });
  const open = async () => {
    await page.goto(`${origin}/__client-fixture`);
    await page.getByLabel('이름', { exact: true }).waitFor();
  };
  const create = async () => {
    await page.getByLabel('이름', { exact: true }).fill('업무용 Mac');
    await page.getByRole('button', { name: 'API key 발급', exact: true }).click();
  };
  it('issues only read access and exposes no result or feedback upload permission', async () => {
    await open();
    expect(await page.getByLabel('리뷰 결과 제출 허용').count()).toBe(0);
    expect(await page.getByLabel('피드백 제출 허용').count()).toBe(0);
    await create();
    expect((requests[0] as { scopes: string[] }).scopes).toEqual(['knowledge:read']);
  });
  it('issues a scoped key once, masks/copies/discards it and downloads a token-free pinned configuration', async () => {
    await open();
    await create();
    const secret = page.getByLabel('발급된 API key', { exact: true });
    await secret.waitFor();
    expect(await secret.getAttribute('type')).toBe('password');
    expect(await page.getByRole('button', { name: 'API key 발급', exact: true }).isDisabled()).toBe(
      true,
    );
    expect(requests).toEqual([
      {
        name: '업무용 Mac',
        clientId: 'commit-defender',
        tenantId: id(2),
        repositoryIds: [id(3)],
        lifetimeDays: 30,
        scopes: ['knowledge:read'],
      },
    ]);
    await page.getByRole('button', { name: 'API key 복사', exact: true }).click();
    await page.getByText('API key를 복사했습니다.', { exact: true }).waitFor();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);
    await page.getByRole('button', { name: '원문 보기', exact: true }).click();
    expect(await secret.getAttribute('type')).toBe('text');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '선택한 저장소의 연결 설정 다운로드' }).click();
    const download = await downloadPromise;
    const text = await readFile((await download.path())!, 'utf8');
    expect(centralConnectionInput(JSON.parse(text))).toEqual(connection);
    expect(text).not.toContain(token);
    expect(
      await page.evaluate(() =>
        JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
      ),
    ).not.toContain(token);
    await page.getByRole('button', { name: '원문 닫기', exact: true }).click();
    expect(await secret.count()).toBe(0);
    await page.reload();
    await page.getByText('업무용 Mac', { exact: true }).waitFor();
    expect(await secret.count()).toBe(0);
  });
  it('recovers a lost issue response by listing the key and requires confirmation to revoke it', async () => {
    loseResponse = true;
    await open();
    await create();
    await page.getByRole('alert').filter({ hasText: '발급 결과를 확인하지 못했습니다.' }).waitFor();
    expect(requests).toHaveLength(1);
    await page.getByRole('button', { name: '목록 새로고침' }).click();
    await page.getByRole('button', { name: '업무용 Mac 폐기' }).click();
    expect(items[0]!.revokedAt).toBeNull();
    await page.getByRole('button', { name: '취소', exact: true }).click();
    expect(items[0]!.revokedAt).toBeNull();
    await page.getByRole('button', { name: '업무용 Mac 폐기' }).click();
    await page.getByRole('button', { name: '폐기 확인', exact: true }).click();
    await page.getByText(/Commit Defender · 폐기됨/).waitFor();
    expect(items[0]!.revokedAt).not.toBeNull();
    expect(requests).toHaveLength(1);
  });
  it('clears a one-time secret when the page is hidden and fits a mobile viewport', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    await create();
    await page.getByLabel('발급된 API key', { exact: true }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await page
        .getByRole('button', { name: '목록 새로고침' })
        .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    ).toBeGreaterThan(0);
    expect(
      await page
        .getByRole('button', { name: '업무용 Mac 폐기' })
        .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    ).toBeGreaterThan(0);
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
    );
    await page.getByLabel('발급된 API key', { exact: true }).waitFor({ state: 'detached' });
    if (process.env.GCR_CLIENT_UI_SCREENSHOT)
      await page.screenshot({ path: process.env.GCR_CLIENT_UI_SCREENSHOT, fullPage: true });
  });
  it('shows unavailable capability without offering key creation', async () => {
    enabled = false;
    await page.goto(`${origin}/__client-fixture`);
    await page
      .getByText('이 서버에서는 클라이언트 API key 연결을 아직 제공하지 않습니다.')
      .waitFor();
    expect(await page.getByRole('button', { name: 'API key 발급', exact: true }).count()).toBe(0);
  });
});
