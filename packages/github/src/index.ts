import { createHash } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';

const pullSchema = z.object({
  id: z.number(),
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean().nullable().default(false),
  html_url: z.string().url(),
  updated_at: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  base: z.object({ sha: z.string(), ref: z.string() }),
  head: z.object({ sha: z.string(), ref: z.string() }),
});

export type PullRequestObservation = {
  githubId: number;
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft: boolean;
  url: string;
  author: string;
  baseSha: string;
  baseRef: string;
  headSha: string;
  headRef: string;
  updatedAt: string;
};

export type RepositoryTarget = {
  installationId: string;
  apiBaseUrl: string;
  owner: string;
  name: string;
};

export type PullResult =
  | { outcome: 'not-modified'; etag: string | null; pulls: [] }
  | { outcome: 'updated'; etag: string | null; pulls: PullRequestObservation[] };

export interface GitHubReader {
  listOpenPulls(target: RepositoryTarget, etag?: string | null): Promise<PullResult>;
}

export class GitHubRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryable: boolean,
    public readonly retryAfterSeconds: number | null,
  ) {
    super(`GitHub request failed with HTTP ${status}`);
  }
}

type CachedToken = { token: string; expiresAt: number };

export class GitHubAppClient implements GitHubReader {
  private readonly tokens = new Map<string, CachedToken>();
  private keyPromise: Promise<CryptoKey> | undefined;

  constructor(
    private readonly appId: string,
    private readonly privateKey: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async listOpenPulls(target: RepositoryTarget, etag?: string | null): Promise<PullResult> {
    const pulls: PullRequestObservation[] = [];
    let page = 1;
    let responseEtag: string | null = null;

    while (page <= 20) {
      const url = new URL(
        `repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/pulls`,
        ensureTrailingSlash(target.apiBaseUrl),
      );
      url.searchParams.set('state', 'open');
      url.searchParams.set('sort', 'updated');
      url.searchParams.set('direction', 'desc');
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(page));

      const response = await this.installationRequest(
        target.installationId,
        target.apiBaseUrl,
        url,
        {
          headers: page === 1 && etag ? { 'if-none-match': etag } : {},
        },
      );
      if (response.status === 304) {
        return { outcome: 'not-modified', etag: etag ?? null, pulls: [] };
      }
      responseEtag ??= response.headers.get('etag');
      const body = z.array(pullSchema).parse(await response.json());
      pulls.push(...body.map(normalizePull));
      if (body.length < 100) break;
      page += 1;
    }

    return { outcome: 'updated', etag: responseEtag, pulls };
  }

  private async installationRequest(
    installationId: string,
    apiBaseUrl: string,
    url: URL,
    init: RequestInit,
    allowTokenRefresh = true,
  ): Promise<Response> {
    const token = await this.installationToken(installationId, apiBaseUrl);
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/vnd.github+json');
    headers.set('authorization', `Bearer ${token}`);
    headers.set('x-github-api-version', '2022-11-28');
    const response = await this.request(url, { ...init, headers });
    if (response.ok || response.status === 304) return response;

    if (response.status === 401 && allowTokenRefresh) {
      this.tokens.delete(`${apiBaseUrl}:${installationId}`);
      return this.installationRequest(installationId, apiBaseUrl, url, init, false);
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new GitHubRequestError(
      response.status,
      response.status === 429 || response.status >= 500,
      Number.isFinite(retryAfter) ? retryAfter : null,
    );
  }

  private async installationToken(installationId: string, apiBaseUrl: string): Promise<string> {
    const cacheKey = `${apiBaseUrl}:${installationId}`;
    const cached = this.tokens.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const jwt = await this.appJwt();
    const tokenUrl = new URL(
      `app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      ensureTrailingSlash(apiBaseUrl),
    );
    const response = await this.request(tokenUrl, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${jwt}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!response.ok) {
      throw new GitHubRequestError(response.status, response.status >= 500, null);
    }
    const body = z
      .object({ token: z.string(), expires_at: z.string() })
      .parse(await response.json());
    this.tokens.set(cacheKey, {
      token: body.token,
      expiresAt: new Date(body.expires_at).getTime(),
    });
    return body.token;
  }

  private async appJwt(): Promise<string> {
    this.keyPromise ??= importPKCS8(this.privateKey, 'RS256');
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 540)
      .setIssuer(this.appId)
      .sign(await this.keyPromise);
  }
}

export class FixtureGitHubClient implements GitHubReader {
  async listOpenPulls(target: RepositoryTarget, etag?: string | null): Promise<PullResult> {
    const fixtureEtag = `"fixture-${createHash('sha1').update(`${target.owner}/${target.name}`).digest('hex').slice(0, 8)}"`;
    if (etag === fixtureEtag) return { outcome: 'not-modified', etag, pulls: [] };
    return {
      outcome: 'updated',
      etag: fixtureEtag,
      pulls: fixturePulls(target),
    };
  }
}

export function buildPermanentFileUrl(
  webBaseUrl: string,
  owner: string,
  repository: string,
  commitSha: string,
  filePath: string,
  lineStart?: number,
  lineEnd?: number,
): string {
  if (!/^[a-f0-9]{40}$/i.test(commitSha)) throw new Error('A full commit SHA is required');
  const segments = filePath.split('/');
  if (
    !segments.length ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Unsafe file path');
  }
  if (lineStart !== undefined && (!Number.isInteger(lineStart) || lineStart < 1)) {
    throw new Error('Invalid line start');
  }
  if (lineEnd !== undefined && (!lineStart || !Number.isInteger(lineEnd) || lineEnd < lineStart)) {
    throw new Error('Invalid line end');
  }
  const encodedPath = segments.map(encodeURIComponent).join('/');
  const base = ensureTrailingSlash(webBaseUrl);
  const url = new URL(
    `${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/blob/${commitSha}/${encodedPath}`,
    base,
  );
  if (lineStart)
    url.hash = lineEnd && lineEnd !== lineStart ? `L${lineStart}-L${lineEnd}` : `L${lineStart}`;
  return url.toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function normalizePull(pull: z.infer<typeof pullSchema>): PullRequestObservation {
  return {
    githubId: pull.id,
    number: pull.number,
    title: pull.title,
    state: pull.state,
    draft: pull.draft ?? false,
    url: pull.html_url,
    author: pull.user?.login ?? 'unknown',
    baseSha: pull.base.sha,
    baseRef: pull.base.ref,
    headSha: pull.head.sha,
    headRef: pull.head.ref,
    updatedAt: pull.updated_at,
  };
}

function fixturePulls(target: RepositoryTarget): PullRequestObservation[] {
  const base = `${target.owner}/${target.name}`;
  return [
    {
      githubId: 18_400,
      number: 184,
      title: 'Harden session rotation and token exchange',
      state: 'open',
      draft: false,
      url: `https://github.example.internal/${base}/pull/184`,
      author: 'minseo-kim',
      baseSha: 'a13f2c8ef8ab792f7428c8bd45d86f2aa97f6d01',
      baseRef: 'main',
      headSha: 'd91b7a4f19af10fcb571cefb2d8a61495166c11a',
      headRef: 'feature/session-rotation',
      updatedAt: new Date(Date.now() - 8 * 60_000).toISOString(),
    },
    {
      githubId: 18_100,
      number: 181,
      title: 'Add repository polling budget controls',
      state: 'open',
      draft: false,
      url: `https://github.example.internal/${base}/pull/181`,
      author: 'jaehyun-lee',
      baseSha: '8b62f9ea1cae1079118d5d06e98b42a35c2fcf31',
      baseRef: 'main',
      headSha: 'e620840845116793a2556901701806b571d95d4e',
      headRef: 'feature/poll-budget',
      updatedAt: new Date(Date.now() - 34 * 60_000).toISOString(),
    },
  ];
}
