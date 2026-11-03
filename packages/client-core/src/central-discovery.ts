import { request } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { centralConnectionOptions, centralClientAuthConfig } from '@gcr/client-contract';
import {
  KnowledgeSyncError,
  normalizeCentralServerUrl,
  TrustedCentralBinding,
} from './central-binding.js';
import { validateCentralApiKey } from './local-credentials.js';

export class CentralDiscoveryTlsError extends KnowledgeSyncError {
  constructor() {
    super('unavailable', 'The server certificate needs a trusted CA certificate.');
  }
}
export function validateCentralCa(pem: string): string {
  try {
    const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (
      Buffer.byteLength(pem) > 65536 ||
      !certificates?.length ||
      pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim() ||
      certificates.some((value) => !new X509Certificate(value).ca)
    )
      throw Error();
    return pem;
  } catch {
    throw new KnowledgeSyncError(
      'invalid-binding',
      'Choose a file containing only public CA certificates.',
    );
  }
}
/** Bounded public bootstrap and authenticated GET to the explicit TLS origin. No redirects, local data or model calls. */
export async function discoverCentralConnections(
  serverUrl: string,
  apiKey: string,
  clientId: 'commit-defender' | 'gcr-cli',
  options: { ca?: string; signal?: AbortSignal } = {},
) {
  const base = normalizeCentralServerUrl(serverUrl);
  validateCentralApiKey(apiKey);
  const ca = options.ca === undefined ? undefined : validateCentralCa(options.ca);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15000);
  const unavailable = () =>
    new KnowledgeSyncError('unavailable', 'Could not read central connection options.');
  try {
    const get = (relative: string, serverId?: string) =>
      new Promise<Buffer>((resolve, reject) => {
        const req = request(
          new URL(relative, base),
          {
            method: 'GET',
            signal: controller.signal,
            rejectUnauthorized: true,
            ...(ca ? { ca } : {}),
            headers: {
              ...(serverId
                ? { authorization: `Bearer ${apiKey}`, 'x-gcr-server-id': serverId }
                : {}),
              accept: 'application/json',
            },
          },
          async (res) => {
            try {
              if (res.statusCode !== 200) {
                if (res.statusCode === 401)
                  throw new KnowledgeSyncError(
                    'authentication-required',
                    'A valid GCR API key is required.',
                  );
                if (res.statusCode === 403)
                  throw new KnowledgeSyncError('revoked', 'The key has no current access.');
                if (res.statusCode === 404)
                  throw new KnowledgeSyncError(
                    'incompatible',
                    'This server requires the legacy JSON connection flow.',
                  );
                throw unavailable();
              }
              const chunks: Buffer[] = [];
              let size = 0;
              for await (const chunk of res) {
                const bytes = Buffer.from(chunk);
                size += bytes.length;
                if (size > 1_048_576) throw unavailable();
                chunks.push(bytes);
              }
              resolve(Buffer.concat(chunks));
            } catch (cause) {
              reject(cause);
            } finally {
              res.destroy();
            }
          },
        );
        req.on('error', (error: NodeJS.ErrnoException) => {
          if (
            [
              'DEPTH_ZERO_SELF_SIGNED_CERT',
              'SELF_SIGNED_CERT_IN_CHAIN',
              'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
              'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
            ].includes(error.code ?? '')
          )
            reject(new CentralDiscoveryTlsError());
          else reject(unavailable());
        });
        req.end();
      });
    let bootstrap;
    try {
      bootstrap = centralClientAuthConfig(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(await get('api/v1/client-auth/config')),
        ),
      );
    } catch (cause) {
      if (cause instanceof KnowledgeSyncError) throw cause;
      throw unavailable();
    }
    if (
      !bootstrap.serverId ||
      !bootstrap.methods.includes('api-key') ||
      !bootstrap.clientIds.includes(clientId)
    )
      throw new KnowledgeSyncError(
        'incompatible',
        'The server does not support this API-key client.',
      );
    const body = await get('api/v1/client-auth/connection-options', bootstrap.serverId);
    if (controller.signal.aborted) throw unavailable();
    try {
      const result = centralConnectionOptions(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)),
      );
      if (
        result.serverId !== bootstrap.serverId ||
        normalizeCentralServerUrl(result.serverUrl) !== base ||
        result.clientId !== clientId ||
        new Set(result.repositories.map((r) => r.repositoryId)).size !==
          result.repositories.length ||
        new Set(result.trustedKeys.map((k) => k.id)).size !== result.trustedKeys.length ||
        result.trustedKeys.some((k) => /PRIVATE KEY/.test(k.pem))
      )
        throw Error();
      if (result.ca !== null) validateCentralCa(result.ca);
      for (const repo of result.repositories) {
        if (repo.serverId !== result.serverId || repo.tenantId !== result.tenantId) throw Error();
        new TrustedCentralBinding({
          serverUrl: base,
          audience: {
            serverId: repo.serverId,
            tenantId: repo.tenantId,
            repositoryId: repo.repositoryId,
            userId: 'pending-user',
          },
          trustedKeys: new Map(result.trustedKeys.map((k) => [k.id, k.pem])),
        });
      }
      // Keep the trust explicitly chosen by the user; do not replace it with a discovered CA.
      return { ...result, serverUrl: base, ca: ca ?? result.ca };
    } catch {
      throw new KnowledgeSyncError(
        'invalid-binding',
        'Central connection metadata does not match the selected server or client.',
      );
    }
  } catch (cause) {
    if (controller.signal.aborted)
      throw new KnowledgeSyncError(
        timedOut ? 'timeout' : 'cancelled',
        'Central discovery stopped.',
      );
    throw cause;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
