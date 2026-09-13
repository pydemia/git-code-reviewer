import { createHash, randomBytes, randomUUID, verify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  certificate,
  idpMetadata,
  signedLogin,
  signedLogout,
  signedLogoutRequest,
} from '../../../../scripts/saml-contract-fixtures.mjs';
import { loadConfig, type AppConfig } from '../config.js';
import { buildServer } from '../server.js';
import { validateSamlSettings } from './saml-config.js';
import { NS, parseXml, type SamlProtocolConfig } from './saml-protocol.js';
import { linkExistingSamlIdentity, persistentNameId, pruneSamlState } from './saml-state.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const nonce = () => randomBytes(32).toString('base64url');
const databaseUrl = process.env.GCR_TEST_DATABASE_URL;

describe
  .skipIf(!databaseUrl)
  .sequential('SAML application routes with signed messages and PostgreSQL', () => {
    const schema = `gcr_saml_routes_${randomUUID().replaceAll('-', '')}`;
    let root: Database, database: Database, directory: string, config: AppConfig;
    let first: FastifyInstance, second: FastifyInstance, protocol: SamlProtocolConfig;
    let sp: Awaited<ReturnType<typeof certificate>>,
      idp: Awaited<ReturnType<typeof certificate>>,
      adminId: string;
    beforeAll(async () => {
      const url = new URL(databaseUrl!);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw Error('Local isolated PostgreSQL only');
      root = createDatabase(url.href);
      await root.query(`create schema ${schema}`);
      url.searchParams.set('options', `-c search_path=${schema}`);
      database = createDatabase(url.href);
      await runMigrations(database, path.resolve('packages/db/migrations'));
      directory = await mkdtemp(path.join(tmpdir(), 'gcr-saml-routes-'));
      sp = await certificate(directory, 'sp');
      idp = await certificate(directory, 'idp');
      protocol = {
        acs: 'https://gcr.test/auth/saml/acs',
        slo: 'https://gcr.test/auth/saml/slo',
        entityId: 'https://gcr.test/auth/saml/metadata',
        idpIssuer: 'https://idp.test/realms/gcr',
        entryPoint: 'https://idp.test/realms/gcr/protocol/saml',
        privateKey: sp.key,
        publicCert: sp.cert,
        idpCerts: [idp.cert],
      };
      await writeFile(path.join(directory, 'idp.xml'), idpMetadata(protocol, [idp.cert]), {
        mode: 0o600,
      });
      await writeFile(
        path.join(directory, 'index.html'),
        '<!doctype html><title>GCR test application</title>',
      );
      config = loadConfig({
        DATABASE_URL: url.href,
        AUTH_MODE: 'saml',
        NODE_ENV: 'production',
        GITHUB_MODE: 'disabled',
        PUBLIC_BASE_URL: 'https://gcr.test',
        SESSION_SECRET: nonce(),
        WEB_DIST: directory,
        ARTIFACT_ROOT: path.join(directory, 'artifacts'),
        SAML_IDP_ISSUER: protocol.idpIssuer,
        SAML_IDP_ENTRY_POINT: protocol.entryPoint,
        SAML_IDP_METADATA_URL: 'https://idp.test/realms/gcr/descriptor',
        SAML_IDP_METADATA_FILE: path.join(directory, 'idp.xml'),
        SAML_PRIVATE_KEY_FILE: sp.keyPath,
        SAML_PUBLIC_CERT_FILE: sp.certPath,
      });
      adminId = (
        await database.query(
          "insert into users(oidc_subject,display_name,role) values($1,'Fixture Admin','administrator') returning id",
          [randomUUID()],
        )
      ).rows[0].id;
      first = await buildServer(config);
      second = await buildServer(config);
      await first.ready();
      await second.ready();
    }, 30_000);
    afterAll(async () => {
      await first?.close();
      await second?.close();
      await database?.end();
      if (root) {
        await root.query(`drop schema ${schema} cascade`);
        await root.end();
      }
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    async function mappedUser() {
      const subject = randomUUID(),
        nameID = `persistent-${randomUUID()}`;
      const userId = (
        await database.query(
          "insert into users(oidc_subject,display_name,role,groups_json) values($1,'Original GCR name','reviewer','[\"engineering\"]') returning id",
          [subject],
        )
      ).rows[0].id as string;
      const identity = {
        issuer: protocol.idpIssuer,
        entityId: protocol.entityId,
        nameID,
        nameIDFormat: persistentNameId,
        nameQualifier: protocol.idpIssuer,
        spNameQualifier: protocol.entityId,
      };
      const identityId = await linkExistingSamlIdentity(database, validateSamlSettings(config), {
        actorId: adminId,
        userId,
        expectedSubject: subject,
        keycloakUserId: randomUUID(),
        identity,
      });
      // Explicit fixture activation. Production provisioning is implemented in P03-C04/C05.
      await database.query(
        `update user_identities set enabled=true,provisioning_state='provisioned',identity_verified_at=clock_timestamp(),security_checked_at=statement_timestamp(),security_fresh_until=statement_timestamp()+interval '5 minutes' where id=$1`,
        [identityId],
      );
      return { userId, subject, identityId, nameID };
    }
    function redirectMessage(url: string, publicCert = sp.cert) {
      const target = new URL(url),
        params = target.searchParams;
      expect(target.origin + target.pathname).toBe(protocol.entryPoint);
      const key = params.has('SAMLRequest') ? 'SAMLRequest' : 'SAMLResponse';
      const raw = new Map(
        target.search
          .slice(1)
          .split('&')
          .map((field) => [field.split('=')[0], field]),
      );
      const signed = [
        raw.get(key),
        ...(params.has('RelayState') ? [raw.get('RelayState')] : []),
        raw.get('SigAlg'),
      ].join('&');
      expect(
        verify(
          'RSA-SHA256',
          Buffer.from(signed),
          publicCert,
          Buffer.from(params.get('Signature')!, 'base64'),
        ),
      ).toBe(true);
      const xml = inflateRawSync(Buffer.from(params.get(key)!, 'base64')).toString('utf8');
      return { root: parseXml(xml).documentElement!, relayState: params.get('RelayState')!, xml };
    }
    async function start(app = first, returnTo = '/worklist', cookie = '') {
      const response = await app.inject({
        url: `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(302);
      const message = redirectMessage(response.headers.location!);
      const bindingCookie = response.cookies.find((item) =>
        item.name.startsWith('__Host-gcr_saml_login_'),
      )!;
      expect(bindingCookie).toMatchObject({
        secure: true,
        httpOnly: true,
        sameSite: 'None',
        path: '/',
        maxAge: 300,
      });
      expect(bindingCookie.domain).toBeUndefined();
      expect(bindingCookie.name).toBe(`__Host-gcr_saml_login_${message.relayState}`);
      expect(response.headers['cache-control']).toBe('no-store');
      return {
        requestId: message.root.getAttribute('ID')!,
        relayState: message.relayState,
        cookie: `${bindingCookie.name}=${bindingCookie.value}`,
        browserNonce: bindingCookie.value,
      };
    }
    function responseBody(
      tx: Awaited<ReturnType<typeof start>>,
      user: { nameID: string },
      changes = {},
    ) {
      const encoded = signedLogin(protocol, tx, idp.key, idp.cert, {
        nameID: user.nameID,
        ...changes,
      }).encoded;
      return new URLSearchParams({ SAMLResponse: encoded, RelayState: tx.relayState }).toString();
    }
    function post(
      tx: Awaited<ReturnType<typeof start>>,
      body: string,
      app = first,
      cookie = tx.cookie,
    ) {
      return app.inject({
        method: 'POST',
        url: '/auth/saml/acs',
        headers: {
          origin: 'https://idp.test',
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
        },
        payload: body,
      });
    }
    async function login(
      user: Awaited<ReturnType<typeof mappedUser>>,
      sessionIndex = randomUUID(),
    ) {
      const tx = await start();
      const response = await post(tx, responseBody(tx, user, { sessionIndex }));
      expect(response.statusCode).toBe(303);
      const cookie = response.cookies.find((item) => item.name === 'gcr_session')!;
      expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Lax', path: '/' });
      expect(cookie.domain).toBeUndefined();
      return { sessionIndex, token: cookie.value, cookie: `gcr_session=${cookie.value}` };
    }
    const me = (cookie: string, app = first) =>
      app.inject({ url: '/api/v1/me', headers: { cookie } });
    async function logout(cookie: string) {
      return first.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { cookie, origin: 'https://gcr.test' },
      });
    }
    async function countSessions(userId: string) {
      return (
        await database.query('select count(*)::int as n from user_sessions where user_id=$1', [
          userId,
        ])
      ).rows[0].n;
    }

    it('publishes signed metadata and SAML mode while refusing local/OIDC authentication', async () => {
      const metadata = await first.inject('/auth/saml/metadata');
      expect(metadata.statusCode).toBe(200);
      expect(metadata.headers['content-type']).toContain('application/samlmetadata+xml');
      expect(metadata.headers['cache-control']).toBe('no-store');
      expect(parseXml(metadata.body).getElementsByTagNameNS(NS.ds, 'Signature')).toHaveLength(1);
      expect((await first.inject('/api/v1/system')).json().authMode).toBe('saml');
      expect(
        (
          await first.inject({
            method: 'POST',
            url: '/auth/local/login',
            headers: { origin: 'https://gcr.test' },
            payload: { username: 'fixture', password: 'fixture-password' },
          })
        ).statusCode,
      ).toBe(404);
      expect((await first.inject('/auth/callback?code=synthetic')).statusCode).toBe(404);
      expect(
        (await database.query('select count(*)::int as n from local_credentials')).rows[0].n,
      ).toBe(0);
    });
    it('accepts a cross-origin signed POST only at ACS and retains GCR user authority', async () => {
      const user = await mappedUser(),
        tx = await start(first, '/worklist?state=open');
      const response = await post(tx, responseBody(tx, user));
      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe('/worklist?state=open');
      const cookie = response.cookies.find((item) => item.name === 'gcr_session')!;
      const authenticated = await me(`gcr_session=${cookie.value}`, second);
      expect(authenticated.statusCode).toBe(200);
      expect(authenticated.json()).toMatchObject({
        id: user.userId,
        subject: user.subject,
        displayName: 'Original GCR name',
        role: 'reviewer',
        groups: ['engineering'],
      });
      const stored = (
        await database.query('select * from user_sessions where id_hash=$1', [hash(cookie.value)])
      ).rows[0];
      expect(stored.saml_identity_id).toBe(user.identityId);
      expect(stored.saml_session_index).toBe('synthetic-session');
      expect(new Date(stored.expires_at).getTime()).toBeLessThanOrEqual(
        new Date(stored.saml_session_not_on_or_after).getTime(),
      );
    });
    it('consumes one signed response exactly once across two application instances', async () => {
      const user = await mappedUser(),
        tx = await start(),
        body = responseBody(tx, user);
      const result = await Promise.all([post(tx, body, first), post(tx, body, second)]);
      expect(result.map((item) => item.statusCode).sort()).toEqual([303, 400]);
      expect(await countSessions(user.userId)).toBe(1);
    });
    it('keeps independent browser transactions and clears only the completed cookie', async () => {
      const user = await mappedUser(),
        a = await start(),
        b = await start(first, '/profile', a.cookie);
      const cookie = `${a.cookie}; ${b.cookie}`;
      const aResponse = await post(a, responseBody(a, user), first, cookie);
      expect(aResponse.statusCode).toBe(303);
      expect(
        aResponse.cookies
          .filter((item) => item.name.startsWith('__Host-'))
          .map((item) => item.name),
      ).toEqual([a.cookie.split('=')[0]]);
      expect((await post(b, responseBody(b, user), second, cookie)).statusCode).toBe(303);
      expect(await countSessions(user.userId)).toBe(2);
    });
    it('limits outstanding browser transactions before creating database state', async () => {
      const before = (await database.query('select count(*)::int as n from saml_transactions'))
        .rows[0].n;
      const cookie = Array.from(
        { length: 8 },
        () => `__Host-gcr_saml_login_${nonce()}=${nonce()}`,
      ).join('; ');
      expect((await first.inject({ url: '/auth/login', headers: { cookie } })).statusCode).toBe(
        429,
      );
      expect(
        (await database.query('select count(*)::int as n from saml_transactions')).rows[0].n,
      ).toBe(before);
    });
    it('rejects absent/wrong browser binding without consuming a valid response', async () => {
      const user = await mappedUser(),
        tx = await start(),
        body = responseBody(tx, user);
      for (const cookie of ['', `${tx.cookie.split('=')[0]}=${nonce()}`]) {
        const denied = await post(tx, body, first, cookie);
        expect(denied.statusCode).toBe(400);
        expect(denied.cookies).toHaveLength(0);
      }
      expect(await countSessions(user.userId)).toBe(0);
      expect((await post(tx, body)).statusCode).toBe(303);
    });
    it('rejects a tampered signature without consuming state or disclosing XML', async () => {
      const user = await mappedUser(),
        tx = await start();
      const good = signedLogin(protocol, tx, idp.key, idp.cert, { nameID: user.nameID });
      const payload = new URLSearchParams({
        SAMLResponse: Buffer.from(good.xml.replace(user.nameID, 'tampered-identity')).toString(
          'base64',
        ),
        RelayState: tx.relayState,
      }).toString();
      const denied = await post(tx, payload);
      expect(denied.statusCode).toBe(400);
      expect(denied.body).not.toContain('tampered-identity');
      expect(denied.cookies).toHaveLength(0);
      expect(
        (
          await post(
            tx,
            new URLSearchParams({
              SAMLResponse: good.encoded,
              RelayState: tx.relayState,
            }).toString(),
          )
        ).statusCode,
      ).toBe(303);
    });
    it('does not create a user from an unmapped NameID or matching display name', async () => {
      const tx = await start();
      const before = (await database.query('select count(*)::int as n from users')).rows[0].n;
      expect((await post(tx, responseBody(tx, { nameID: 'Original GCR name' }))).statusCode).toBe(
        403,
      );
      expect((await database.query('select count(*)::int as n from users')).rows[0].n).toBe(before);
    });
    it.each([
      '//evil.test',
      '/%5cevil.test',
      '/%252f/evil.test',
      'https://evil.test',
      '/a/..//evil.test',
      '/%00',
    ])('rejects unsafe returnTo %s', async (returnTo) => {
      expect(
        (await first.inject(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`)).statusCode,
      ).toBe(400);
    });
    it('rejects duplicate login query and extra ACS form fields', async () => {
      expect((await first.inject('/auth/login?returnTo=/&returnTo=/profile')).statusCode).toBe(400);
      const user = await mappedUser(),
        tx = await start(),
        body = responseBody(tx, user);
      for (const suffix of ['&extra=value', '&RelayState=another'])
        expect((await post(tx, body + suffix)).statusCode).toBe(400);
      expect((await post(tx, body)).statusCode).toBe(303);
    });
    it('rejects unexpected content types and bounds the ACS request body', async () => {
      expect(
        (
          await first.inject({
            method: 'POST',
            url: '/auth/saml/acs',
            headers: { origin: 'https://idp.test' },
            payload: { SAMLResponse: 'synthetic', RelayState: nonce() },
          })
        ).statusCode,
      ).toBe(415);
      const response = await first.inject({
        method: 'POST',
        url: '/auth/saml/acs',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'SAMLResponse=' + 'A'.repeat(513 * 1024) + '&RelayState=' + nonce(),
      });
      expect(response.statusCode).toBe(413);
      expect(response.body).not.toContain('AAAA');
    });
    it('keeps unsafe API/logout CSRF checks, exact scheme, and ignores a spoofed forwarded host', async () => {
      const user = await mappedUser(),
        session = await login(user);
      for (const headers of [
        { origin: 'https://evil.test' },
        { origin: 'http://gcr.test' },
        { origin: 'https://evil.test', 'x-forwarded-host': 'evil.test' },
        {},
      ]) {
        const denied = await first.inject({
          method: 'POST',
          url: '/auth/logout',
          headers: { ...headers, host: 'gcr.test', cookie: session.cookie },
        });
        expect(denied.statusCode).toBe(403);
        expect(denied.cookies).toHaveLength(0);
      }
      expect((await me(session.cookie)).statusCode).toBe(200);
      const deniedAcs = await first.inject({
        method: 'POST',
        url: '/auth/saml/acs?extra=true',
        headers: {
          origin: 'https://idp.test',
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: 'SAMLResponse=synthetic&RelayState=synthetic',
      });
      expect(deniedAcs.statusCode).toBe(403);
    });
    it('refuses legacy local sessions in SAML mode', async () => {
      const user = await mappedUser(),
        token = nonce();
      await database.query(
        "insert into user_sessions(id_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 hour')",
        [hash(token), user.userId],
      );
      expect((await me(`gcr_session=${token}`)).statusCode).toBe(401);
    });
    it.each([
      ['disabled identity', 'update user_identities set enabled=false where id=$1', 401],
      [
        'changed security epoch',
        'update user_identities set security_epoch=security_epoch+1 where id=$1',
        401,
      ],
      [
        'stale security state',
        "update user_identities set security_checked_at=statement_timestamp()-interval '10 minutes',security_fresh_until=statement_timestamp()-interval '5 minutes' where id=$1",
        503,
      ],
      [
        'future security state',
        "update user_identities set security_checked_at=statement_timestamp()+interval '1 minute',security_fresh_until=statement_timestamp()+interval '5 minutes' where id=$1",
        503,
      ],
    ])('enforces %s on both application instances', async (_name, sql, status) => {
      const user = await mappedUser(),
        session = await login(user);
      await database.query(sql as string, [user.identityId]);
      for (const app of [first, second]) {
        const response = await me(session.cookie, app);
        expect(response.statusCode).toBe(status);
        if (status === 503) expect(response.json().error.code).toBe('IDENTITY_UNAVAILABLE');
        expect(
          (await app.inject({ url: '/login', headers: { cookie: session.cookie } })).statusCode,
        ).toBe(200);
        expect(
          (await app.inject({ url: '/api/v1/system', headers: { cookie: session.cookie } }))
            .statusCode,
        ).toBe(200);
      }
    });
    it('revokes every matching SessionIndex immediately, preserving other SSO sessions', async () => {
      const user = await mappedUser(),
        a = await login(user, 'logout-target'),
        b = await login(user, 'logout-target'),
        other = await login(user, 'other-device');
      const result = await logout(a.cookie);
      expect(result.statusCode).toBe(200);
      expect(result.cookies.find((item) => item.name === 'gcr_session')?.value).toBe('');
      const request = redirectMessage(result.json().redirectTo);
      expect(request.root.localName).toBe('LogoutRequest');
      expect(request.root.getElementsByTagNameNS(NS.protocol, 'SessionIndex')[0].textContent).toBe(
        'logout-target',
      );
      expect((await me(a.cookie)).statusCode).toBe(401);
      expect((await me(b.cookie, second)).statusCode).toBe(401);
      expect((await me(other.cookie)).statusCode).toBe(200);
      const txCookie = result.cookies.find((item) =>
        item.name.startsWith('__Host-gcr_saml_logout_'),
      )!;
      const tx = { relayState: request.relayState, requestId: request.root.getAttribute('ID')! };
      const query = signedLogout(protocol, tx, idp.key);
      expect((await second.inject(`/auth/saml/slo?${query}`)).statusCode).toBe(400);
      const headers = { cookie: `${txCookie.name}=${txCookie.value}` };
      const valid = await second.inject({ url: `/auth/saml/slo?${query}`, headers });
      expect(valid.statusCode).toBe(302);
      expect(valid.headers.location).toBe('/login');
      expect((await first.inject({ url: `/auth/saml/slo?${query}`, headers })).statusCode).toBe(
        400,
      );
      expect((await me(other.cookie)).statusCode).toBe(200);
    });
    it('allows logout when identity freshness is unavailable or the user is blocked', async () => {
      const user = await mappedUser(),
        session = await login(user);
      await database.query('update users set enabled=false where id=$1', [user.userId]);
      await database.query('update user_identities set enabled=false where id=$1', [
        user.identityId,
      ]);
      expect((await logout(session.cookie)).statusCode).toBe(200);
      expect(await countSessions(user.userId)).toBe(0);
    });
    it('handles signed IdP logout once without clearing an unrelated browser cookie', async () => {
      const user = await mappedUser(),
        a = await login(user, 'idp-target'),
        other = await login(user, 'other-idp-device');
      const requestId = `_${randomUUID()}`;
      const query = signedLogoutRequest(protocol, idp.key, {
        id: requestId,
        nameID: user.nameID,
        sessionIndexes: ['idp-target'],
      });
      const result = await second.inject({
        url: `/auth/saml/slo?${query}`,
        headers: { cookie: other.cookie },
      });
      expect(result.statusCode).toBe(302);
      expect(result.cookies).toHaveLength(0);
      const response = redirectMessage(result.headers.location!);
      expect(response.root.localName).toBe('LogoutResponse');
      expect(response.root.getAttribute('InResponseTo')).toBe(requestId);
      expect(response.relayState).toBe('synthetic-idp-relay');
      expect((await me(a.cookie)).statusCode).toBe(401);
      expect((await me(other.cookie)).statusCode).toBe(200);
      expect((await first.inject(`/auth/saml/slo?${query}`)).statusCode).toBe(400);
    });
    it('rejects an in-flight login for a revoked SessionIndex and allows a newly started login', async () => {
      const user = await mappedUser(),
        active = await login(user, 'revoked-index');
      const old = await start(),
        unaffected = await start();
      const delayed = responseBody(old, user, { sessionIndex: active.sessionIndex });
      expect((await logout(active.cookie)).statusCode).toBe(200);
      expect((await post(old, delayed, second)).statusCode).toBe(400);
      expect(
        (
          await post(
            unaffected,
            responseBody(unaffected, user, { sessionIndex: 'different-index' }),
          )
        ).statusCode,
      ).toBe(303);
      const fresh = await start();
      expect(
        (
          await post(
            fresh,
            responseBody(fresh, user, { sessionIndex: active.sessionIndex }),
            second,
          )
        ).statusCode,
      ).toBe(303);
    });
    it('rejects a pending login after IdP logout even when no local session existed', async () => {
      const user = await mappedUser(),
        old = await start();
      const body = responseBody(old, user, { sessionIndex: 'not-yet-issued' });
      const query = signedLogoutRequest(protocol, idp.key, {
        nameID: user.nameID,
        sessionIndexes: ['not-yet-issued'],
      });
      expect((await second.inject(`/auth/saml/slo?${query}`)).statusCode).toBe(302);
      expect((await post(old, body)).statusCode).toBe(400);
      expect(await countSessions(user.userId)).toBe(0);
    });
    it('cleans expired revocations in bounded batches and keeps current ones', async () => {
      const user = await mappedUser();
      for (const index of ['expired-1', 'expired-2'])
        await database.query(
          "insert into saml_session_revocations(identity_id,session_index_hash,revoked_at,expires_at) values($1,$2,statement_timestamp()-interval '11 minutes',statement_timestamp()-interval '1 minute')",
          [user.identityId, hash(index)],
        );
      await database.query(
        'insert into saml_session_revocations(identity_id,session_index_hash) values($1,$2)',
        [user.identityId, hash('current')],
      );
      expect((await pruneSamlState(database, 1)).revocations).toBe(1);
      expect((await pruneSamlState(database, 1)).revocations).toBe(1);
      expect(
        (
          await database.query(
            'select session_index_hash from saml_session_revocations where identity_id=$1',
            [user.identityId],
          )
        ).rows,
      ).toEqual([{ session_index_hash: hash('current') }]);
    });

    it('returns retryable ACS failure for stale identity state without consuming the transaction', async () => {
      const user = await mappedUser(),
        tx = await start(),
        body = responseBody(tx, user);
      await database.query(
        "update user_identities set security_checked_at=statement_timestamp()-interval '6 minutes',security_fresh_until=statement_timestamp()-interval '1 minute' where id=$1",
        [user.identityId],
      );
      const unavailable = await post(tx, body);
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json().error).toMatchObject({
        code: 'IDENTITY_UNAVAILABLE',
        retryable: true,
      });
      expect(unavailable.cookies).toHaveLength(0);
      expect(await countSessions(user.userId)).toBe(0);
      await database.query(
        "update user_identities set security_checked_at=statement_timestamp(),security_fresh_until=statement_timestamp()+interval '5 minutes' where id=$1",
        [user.identityId],
      );
      expect((await post(tx, body, second)).statusCode).toBe(303);
    });
    it('rolls back session issuance after a real database failure and permits a valid retry', async () => {
      const user = await mappedUser(),
        tx = await start(),
        body = responseBody(tx, user);
      await database.query(`create function saml_fixture_storage_failure() returns trigger language plpgsql as $$ begin raise exception 'private-database-detail'; end $$;
      create trigger saml_fixture_storage_failure before insert on user_sessions for each row execute function saml_fixture_storage_failure()`);
      try {
        const failed = await post(tx, body);
        expect(failed.statusCode).toBe(503);
        expect(failed.json().error.code).toBe('IDENTITY_UNAVAILABLE');
        expect(failed.body).not.toContain('private-database-detail');
        expect(failed.cookies).toHaveLength(0);
        expect(await countSessions(user.userId)).toBe(0);
      } finally {
        await database.query(
          'drop trigger saml_fixture_storage_failure on user_sessions; drop function saml_fixture_storage_failure()',
        );
      }
      expect((await post(tx, body, second)).statusCode).toBe(303);
    });
    it('does not report successful logout when durable revocation fails', async () => {
      const user = await mappedUser(),
        session = await login(user);
      await database.query(`create function saml_fixture_revoke_failure() returns trigger language plpgsql as $$ begin raise exception 'private-revocation-detail'; end $$;
      create trigger saml_fixture_revoke_failure before insert on saml_session_revocations for each row execute function saml_fixture_revoke_failure()`);
      try {
        const failed = await logout(session.cookie);
        expect(failed.statusCode).toBe(503);
        expect(failed.json().error.code).toBe('IDENTITY_UNAVAILABLE');
        expect(failed.body).not.toContain('private-revocation-detail');
        expect(failed.cookies.find((cookie) => cookie.name === 'gcr_session')?.value).toBe('');
        expect(failed.cookies.filter((cookie) => cookie.name.startsWith('__Host-'))).toHaveLength(
          0,
        );
        expect(await countSessions(user.userId)).toBe(1); // transaction rolled back; no false success
      } finally {
        await database.query(
          'drop trigger saml_fixture_revoke_failure on saml_session_revocations; drop function saml_fixture_revoke_failure()',
        );
      }
      expect((await logout(session.cookie)).statusCode).toBe(200);
      expect(await countSessions(user.userId)).toBe(0);
    });
    it('renders a static recovery link for browser callback errors without reflecting inputs', async () => {
      const response = await first.inject({
        method: 'POST',
        url: '/auth/saml/acs',
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: new URLSearchParams({
          SAMLResponse: '<script>untrusted-idp-content</script>',
          RelayState: nonce(),
        }).toString(),
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toContain('href="/login"');
      expect(response.body).not.toContain('untrusted-idp-content');
      expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    });
    it('redacts SAML query and browser credentials in actual request log records', async () => {
      // Pino exposes its destination under this symbol; intercept serialized log
      // writes so any regression is tested without printing credentials to CI.
      const logger = first.log as typeof first.log & {
        [key: symbol]: { write: (line: string) => void };
      };
      let owner: object | null = logger;
      let streamKey: symbol | undefined;
      while (owner && !streamKey) {
        streamKey = Object.getOwnPropertySymbols(owner).find(
          (key) => key.description === 'pino.stream',
        );
        owner = Object.getPrototypeOf(owner);
      }
      expect(streamKey).toBeDefined();
      const stream = logger[streamKey!];
      const lines: string[] = [];
      const spy = vi.spyOn(stream, 'write').mockImplementation((line) => {
        lines.push(String(line));
      });
      const level = logger.level;
      logger.level = 'info';
      try {
        const user = await mappedUser(),
          tx = await start();
        await post(tx, responseBody(tx, user));
        await first.inject({
          url: '/auth/saml/slo?SAMLRequest=private-message&RelayState=private-relay&Signature=private-signature',
          headers: {
            cookie: 'gcr_session=private-session',
            authorization: 'Bearer private-bearer',
          },
        });
        await first.inject('/unrelated?%53AMLResponse=private-query');
        const output = lines.join('\n');
        expect(output).toContain('incoming request');
        expect(output).toContain('/auth/saml/slo');
        for (const value of [
          'private-message',
          'private-relay',
          'private-signature',
          'private-session',
          'private-bearer',
          'private-query',
          user.nameID,
          tx.relayState,
          tx.browserNonce,
          sp.key,
          '<samlp:Response',
        ])
          expect(output).not.toContain(value);
      } finally {
        logger.level = level;
        spy.mockRestore();
      }
    });
  });
