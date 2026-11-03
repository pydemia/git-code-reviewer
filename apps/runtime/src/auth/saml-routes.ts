import type { Database } from '@gcr/db';
import { errorEnvelope } from '@gcr/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { loadSamlProtocolConfig, samlRoutes, validateSamlSettings } from './saml-config.js';
import {
  loginUrl,
  logoutUrl,
  logoutResponseUrl,
  metadata,
  verifyLogin,
  verifyLogoutRequest,
  verifyLogoutResponse,
  SamlContractError,
  type SamlProtocolConfig,
  type SamlProtocolTransaction,
} from './saml-protocol.js';
import {
  beginSamlLogin,
  beginSamlLogout,
  loadSamlLogin,
  loadSamlLogout,
  consumeSamlLogin,
  consumeSamlLogout,
  consumeIdpSamlLogout,
  pruneSamlState,
  samlReturnTo,
  SamlStateError,
} from './saml-state.js';

const prefix = '__Host-gcr_saml_';
const sessionCookie = 'gcr_session';
const cookieOptions = { path: '/', secure: true, httpOnly: true, sameSite: 'none' as const };

export function isSamlCallback(request: FastifyRequest): boolean {
  const pathname = request.url.split('?')[0];
  return (
    (request.method === 'POST' && request.url === samlRoutes.acs) ||
    (request.method === 'GET' && pathname === samlRoutes.slo)
  );
}

export function samlPublicRequest(request: FastifyRequest): boolean {
  const pathname = request.url.split('?')[0]!;
  const webPage =
    request.method === 'GET' && !pathname.startsWith('/api/') && !pathname.startsWith('/auth/');
  return (
    webPage ||
    isSamlCallback(request) ||
    [
      '/auth/login',
      '/auth/logout',
      '/auth/local/login',
      '/auth/callback',
      samlRoutes.login,
      samlRoutes.metadata,
      '/api/v1/system',
    ].includes(pathname)
  );
}

export function redactSamlRequestUrl(url: string): string {
  const [pathname, query] = url.split('?');
  let decoded = pathname!;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* keep bounded original pathname */
  }
  const sensitive =
    query &&
    [...new URLSearchParams(query).keys()].some((key) =>
      ['samlrequest', 'samlresponse', 'relaystate', 'signature'].includes(key.toLowerCase()),
    );
  return decoded.startsWith('/auth/') || sensitive ? pathname! : url;
}

function cookieName(kind: 'login' | 'logout', relayState: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(relayState)) throw new SamlContractError();
  return `${prefix}${kind}_${relayState}`;
}

function browserBinding(request: FastifyRequest, kind: 'login' | 'logout', relayState: string) {
  const browserNonce = request.cookies[cookieName(kind, relayState)];
  if (!browserNonce || !/^[A-Za-z0-9_-]{43}$/.test(browserNonce)) throw new SamlContractError();
  return { relayState, browserNonce };
}

function protocolTransaction(
  kind: 'login' | 'logout',
  view: { requestId: string; createdAt: number },
  relayState: string,
): SamlProtocolTransaction {
  return { kind, ...view, relayState, consumed: false };
}

function failure(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (
    error instanceof SamlStateError &&
    ['SAML_STORAGE_UNAVAILABLE', 'SAML_SECURITY_UNAVAILABLE'].includes(error.code)
  )
    return sendFailure(
      request,
      reply,
      503,
      'IDENTITY_UNAVAILABLE',
      '인증 상태를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.',
      true,
    );
  if (error instanceof SamlStateError && error.code === 'SAML_IDENTITY_UNAVAILABLE')
    return sendFailure(
      request,
      reply,
      403,
      'SAML_ACCOUNT_UNAVAILABLE',
      '연결된 계정을 사용할 수 없습니다. 관리자에게 문의해 주세요.',
    );
  if (error instanceof SamlContractError || error instanceof SamlStateError)
    return sendFailure(
      request,
      reply,
      400,
      'SAML_RESPONSE_INVALID',
      '로그인·로그아웃 요청을 확인할 수 없습니다. 다시 시작해 주세요.',
    );
  return sendFailure(
    request,
    reply,
    503,
    'IDENTITY_UNAVAILABLE',
    '인증 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.',
    true,
  );
}

function sendFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  retryable = false,
) {
  reply.code(status).header('cache-control', 'no-store').header('vary', 'Accept');
  if (
    request.url.split('?')[0] !== '/auth/logout' &&
    /(?:^|,)\s*text\/html(?:[;,]|$)/i.test(request.headers.accept ?? '')
  ) {
    // Only static application messages are rendered; never insert IdP content,
    // query parameters, request IDs or exception details into an HTML response.
    const escaped = message
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
    return reply
      .type('text/html; charset=utf-8')
      .send(
        `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>인증 요청을 완료하지 못했습니다 · Git Code Reviewer</title><main><h1>인증 요청을 완료하지 못했습니다</h1><p role="alert">${escaped}</p><p><a href="/login">로그인 화면으로 돌아가기</a></p></main></html>`,
      );
  }
  return reply.send(errorEnvelope(code, message, request.id, retryable));
}

export async function registerSamlAuthentication(
  app: FastifyInstance,
  config: AppConfig,
  database: Database,
  loadedProtocol?: SamlProtocolConfig,
) {
  const binding = validateSamlSettings(config);
  const protocol = loadedProtocol ?? (await loadSamlProtocolConfig(config));
  const metadataXml = metadata(protocol);
  const startLogin = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    try {
      if (Object.keys(request.cookies).filter((key) => key.startsWith(prefix)).length >= 8)
        return reply
          .code(429)
          .send(
            errorEnvelope(
              'SAML_TOO_MANY_REQUESTS',
              '진행 중인 로그인 요청을 완료하거나 잠시 후 다시 시도해 주세요.',
              request.id,
              true,
            ),
          );
      const params = new URLSearchParams(request.url.split('?')[1] ?? '');
      if (
        [...params.keys()].some((key) => key !== 'returnTo') ||
        params.getAll('returnTo').length > 1
      )
        throw new SamlContractError();
      const tx = await beginSamlLogin(
        database,
        binding,
        samlReturnTo(params.get('returnTo') ?? '/'),
      );
      const url = await loginUrl(protocol, protocolTransaction('login', tx, tx.relayState));
      reply.setCookie(cookieName('login', tx.relayState), tx.browserNonce, {
        ...cookieOptions,
        maxAge: 300,
      });
      return reply.redirect(url);
    } catch (error) {
      return failure(error, request, reply);
    }
  };
  const startLogout = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    reply.clearCookie(sessionCookie, { path: '/' });
    try {
      const tx = await beginSamlLogout(database, binding, request.cookies[sessionCookie] ?? '');
      if (!tx) return reply.code(204).send();
      const redirectTo = await logoutUrl(
        protocol,
        protocolTransaction('logout', tx, tx.relayState),
        tx.identity,
      );
      reply.setCookie(cookieName('logout', tx.relayState), tx.browserNonce, {
        ...cookieOptions,
        maxAge: 300,
      });
      // The browser must navigate, rather than follow an IdP redirect inside fetch.
      return { redirectTo };
    } catch (error) {
      return failure(error, request, reply);
    }
  };
  await app.register(async (scope) => {
    scope.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      if (
        request.method === 'POST' &&
        request.url === samlRoutes.acs &&
        !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers['content-type'] ?? '')
      )
        return reply
          .code(415)
          .send(
            errorEnvelope(
              'SAML_RESPONSE_INVALID',
              '지원하지 않는 인증 응답 형식입니다.',
              request.id,
              false,
            ),
          );
    });
    scope.setErrorHandler((error, request, reply) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        error.statusCode === 413
      )
        return reply
          .code(413)
          .send(
            errorEnvelope(
              'SAML_RESPONSE_INVALID',
              '인증 응답이 허용된 크기를 초과했습니다.',
              request.id,
              false,
            ),
          );
      return failure(error, request, reply);
    });
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 512 * 1024 },
      (_request, body, done) => {
        const params = new URLSearchParams(body.toString());
        if (
          [...params.keys()].length !== 2 ||
          params.getAll('SAMLResponse').length !== 1 ||
          params.getAll('RelayState').length !== 1
        )
          return done(new SamlContractError());
        done(null, {
          SAMLResponse: params.get('SAMLResponse'),
          RelayState: params.get('RelayState'),
        });
      },
    );
    scope.get(samlRoutes.login, startLogin);
    scope.get(samlRoutes.metadata, async (_request, reply) =>
      reply.type('application/samlmetadata+xml').send(metadataXml),
    );
    scope.post(samlRoutes.acs, { bodyLimit: 512 * 1024 }, async (request, reply) => {
      if (
        !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers['content-type'] ?? '')
      )
        return reply
          .code(415)
          .send(
            errorEnvelope(
              'SAML_RESPONSE_INVALID',
              '지원하지 않는 인증 응답 형식입니다.',
              request.id,
              false,
            ),
          );
      const body = request.body as { SAMLResponse?: unknown; RelayState?: unknown };
      if (typeof body?.SAMLResponse !== 'string' || typeof body.RelayState !== 'string')
        throw new SamlContractError();
      const browser = browserBinding(request, 'login', body.RelayState);
      const tx = await loadSamlLogin(database, binding, browser);
      const verified = await verifyLogin(
        protocol,
        body.SAMLResponse,
        protocolTransaction('login', tx, browser.relayState),
      );
      const session = await consumeSamlLogin(database, binding, browser, verified);
      reply.setCookie(sessionCookie, session.sessionToken, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)),
        expires: new Date(session.expiresAt),
      });
      reply.clearCookie(cookieName('login', browser.relayState), cookieOptions);
      return reply.code(303).redirect(session.returnTo);
    });
    scope.get(samlRoutes.slo, async (request, reply) => {
      const raw = request.url.split('?')[1] ?? '';
      const params = new URLSearchParams(raw);
      if (params.has('SAMLRequest')) {
        const verified = await verifyLogoutRequest(protocol, raw);
        await consumeIdpSamlLogout(database, binding, verified);
        const url = await logoutResponseUrl(protocol, verified);
        // Do not clear another identity's cookie merely because the browser
        // delivered a valid IdP request for a different SSO session.
        return reply.redirect(url);
      }
      const browser = browserBinding(request, 'logout', params.get('RelayState') ?? '');
      const tx = await loadSamlLogout(database, binding, browser);
      const verified = await verifyLogoutResponse(
        protocol,
        raw,
        protocolTransaction('logout', tx, browser.relayState),
      );
      const returnTo = await consumeSamlLogout(database, binding, browser, verified);
      reply.clearCookie(cookieName('logout', browser.relayState), cookieOptions);
      return reply.redirect(returnTo);
    });
    let timer: ReturnType<typeof setInterval> | undefined;
    let pending: Promise<void> | undefined;
    scope.addHook('onReady', async () => {
      timer = setInterval(() => {
        if (pending) return;
        pending = pruneSamlState(database)
          .then(() => undefined)
          .catch(() => {
            scope.log.warn(
              { code: 'SAML_MAINTENANCE_UNAVAILABLE' },
              'SAML expired-state cleanup failed',
            );
          })
          .finally(() => {
            pending = undefined;
          });
      }, 60_000);
      timer.unref();
    });
    scope.addHook('onClose', async () => {
      clearInterval(timer);
      await pending;
    });
  });
  return { startLogin, startLogout };
}
