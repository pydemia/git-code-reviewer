import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AdminUser, Tenant, IdentityOperationView } from '@gcr/contracts';

const timestamp = '2026-09-13T00:00:00.000Z';
const user: AdminUser = {
  id: '10000000-0000-4000-8000-000000000001',
  subject: 'local:original',
  username: 'original',
  displayName: 'Original',
  role: 'reviewer',
  enabled: true,
  identityType: 'local',
  groups: [],
  memberships: [],
  repositoryGrants: [],
  createdAt: timestamp,
  updatedAt: timestamp,
};
const tenant: Tenant = {
  id: '20000000-0000-4000-8000-000000000001',
  slug: 'engineering',
  displayName: 'Engineering',
  enabled: true,
  memberCount: 1,
  repositoryCount: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const operation: IdentityOperationView = {
  id: '30000000-0000-4000-8000-000000000001',
  userId: user.id,
  kind: 'create',
  state: 'pending',
  username: 'new-user',
  email: 'new@example.test',
  displayName: 'New user',
  errorCode: null,
  retryAllowed: false,
  mailDelivery: 'not-requested',
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe.sequential('Organization identity administration in Chrome', () => {
  let server: ViteDevServer, browser: Browser, context: BrowserContext, page: Page, origin: string;
  let items: IdentityOperationView[], requests: unknown[], loseResponse: boolean;
  const pageErrors: string[] = [];
  beforeAll(async () => {
    server = await createServer({
      root: path.resolve('apps/web'),
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        {
          name: 'owned-identity-ui-fixture',
          resolveId(id) {
            if (id === '/__identity-entry.js') return id;
          },
          load(id) {
            if (id !== '/__identity-entry.js') return;
            return `import React from 'react'; import { createRoot } from 'react-dom/client';
            import { IdentityAdministrationPanel } from '/src/IdentityAdministrationPanel.tsx';
            import '/src/styles.css';
            const user = ${JSON.stringify(user)};
            if (new URL(location.href).searchParams.has('mapped')) user.identityState = { provisioningState: 'provisioned', enabled: true };
            if (new URL(location.href).searchParams.has('disabled')) {user.enabled = false; user.identityState.enabled = false;}
            const actions = new URL(location.href).searchParams.has('lifecycle') ? ['disable','enable','logout-all'] : undefined;
            createRoot(document.getElementById('root')).render(React.createElement(IdentityAdministrationPanel,
              {users:[user],tenants:[${JSON.stringify(tenant)}],actions,onChanged:()=>{
                document.documentElement.dataset.identityChanges=String(Number(document.documentElement.dataset.identityChanges ?? 0)+1);
              }}));`;
          },
          configureServer(vite) {
            vite.middlewares.use((request, response, next) => {
              if (!request.url?.startsWith('/__identity-fixture')) return next();
              void vite
                .transformIndexHtml(
                  '/__identity-fixture',
                  '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Identity fixture</title></head><body><main id="root" style="max-width:1100px;margin:32px auto;padding:24px"></main><script type="module" src="/__identity-entry.js"></script></body></html>',
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
    if (!address || typeof address === 'string') throw Error('Owned loopback Vite server required');
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  }, 30_000);
  beforeEach(async () => {
    items = [];
    requests = [];
    loseResponse = false;
    context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
    page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.name));
    await page.route('**/api/v1/admin/identity/operations', async (route) => {
      if (route.request().method() === 'POST') {
        requests.push(route.request().postDataJSON());
        if (loseResponse) {
          loseResponse = false;
          await route.abort('failed');
          return;
        }
        await route.fulfill({ json: { operation } });
      } else await route.fulfill({ json: { items } });
    });
    await page.route('**/api/v1/admin/identity/preview', (route) =>
      route.fulfill({
        json: {
          keycloakUserId: '40000000-0000-4000-8000-000000000001',
          username: 'idp-user',
          email: 'idp@example.test',
          displayName: 'IdP user',
          enabled: true,
          nameId: 'G-persistent',
        },
      }),
    );
  });
  afterEach(async () => {
    await context?.close();
  });
  afterAll(async () => {
    try {
      expect(pageErrors).toEqual([]);
      if (process.env.GCR_IDENTITY_UI_EVIDENCE)
        await writeFile(
          process.env.GCR_IDENTITY_UI_EVIDENCE,
          JSON.stringify(
            {
              phase: 'P03-C04',
              node: process.version,
              browser: browser.version(),
              headless: true,
              fixtureApi: true,
              nativeSafari: false,
              pageErrors,
              status: 'browser-errors-checked',
            },
            null,
            2,
          ) + '\n',
          { flag: 'wx', mode: 0o600 },
        );
    } finally {
      await browser?.close();
      await server?.close();
    }
  });
  const open = async (name: string, mapped = false) => {
    await page.goto(`${origin}/__identity-fixture${mapped ? '?mapped=1' : ''}`);
    await page.getByRole('button', { name, exact: true }).click();
    return page.getByRole('form', { name, exact: true });
  };
  const fillCreate = async () => {
    const form = await open('조직 계정 생성');
    await form.getByLabel('로그인 이름').fill('new-user');
    await form.getByLabel('표시 이름').fill('New user');
    await form.getByLabel('이메일', { exact: true }).fill('new@example.test');
    await form.getByLabel('Engineering').check();
    return form;
  };
  it('requires an explicit tenant and creates an account without any password input', async () => {
    const form = await open('조직 계정 생성');
    expect(await form.getByRole('button', { name: '조직 계정 생성' }).isDisabled()).toBe(true);
    expect(await page.locator('input[type=password]').count()).toBe(0);
    await form.getByLabel('로그인 이름').fill('new-user');
    await form.getByLabel('표시 이름').fill('New user');
    await form.getByLabel('이메일', { exact: true }).fill('new@example.test');
    await form.getByLabel('Engineering').check();
    if (process.env.GCR_IDENTITY_UI_SCREENSHOT)
      await page.screenshot({ path: process.env.GCR_IDENTITY_UI_SCREENSHOT, fullPage: true });
    await form.getByRole('button', { name: '조직 계정 생성' }).click();
    await page.getByText(/작업을 접수했습니다/).waitFor();
    expect(requests).toEqual([
      {
        kind: 'create',
        requestId: expect.any(String),
        username: 'new-user',
        displayName: 'New user',
        email: 'new@example.test',
        target: { kind: 'new', role: 'reviewer', tenantIds: [tenant.id] },
      },
    ]);
  }, 20_000);
  it('keeps the same request ID and payload after an uncertain response', async () => {
    loseResponse = true;
    const form = await fillCreate();
    await form.getByRole('button', { name: '조직 계정 생성' }).click();
    await page.getByRole('alert').waitFor();
    expect(await form.getByLabel('로그인 이름').isDisabled()).toBe(true);
    await form.getByRole('button', { name: '같은 요청 다시 확인' }).click();
    await page.getByText(/작업을 접수했습니다/).waitFor();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
  }, 20_000);
  it('refreshes users when an operation finishes before its first poll, without repeated refreshes', async () => {
    items = [{ ...operation, state: 'succeeded' }];
    await page.goto(`${origin}/__identity-fixture`);
    await page.getByText('조직 계정 생성 · 완료', { exact: true }).waitFor();
    expect(await page.locator('html').getAttribute('data-identity-changes')).toBe('1');
    const refreshed = page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/admin/identity/operations'),
    );
    await page.getByRole('button', { name: '작업 새로고침' }).click();
    await refreshed;
    expect(await page.locator('html').getAttribute('data-identity-changes')).toBe('1');
  }, 20_000);
  it('requires an explicit IdP lookup and clears confirmation when the IdP ID changes', async () => {
    const form = await open('기존 계정 연결');
    await form.getByLabel('GCR 사용자').selectOption(user.id);
    expect(await form.getByRole('button', { name: '확인한 계정 연결' }).isDisabled()).toBe(true);
    await form.getByLabel('Keycloak 사용자 ID').fill('40000000-0000-4000-8000-000000000001');
    await form.getByRole('button', { name: '계정 조회' }).click();
    await form.getByText(/연결 대상: IdP user/).waitFor();
    expect(await form.getByRole('button', { name: '확인한 계정 연결' }).isDisabled()).toBe(false);
    await form.getByLabel('Keycloak 사용자 ID').fill('changed');
    expect(await form.getByRole('button', { name: '확인한 계정 연결' }).isDisabled()).toBe(true);
    expect(requests).toEqual([]);
  }, 20_000);
  it('requires session revocation confirmation before a password-reset mail request', async () => {
    const form = await open('비밀번호 재설정 메일', true);
    await form.getByLabel('GCR 사용자').selectOption(user.id);
    await form.getByLabel('현재 등록된 이메일').fill('current@example.test');
    expect(await form.getByRole('button', { name: '비밀번호 재설정 메일' }).isDisabled()).toBe(
      true,
    );
    await form.getByRole('checkbox', { name: /모든 GCR 세션/ }).check();
    await form.getByRole('button', { name: '비밀번호 재설정 메일' }).click();
    await page.getByText(/작업을 접수했습니다/).waitFor();
    expect(requests[0]).toMatchObject({
      kind: 'password-reset',
      target: { kind: 'existing', userId: user.id, expectedSubject: user.subject },
      expectedEmail: 'current@example.test',
      revokeAllSessions: true,
    });
  }, 20_000);
  it('shows delivery uncertainty without offering an automatic retry', async () => {
    items = [
      {
        ...operation,
        kind: 'invite',
        state: 'failed',
        mailDelivery: 'unconfirmed',
        errorCode: 'IDENTITY_EMAIL_UNCONFIRMED',
      },
    ];
    await page.goto(`${origin}/__identity-fixture`);
    await page.getByText(/메일이 발송됐을 수 있습니다/).waitFor();
    expect(await page.getByRole('button', { name: '작업 재시도' }).count()).toBe(0);
    expect(await page.getByText('메일 요청 접수', { exact: true }).count()).toBe(0);
    expect(requests).toEqual([]);
  }, 20_000);
  it.each([
    ['disable', '조직 계정 차단'],
    ['enable', '조직 계정 재활성화'],
    ['logout-all', '전체 기기 로그아웃'],
  ])(
    'requires an explicit target and session confirmation for %s',
    async (kind, label) => {
      await page.goto(
        `${origin}/__identity-fixture?mapped=1&lifecycle=1${kind === 'enable' ? '&disabled=1' : ''}`,
      );
      await page.getByRole('button', { name: label, exact: true }).click();
      const form = page.getByRole('form', { name: label, exact: true });
      expect(await form.locator('input[type=email],input[type=password]').count()).toBe(0);
      await form.getByLabel('GCR 사용자').selectOption(user.id);
      expect(await form.getByRole('button', { name: label, exact: true }).isDisabled()).toBe(true);
      await form.getByRole('checkbox').check();
      await form.getByLabel('GCR 사용자').selectOption('');
      await form.getByLabel('GCR 사용자').selectOption(user.id);
      expect(await form.getByRole('checkbox').isChecked()).toBe(false);
      await form.getByRole('checkbox').check();
      await form.getByRole('button', { name: label, exact: true }).click();
      await page.getByText(/작업을 접수했습니다/).waitFor();
      expect(requests).toEqual([
        {
          kind,
          requestId: expect.any(String),
          target: { kind: 'existing', userId: user.id, expectedSubject: user.subject },
          revokeAllSessions: true,
        },
      ]);
    },
    20_000,
  );
  it('hides lifecycle controls when the server does not advertise them', async () => {
    await page.goto(`${origin}/__identity-fixture?mapped=1`);
    await page.getByRole('button', { name: '조직 계정 생성', exact: true }).waitFor();
    expect(
      await page.getByRole('button', { name: '전체 기기 로그아웃', exact: true }).count(),
    ).toBe(0);
    expect(
      await page.getByRole('button', { name: '조직 계정 재활성화', exact: true }).count(),
    ).toBe(0);
  });
});
