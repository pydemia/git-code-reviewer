import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { centralCredentialIdentity } from '@gcr/client-contract';
import type { IncomingMessage } from 'node:http';
import { KnowledgeSyncError, TrustedCentralBinding } from './central-binding.js';
import type { KnowledgeTransport } from './central-cache.js';

type Credential = { bindingId: string; readToken(): Promise<string | undefined> };
const unavailable = () => new KnowledgeSyncError('unavailable', 'Central HTTP request failed.');
/** The host supplies an explicitly bound OS credential port. No cookies, discovery or redirects. */
export class KnowledgeHttpTransport implements KnowledgeTransport {
  constructor(
    private readonly binding: TrustedCentralBinding,
    private readonly credential: Credential,
    private readonly ca?: string,
  ) {
    if (!(binding instanceof TrustedCentralBinding) || credential.bindingId !== binding.id)
      throw new KnowledgeSyncError(
        'invalid-binding',
        'Credential binding does not match the selected server and audience.',
      );
  }
  private async get(
    relative: string,
    signal: AbortSignal,
    etag?: string,
  ): Promise<IncomingMessage> {
    if (signal.aborted) throw unavailable();
    if (this.credential.bindingId !== this.binding.id)
      throw new KnowledgeSyncError('invalid-binding', 'Credential binding changed.');
    let token: string | undefined;
    try {
      token = await this.credential.readToken();
    } catch {
      throw unavailable();
    }
    if (signal.aborted) throw unavailable();
    if (this.credential.bindingId !== this.binding.id)
      throw new KnowledgeSyncError('invalid-binding', 'Credential binding changed.');
    if (!token || !/^gcr_key_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/.test(token))
      throw new KnowledgeSyncError('authentication-required', 'A central API key is required.');
    const target = new URL(relative, this.binding.serverUrl);
    const base = new URL(this.binding.serverUrl);
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname))
      throw unavailable();
    return new Promise((resolve, reject) => {
      const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = request(
        target,
        {
          method: 'GET',
          signal,
          ...(target.protocol === 'https:'
            ? { rejectUnauthorized: true, ...(this.ca ? { ca: this.ca } : {}) }
            : {}),
          headers: {
            authorization: `Bearer ${token}`,
            'x-gcr-server-id': this.binding.audience.serverId,
            accept: 'application/json',
            ...(etag ? { 'if-none-match': etag } : {}),
          },
        },
        resolve,
      );
      req.on('error', () => reject(unavailable()));
      req.end();
    });
  }
  private failure(
    response: IncomingMessage,
  ): Exclude<Awaited<ReturnType<KnowledgeTransport['bundle']>>, { status: 200 }> {
    const status = response.statusCode ?? 503;
    response.destroy();
    if (
      status === 401 ||
      status === 403 ||
      status === 404 ||
      status === 409 ||
      status === 426 ||
      status === 429 ||
      status === 500 ||
      status === 502 ||
      status === 503 ||
      status === 504
    )
      return { status };
    // Redirects are never followed, even within the same origin.
    return { status: 503 };
  }
  /** Initial publication can take a worker cycle. Retry only an actual HTTP 503,
   * never redirects, network/TLS errors, rejected credentials or malformed data.
   * The cache supplies the overall abort deadline and keeps its claim throughout. */
  initialPublication(): KnowledgeTransport {
    return {
      manifest: (request) => this.readManifest(request, 15),
      bundle: (request) => this.bundle(request),
    };
  }
  manifest(
    request: Parameters<KnowledgeTransport['manifest']>[0],
  ): ReturnType<KnowledgeTransport['manifest']> {
    return this.readManifest(request, 0);
  }
  private async readManifest(
    { etag, signal }: Parameters<KnowledgeTransport['manifest']>[0],
    retries: number,
  ): ReturnType<KnowledgeTransport['manifest']> {
    const route = `api/v1/repositories/${encodeURIComponent(this.binding.audience.repositoryId)}/review-knowledge/manifest?clientContractVersion=2`;
    let response = await this.get(route, signal, etag);
    for (let attempt = 0; response.statusCode === 503 && attempt < retries; attempt++) {
      response.destroy();
      const milliseconds = Math.round(
        Math.min(4000, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5),
      );
      await delay(milliseconds, undefined, { signal });
      response = await this.get(route, signal, etag);
    }
    if (response.statusCode === 304) {
      response.destroy();
      return { status: 304 };
    }
    if (response.statusCode !== 200) return this.failure(response);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 65536) throw unavailable();
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks);
      const text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes)) throw unavailable();
      return { status: 200, manifest: JSON.parse(text) };
    } catch {
      throw unavailable();
    } finally {
      response.destroy();
    }
  }
  async identity(signal: AbortSignal) {
    const response = await this.get('api/v1/client-auth/me', signal);
    if (response.statusCode !== 200) {
      const failure = this.failure(response);
      throw new KnowledgeSyncError(
        failure.status === 401
          ? 'authentication-required'
          : failure.status === 403
            ? 'revoked'
            : 'unavailable',
        'Central identity could not be verified.',
      );
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 32768) throw unavailable();
        chunks.push(bytes);
      }
      return centralCredentialIdentity(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
      );
    } catch {
      throw unavailable();
    } finally {
      response.destroy();
    }
  }
  async bundle({
    snapshotId,
    bundleId,
    signal,
  }: Parameters<KnowledgeTransport['bundle']>[0]): ReturnType<KnowledgeTransport['bundle']> {
    const response = await this.get(
      `api/v1/repositories/${encodeURIComponent(this.binding.audience.repositoryId)}/review-knowledge/bundles/${encodeURIComponent(bundleId)}?snapshotId=${encodeURIComponent(snapshotId)}`,
      signal,
    );
    if (response.statusCode !== 200) return this.failure(response);
    return {
      status: 200,
      body: (async function* () {
        try {
          for await (const chunk of response) yield Buffer.from(chunk);
        } catch {
          throw unavailable();
        } finally {
          response.destroy();
        }
      })(),
    };
  }
}
