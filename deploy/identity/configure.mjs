// Explicit setup/maintenance command. All credentials stay in files and memory;
// errors never include upstream bodies, tokens, passwords, or realm exports.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ConfigurationError,
  configureIdentity,
  validateConfiguration,
  containsControl,
} from './configuration.mjs';

export async function boundedFile(file, { privateFile = false, maximum = 16_384 } = {}) {
  let handle;
  try {
    if (!path.isAbsolute(file)) throw Error();
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum || (privateFile && info.mode & 0o007)) throw Error();
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length <= maximum) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum) throw Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)).trim();
  } catch {
    throw new ConfigurationError('INVALID_CONFIGURATION_FILE');
  } finally {
    await handle?.close();
  }
}

export function createAdminTransport(
  plan,
  { ca, accessToken, username, password, timeoutMs = 30_000 },
) {
  validateConfiguration(plan);
  const validToken = (value) =>
    typeof value === 'string' &&
    value.length >= 16 &&
    value.length <= 32_768 &&
    /^[A-Za-z0-9._-]+$/.test(value);
  const passwordAuth =
    typeof username === 'string' &&
    /^[A-Za-z0-9._-]{3,128}$/.test(username) &&
    typeof password === 'string' &&
    password.length >= 16 &&
    password.length <= 16_384 &&
    !containsControl(password);
  if (
    (accessToken && !validToken(accessToken)) ||
    (accessToken && (username !== undefined || password !== undefined)) ||
    Boolean(accessToken) === Boolean(passwordAuth) ||
    !ca ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 30_000
  )
    throw new ConfigurationError('INVALID_CONFIGURATION_AUTHENTICATION');
  let token = accessToken,
    expiresAt = accessToken ? Infinity : 0;
  let refreshToken,
    closed = false;
  const deadline = Date.now() + 600_000;
  const request = (pathname, method, body, bearer, allowMissing = false) =>
    new Promise((resolve, reject) => {
      if (Date.now() >= deadline) {
        reject(new ConfigurationError('CONFIGURATION_DEADLINE'));
        return;
      }
      const json = body !== undefined && !(body instanceof URLSearchParams);
      const data = body === undefined ? undefined : json ? JSON.stringify(body) : body.toString();
      let timer;
      const fail = (code) => {
        clearTimeout(timer);
        reject(new ConfigurationError(code));
      };
      const outgoing = https.request(
        plan.adminOrigin + pathname,
        {
          method,
          ca,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
          agent: false,
          maxHeaderSize: 16_384,
          headers: {
            accept: 'application/json',
            ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
            ...(data === undefined
              ? {}
              : {
                  'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded',
                  'content-length': Buffer.byteLength(data),
                }),
          },
        },
        (response) => {
          if (response.statusCode === 404 && allowMissing) {
            clearTimeout(timer);
            response.destroy();
            resolve(null);
            return;
          }
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            const status = response.statusCode;
            response.destroy();
            fail(
              status === 401
                ? 'ADMIN_AUTHENTICATION_FAILED'
                : status === 403
                  ? 'ADMIN_PERMISSION_DENIED'
                  : status === 409
                    ? 'ADMIN_CONFIGURATION_CONFLICT'
                    : 'ADMIN_REQUEST_FAILED',
            );
            return;
          }
          const chunks = [];
          let length = 0;
          response.on('error', () => fail('ADMIN_RESPONSE_FAILED'));
          response.on('aborted', () => fail('ADMIN_RESPONSE_FAILED'));
          response.on('data', (chunk) => {
            length += chunk.length;
            if (length > 512 * 1024) {
              response.destroy();
              fail('ADMIN_RESPONSE_TOO_LARGE');
            } else chunks.push(chunk);
          });
          response.on('end', () => {
            clearTimeout(timer);
            try {
              if (length === 0) {
                resolve(null);
                return;
              }
              if (!/^application\/json(?:;|$)/i.test(response.headers['content-type'] ?? ''))
                throw Error();
              resolve(
                JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
              );
            } catch {
              fail('INVALID_ADMIN_RESPONSE');
            }
          });
        },
      );
      timer = setTimeout(
        () => {
          outgoing.destroy();
          fail('ADMIN_REQUEST_TIMEOUT');
        },
        Math.min(timeoutMs, deadline - Date.now()),
      );
      outgoing.on('error', () => fail('ADMIN_CONNECTION_FAILED'));
      outgoing.end(data);
    });
  const closeSession = async () => {
    if (!refreshToken) return;
    await request(
      '/realms/master/protocol/openid-connect/logout',
      'POST',
      new URLSearchParams({ client_id: 'admin-cli', refresh_token: refreshToken }),
    );
    refreshToken = undefined;
  };
  const admin = async (route, method = 'GET', body, allowMissing = false) => {
    if (closed) throw new ConfigurationError('CONFIGURATION_TRANSPORT_CLOSED');
    const base = '/' + plan.realm;
    if (
      !['GET', 'POST', 'PUT'].includes(method) ||
      (route === '' ? method !== 'POST' : route !== base && !route.startsWith(base + '/')) ||
      /[%;\\]/.test(route.split('?')[0]) ||
      route
        .split('?')[0]
        .split('/')
        .some((part) => part === '.' || part === '..')
    )
      throw new ConfigurationError('INVALID_ADMIN_ROUTE');
    if (Date.now() + 5000 >= expiresAt) {
      await closeSession();
      const result = await request(
        '/realms/master/protocol/openid-connect/token',
        'POST',
        new URLSearchParams({
          grant_type: 'password',
          client_id: 'admin-cli',
          username,
          password,
        }),
      );
      if (
        !validToken(result?.access_token) ||
        !validToken(result?.refresh_token) ||
        !Number.isFinite(result?.expires_in) ||
        result.expires_in <= 5
      )
        throw new ConfigurationError('INVALID_ADMIN_TOKEN_RESPONSE');
      token = result.access_token;
      refreshToken = result.refresh_token;
      expiresAt = Date.now() + Math.min(result.expires_in, 60) * 1000;
    }
    return request('/admin/realms' + route, method, body, token, allowMissing);
  };
  admin.close = async () => {
    try {
      await closeSession();
    } finally {
      closed = true;
      token = undefined;
      refreshToken = undefined;
      username = undefined;
      password = undefined;
    }
  };
  return admin;
}

export function checkConfigurationOrigins(plan, environment) {
  for (const [field, name] of [
    ['publicOrigin', 'GCR_IDENTITY_CONFIG_PUBLIC_ORIGIN'],
    ['identityOrigin', 'GCR_IDENTITY_CONFIG_IDENTITY_ORIGIN'],
    ['adminOrigin', 'GCR_IDENTITY_CONFIG_ADMIN_ORIGIN'],
  ]) {
    if (environment[name] !== undefined && environment[name] !== plan[field])
      throw new ConfigurationError('CONFIGURATION_ORIGIN_MISMATCH');
  }
}

async function main() {
  const [mode, file, ...extra] = process.argv.slice(2);
  if (!['--inspect', '--apply'].includes(mode) || !file || extra.length)
    throw new ConfigurationError('USAGE_CONFIGURE_INSPECT_OR_APPLY_PLAN');
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new ConfigurationError('TLS_VERIFICATION_REQUIRED');
  const plan = validateConfiguration(
    JSON.parse(await boundedFile(path.resolve(file), { maximum: 32_768 })),
  );
  checkConfigurationOrigins(plan, process.env);
  const ca = await boundedFile(process.env.GCR_IDENTITY_CONFIG_CA_FILE ?? '/run/config/ca.crt', {
    maximum: 128 * 1024,
  });
  const spCertificate = await boundedFile(
    process.env.GCR_IDENTITY_CONFIG_SP_CERT_FILE ?? '/run/secrets/sp-signing-cert',
  );
  const clientSecret = await boundedFile(
    process.env.GCR_IDENTITY_CONFIG_CLIENT_SECRET_FILE ??
      '/run/secrets/identity-admin-client-secret',
    { privateFile: true },
  );
  const tokenFile = process.env.GCR_IDENTITY_CONFIG_TOKEN_FILE;
  const usernameFile = process.env.GCR_IDENTITY_CONFIG_USERNAME_FILE;
  const passwordFile = process.env.GCR_IDENTITY_CONFIG_PASSWORD_FILE;
  if (tokenFile && (usernameFile || passwordFile))
    throw new ConfigurationError('AMBIGUOUS_CONFIGURATION_AUTHENTICATION');
  const authentication = tokenFile
    ? { accessToken: await boundedFile(tokenFile, { privateFile: true, maximum: 32_768 }) }
    : {
        username: await boundedFile(usernameFile, { privateFile: true }),
        password: await boundedFile(passwordFile, { privateFile: true }),
      };
  const smtpPassword = process.env.GCR_IDENTITY_CONFIG_SMTP_PASSWORD_FILE
    ? await boundedFile(process.env.GCR_IDENTITY_CONFIG_SMTP_PASSWORD_FILE, { privateFile: true })
    : undefined;
  const admin = createAdminTransport(plan, { ca, ...authentication });
  let result;
  try {
    result = await configureIdentity(plan, {
      mode: mode.slice(2),
      admin,
      spCertificate,
      clientSecret,
      smtpPassword,
    });
  } finally {
    await admin.close();
  }
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch((error) => {
    console.error(
      error instanceof ConfigurationError ? error.message : 'IDENTITY_CONFIGURATION_FAILED',
    );
    process.exitCode = 1;
  });
