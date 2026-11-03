// Compiled administrator UI, production HTTP routes, owned PostgreSQL and real
// realm-scoped Keycloak adapter. No browser/API response is mocked here.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../apps/runtime/src/config.ts';
import { buildServer } from '../apps/runtime/src/server.ts';
import { processIdentityOperation } from '../apps/runtime/src/identity/processor.ts';
import { processIdentityReactivation } from '../apps/runtime/src/identity/reactivation.ts';
import { reconcileIdentitySecurity } from '../apps/runtime/src/identity/security-processor.ts';

export async function runIdentityApplicationSmoke({
  browser,
  wire,
  config,
  directory,
  database,
  databaseUrl,
  tenantId,
  adapter,
  binding,
  clientId,
  secretFile,
  smtpCount,
  securityValidation,
  progress,
}) {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const origin = new URL(config.acs).origin;
  const password = randomBytes(32).toString('base64url');
  const appConfig = loadConfig({
    DATABASE_URL: databaseUrl,
    AUTH_MODE: 'local',
    NODE_ENV: 'production',
    GITHUB_MODE: 'disabled',
    PUBLIC_BASE_URL: origin,
    SESSION_SECRET: randomBytes(32).toString('base64url'),
    WEB_DIST: path.join(repository, 'apps/web/dist'),
    ARTIFACT_ROOT: path.join(directory, 'identity-app-artifacts'),
    LOCAL_BOOTSTRAP_ADMIN_USERNAME: 'identity-app-admin',
    LOCAL_BOOTSTRAP_ADMIN_PASSWORD: password,
    IDENTITY_ADMIN_ENABLED: 'true',
    IDENTITY_SECURITY_ENABLED: String(Boolean(securityValidation)),
    SAML_IDP_ISSUER: config.idpIssuer,
    SAML_ENTITY_ID: config.entityId,
    KEYCLOAK_ADMIN_CLIENT_ID: clientId,
    KEYCLOAK_ADMIN_CLIENT_SECRET_FILE: secretFile,
  });
  let app, context, page;
  const errors = [],
    checks = [];
  try {
    progress('server');
    app = await buildServer(appConfig, { identityAdministration: adapter });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = app.server.address().port;
    const forward = (request, response) => {
      if (request.headers.host !== new URL(origin).host) {
        response.writeHead(400).end();
        return;
      }
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port,
          path: request.url,
          method: request.method,
          headers: request.headers,
        },
        (result) => {
          response.writeHead(result.statusCode, result.headers);
          result.pipe(response);
        },
      );
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    };
    wire(forward);
    context = await browser.newContext({ ignoreHTTPSErrors: false });
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.name));
    progress('login-and-administrator-page');
    await page.goto(origin + '/login?returnTo=%2Fadmin%3Ftab%3Dusers');
    await page.locator('input[name="username"]').fill('identity-app-admin');
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await page.getByRole('heading', { name: '조직 계정 관리', exact: true }).waitFor();
    checks.push('compiled-login-and-complete-admin-page-with-real-api');
    const panel = page.locator('.identity-administration');
    const submit = async (form, label) => {
      const response = page.waitForResponse(
        (result) =>
          new URL(result.url()).pathname === '/api/v1/admin/identity/operations' &&
          result.request().method() === 'POST',
      );
      await form.getByRole('button', { name: label, exact: true }).click();
      const accepted = await response;
      assert.equal(accepted.status(), 202);
      const payload = await accepted.json();
      assert(payload.operation?.id);
      await form.waitFor({ state: 'hidden' });
      return payload.operation;
    };
    const complete = async (operation) => {
      assert.equal(await processIdentityOperation(database, binding, adapter), true);
      const row = (
        await database.query('select * from identity_admin_operations where id=$1', [operation.id])
      ).rows[0];
      assert.equal(row.state, 'succeeded');
      await panel.getByRole('button', { name: '작업 새로고침', exact: true }).click();
      return row;
    };
    progress('create-account');
    await panel.getByRole('button', { name: '조직 계정 생성', exact: true }).click();
    let form = panel.getByRole('form', { name: '조직 계정 생성' });
    await form.getByLabel('로그인 이름', { exact: true }).fill('ui-provisioned-user');
    await form.getByLabel('표시 이름', { exact: true }).fill('UI provisioned user');
    await form.getByLabel('이메일', { exact: true }).fill('ui-provisioned@example.test');
    const tenant = (
      await database.query('select display_name from tenants where id=$1', [tenantId])
    ).rows[0];
    await form.getByLabel(tenant.display_name, { exact: true }).check();
    assert.equal(await form.locator('input[type=password]').count(), 0);
    const queued = await submit(form, '조직 계정 생성');
    const created = await complete(queued);
    const identity = (
      await database.query('select * from user_identities where id=$1', [created.identity_id])
    ).rows[0];
    assert.equal(identity.provisioning_state, 'provisioned');
    assert.equal(identity.security_fresh_until, null);
    assert.equal((await adapter.getUser(created.external_user_id)).enabled, true);
    const user = (await database.query('select * from users where id=$1', [created.user_id]))
      .rows[0];
    assert.equal(user.enabled, true);
    assert.equal(
      (await database.query('select count(*) from local_credentials where user_id=$1', [user.id]))
        .rows[0].count,
      '0',
    );
    checks.push('compiled-create-form-to-outbox-keycloak-and-stable-app-identity');

    progress('invite-email');
    await panel.getByRole('button', { name: '초대 메일', exact: true }).click();
    form = panel.getByRole('form', { name: '초대 메일' });
    progress('invite-select-target');
    const targetView = await page.evaluate(async (id) => {
      const response = await fetch('/api/v1/admin/users');
      const payload = await response.json();
      const target = payload.items?.find((entry) => entry.id === id);
      return {
        status: response.status,
        found: Boolean(target),
        enabled: target?.enabled,
        identityState: target?.identityState,
      };
    }, user.id);
    assert.deepEqual(targetView, {
      status: 200,
      found: true,
      enabled: true,
      identityState: { enabled: true, provisioningState: 'provisioned' },
    });
    await form
      .getByLabel('GCR 사용자')
      .locator(`option[value="${user.id}"]`)
      .waitFor({ state: 'attached' });
    await form.getByLabel('GCR 사용자').selectOption(user.id);
    await form
      .getByLabel('현재 등록된 이메일', { exact: true })
      .fill('ui-provisioned@example.test');
    const beforeMail = await smtpCount();
    progress('invite-submit');
    const invitation = await submit(form, '초대 메일');
    progress('invite-process');
    await complete(invitation);
    assert.equal(await smtpCount(), beforeMail + 1);
    progress('invite-accepted-ui');
    await panel.getByText('초대 메일 · 메일 요청 접수', { exact: true }).waitFor();
    checks.push('compiled-invite-form-to-real-private-smtp-acceptance');

    progress('reset-revokes-before-remote-call');
    const sessionHash = randomBytes(32).toString('hex');
    await database.query(
      "insert into user_sessions(user_id,id_hash,expires_at) values($1,$2,clock_timestamp()+interval '1 hour')",
      [user.id, sessionHash],
    );
    const beforeEpoch = Number(identity.security_epoch);
    await panel.getByRole('button', { name: '비밀번호 재설정 메일', exact: true }).click();
    form = panel.getByRole('form', { name: '비밀번호 재설정 메일' });
    await form.getByLabel('GCR 사용자').selectOption(user.id);
    await form
      .getByLabel('현재 등록된 이메일', { exact: true })
      .fill('ui-provisioned@example.test');
    assert.equal(
      await form.getByRole('button', { name: '비밀번호 재설정 메일', exact: true }).isDisabled(),
      true,
    );
    await form.getByRole('checkbox').check();
    const reset = await submit(form, '비밀번호 재설정 메일');
    assert.equal(
      (await database.query('select count(*) from user_sessions where user_id=$1', [user.id]))
        .rows[0].count,
      '0',
    );
    assert.equal(
      Number(
        (
          await database.query('select security_epoch from user_identities where id=$1', [
            identity.id,
          ])
        ).rows[0].security_epoch,
      ),
      beforeEpoch + 1,
    );
    assert.equal(await smtpCount(), beforeMail + 1);
    await complete(reset);
    assert.equal(await smtpCount(), beforeMail + 2);
    await panel.getByText('비밀번호 재설정 메일 · 메일 요청 접수', { exact: true }).waitFor();
    checks.push('compiled-reset-form-revokes-gcr-sessions-before-idp-logout-and-email');

    progress('csrf-and-explicit-preview');
    // Same browser session, unapproved Origin: real global CSRF guard rejects it.
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/identity/operations',
      headers: {
        origin: 'https://unapproved.example.test',
        host: new URL(origin).host,
        cookie: (await context.cookies(origin))
          .map(({ name, value }) => `${name}=${value}`)
          .join('; '),
      },
      payload: {
        kind: 'invite',
        requestId: randomUUID(),
        target: {
          kind: 'existing',
          userId: user.id,
          expectedSubject: user.oidc_subject,
        },
        expectedEmail: 'ui-provisioned@example.test',
      },
    });
    assert.equal(rejected.statusCode, 403);
    assert.equal(rejected.json().error.code, 'INVALID_ORIGIN');
    const preview = await page.evaluate(async (keycloakUserId) => {
      const response = await fetch('/api/v1/admin/identity/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keycloakUserId }),
      });
      return { status: response.status, payload: await response.json() };
    }, created.external_user_id);
    assert.equal(preview.status, 200);
    assert.equal(preview.payload.nameId, identity.name_id);
    checks.push(
      'production-origin-guard-rejects-injected-cross-origin-operation',
      'realm-account-preview-through-real-authenticated-http',
    );
    if (securityValidation) {
      // The protocol fixture owns the same HTTPS listener. Temporarily return
      // it while validating signed SAML events, then resume the real app route.
      wire(undefined);
      try {
        await securityValidation.run();
      } finally {
        wire(forward);
      }
      await page.reload();
      await page.getByRole('heading', { name: '조직 계정 관리', exact: true }).waitFor();
      const mapped = (
        await database.query(
          `select u.id,u.oidc_subject,i.id identity_id,i.keycloak_user_id from users u
        join user_identities i on i.user_id=u.id where u.id=$1 and u.enabled and i.enabled`,
          [user.id],
        )
      ).rows[0];
      assert(mapped);
      for (const [kind, label] of [
        ['disable', '조직 계정 차단'],
        ['enable', '조직 계정 재활성화'],
        ['logout-all', '전체 기기 로그아웃'],
      ]) {
        progress(`lifecycle-${kind}`);
        await panel.getByRole('button', { name: label, exact: true }).click();
        const lifecycleForm = panel.getByRole('form', { name: label, exact: true });
        await lifecycleForm.getByLabel(/^GCR 사용자/).selectOption(mapped.id);
        assert(await lifecycleForm.getByRole('button', { name: label, exact: true }).isDisabled());
        await lifecycleForm.getByRole('checkbox').check();
        const accepted = await submit(lifecycleForm, label);
        if (kind !== 'logout-all')
          assert.equal(
            (await database.query('select enabled from users where id=$1', [mapped.id])).rows[0]
              .enabled,
            false,
          );
        if (kind === 'enable')
          await processIdentityReactivation(database, binding, securityValidation.adapter);
        else {
          const count = Number(
            (await database.query('select count(*) from user_identities')).rows[0].count,
          );
          for (let index = 0; index < count + 3; index++) {
            await database.query(
              'update identity_security_sources set available_at=clock_timestamp()',
            );
            await reconcileIdentitySecurity(database, binding, securityValidation.adapter);
          }
        }
        const result = (
          await database.query(
            'select state,error_code from identity_admin_operations where id=$1',
            [accepted.id],
          )
        ).rows[0];
        assert.equal(result.state, 'succeeded', `UI ${kind} failed: ${result.error_code}`);
        assert.equal((await adapter.getUser(mapped.keycloak_user_id)).enabled, kind !== 'disable');
        assert.equal(
          (await database.query('select enabled from users where id=$1', [mapped.id])).rows[0]
            .enabled,
          kind !== 'disable',
        );
        await panel.getByRole('button', { name: '작업 새로고침', exact: true }).click();
        await panel.getByText(`${label} · 완료`, { exact: true }).first().waitFor();
        // Reload the real admin response before choosing a newly eligible user.
        await page.reload();
        await page.getByRole('heading', { name: '조직 계정 관리', exact: true }).waitFor();
      }
      checks.push(
        'compiled-lifecycle-ui-to-authenticated-api-to-real-keycloak-disable-enable-and-all-device-logout',
      );
    }
    assert.deepEqual(errors, []);
    if (process.env.GCR_IDENTITY_APP_SCREENSHOT)
      await page.screenshot({ path: process.env.GCR_IDENTITY_APP_SCREENSHOT, fullPage: true });
    return {
      status: 'passed',
      checks,
      pageErrors: errors,
      mockedApiResponses: 0,
      workerScheduling: 'explicit-production-processor-invocation',
      authMode: 'local',
      headless: true,
    };
  } catch (error) {
    if (page && process.env.GCR_IDENTITY_APP_SCREENSHOT)
      await page
        .screenshot({
          path: process.env.GCR_IDENTITY_APP_SCREENSHOT + '.failed.png',
          fullPage: true,
        })
        .catch(() => undefined);
    throw error;
  } finally {
    await context?.close();
    wire(undefined);
    await app?.close();
  }
}
