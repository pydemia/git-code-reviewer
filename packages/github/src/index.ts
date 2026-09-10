import { createHash } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';

const pullSchema = z.object({
  id: z.number(),
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  merged_at: z.string().nullable().optional(),
  draft: z.boolean().nullable().default(false),
  html_url: z.string().url(),
  updated_at: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  base: z.object({ sha: z.string(), ref: z.string() }),
  head: z.object({ sha: z.string(), ref: z.string() }),
});

const issueCommentSchema = z.object({
  id: z.number().int().positive(),
  html_url: z.string().url(),
  body: z.string().nullable(),
});

const conversationAuthorSchema = z
  .object({ login: z.string(), type: z.string().default('User') })
  .nullable();
const pullIssueCommentSchema = issueCommentSchema.extend({
  user: conversationAuthorSchema,
  created_at: z.string(),
  updated_at: z.string(),
});
const pullReviewSchema = z.object({
  id: z.number().int().positive(),
  html_url: z.string().url(),
  body: z.string().nullable(),
  user: conversationAuthorSchema,
  commit_id: z.string().nullable().optional(),
  submitted_at: z.string().nullable(),
});
const pullReviewCommentSchema = pullIssueCommentSchema.extend({
  path: z.string(),
  line: z.number().int().positive().nullable().optional(),
  original_line: z.number().int().positive().nullable().optional(),
  side: z.enum(['LEFT', 'RIGHT']).nullable().optional(),
  commit_id: z.string().nullable().optional(),
  in_reply_to_id: z.number().int().positive().nullable().optional(),
});

export type PullRequestObservation = {
  githubId: number;
  number: number;
  title: string;
  state: 'open' | 'closed';
  mergedAt?: string | null;
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

export type PullRequestMessageObservation = {
  githubId: number;
  kind: 'issue-comment' | 'review' | 'review-comment';
  author: string;
  authorType: string;
  body: string;
  path: string | null;
  line: number | null;
  side: 'LEFT' | 'RIGHT' | null;
  commitSha: string | null;
  inReplyToGithubId: number | null;
  url: string;
  createdAt: string;
  updatedAt: string;
};

export interface GitHubReader {
  listPulls(target: RepositoryTarget, etag?: string | null): Promise<PullResult>;
  listPullRequestMessages?(
    target: RepositoryTarget,
    pullNumber: number,
  ): Promise<PullRequestMessageObservation[]>;
  getGitCredential?(target: RepositoryTarget): Promise<{ username: string; password: string }>;
}

export type PullRequestCommentPublication = {
  commentId: number;
  commentUrl: string;
  outcome: 'created' | 'updated';
};

export interface GitHubReviewPublisher {
  upsertPullRequestComment(
    target: RepositoryTarget,
    input: {
      pullNumber: number;
      marker: string;
      body: string;
      existingCommentId?: number | null;
    },
  ): Promise<PullRequestCommentPublication>;
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

export class GitHubAppClient implements GitHubReader, GitHubReviewPublisher {
  private readonly tokens = new Map<string, CachedToken>();
  private keyPromise: Promise<CryptoKey> | undefined;

  constructor(
    private readonly appId: string,
    private readonly privateKey: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async listPulls(target: RepositoryTarget, etag?: string | null): Promise<PullResult> {
    return listRepositoryPulls(target, etag, (url, init) =>
      this.installationRequest(target.installationId, target.apiBaseUrl, url, init),
    );
  }

  async getGitCredential(
    target: RepositoryTarget,
  ): Promise<{ username: string; password: string }> {
    return {
      username: 'x-access-token',
      password: await this.installationToken(target.installationId, target.apiBaseUrl),
    };
  }

  async listPullRequestMessages(
    target: RepositoryTarget,
    pullNumber: number,
  ): Promise<PullRequestMessageObservation[]> {
    return listPullRequestMessages(target, pullNumber, (url, init) =>
      this.installationRequest(target.installationId, target.apiBaseUrl, url, init),
    );
  }

  async upsertPullRequestComment(
    target: RepositoryTarget,
    input: {
      pullNumber: number;
      marker: string;
      body: string;
      existingCommentId?: number | null;
    },
  ): Promise<PullRequestCommentPublication> {
    return upsertPullRequestComment(target, input, (url, init) =>
      this.installationRequest(target.installationId, target.apiBaseUrl, url, init),
    );
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
      await response.body?.cancel().catch(() => undefined);
      this.tokens.delete(`${apiBaseUrl}:${installationId}`);
      return this.installationRequest(installationId, apiBaseUrl, url, init, false);
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    await response.body?.cancel().catch(() => undefined);
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

export class GitHubAccessTokenClient implements GitHubReader, GitHubReviewPublisher {
  constructor(
    private readonly token: string,
    private readonly request: typeof fetch = fetch,
  ) {
    if (!token.trim()) throw new Error('GitHub access token is required');
  }

  async listPulls(target: RepositoryTarget, etag?: string | null): Promise<PullResult> {
    return listRepositoryPulls(target, etag, (url, init) => this.authenticatedRequest(url, init));
  }

  async getGitCredential(): Promise<{ username: string; password: string }> {
    return { username: 'git-code-reviewer', password: this.token };
  }

  async listPullRequestMessages(
    target: RepositoryTarget,
    pullNumber: number,
  ): Promise<PullRequestMessageObservation[]> {
    return listPullRequestMessages(target, pullNumber, (url, init) =>
      this.authenticatedRequest(url, init),
    );
  }

  async upsertPullRequestComment(
    target: RepositoryTarget,
    input: {
      pullNumber: number;
      marker: string;
      body: string;
      existingCommentId?: number | null;
    },
  ): Promise<PullRequestCommentPublication> {
    return upsertPullRequestComment(target, input, (url, init) =>
      this.authenticatedRequest(url, init),
    );
  }

  private async authenticatedRequest(url: URL, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/vnd.github+json');
    headers.set('authorization', `Bearer ${this.token}`);
    headers.set('x-github-api-version', '2022-11-28');
    const response = await this.request(url, { ...init, headers });
    if (response.ok || response.status === 304) return response;
    const retryAfter = Number(response.headers.get('retry-after'));
    await response.body?.cancel().catch(() => undefined);
    throw new GitHubRequestError(
      response.status,
      response.status === 429 || response.status >= 500,
      Number.isFinite(retryAfter) ? retryAfter : null,
    );
  }
}

export class FixtureGitHubClient implements GitHubReader {
  async listPulls(target: RepositoryTarget, etag?: string | null): Promise<PullResult> {
    const fixtureEtag = `"fixture-${createHash('sha1').update(`${target.owner}/${target.name}`).digest('hex').slice(0, 8)}"`;
    if (etag === fixtureEtag) return { outcome: 'not-modified', etag, pulls: [] };
    return {
      outcome: 'updated',
      etag: fixtureEtag,
      pulls: fixturePulls(target),
    };
  }

  async listPullRequestMessages(
    target: RepositoryTarget,
    pullNumber: number,
  ): Promise<PullRequestMessageObservation[]> {
    const createdAt = new Date(Date.now() - 20 * 60_000).toISOString();
    return [
      {
        githubId: pullNumber * 10_000 + 1,
        kind: 'issue-comment',
        author: 'reviewer',
        authorType: 'User',
        body: '이 저장소에서는 재시도 시 같은 요청 키를 유지해야 합니다.',
        path: null,
        line: null,
        side: null,
        commitSha: null,
        inReplyToGithubId: null,
        url: `https://github.example.internal/${target.owner}/${target.name}/pull/${pullNumber}#issuecomment-${pullNumber * 10_000 + 1}`,
        createdAt,
        updatedAt: createdAt,
      },
    ];
  }
}

type AuthenticatedRequest = (url: URL, init: RequestInit) => Promise<Response>;

async function listPullRequestMessages(
  target: RepositoryTarget,
  pullNumber: number,
  request: AuthenticatedRequest,
): Promise<PullRequestMessageObservation[]> {
  const [issueComments, reviews, reviewComments] = await Promise.all([
    paginatedRequest(target, `issues/${pullNumber}/comments`, pullIssueCommentSchema, request),
    paginatedRequest(target, `pulls/${pullNumber}/reviews`, pullReviewSchema, request),
    paginatedRequest(target, `pulls/${pullNumber}/comments`, pullReviewCommentSchema, request),
  ]);
  return [
    ...issueComments.flatMap((comment) =>
      comment.body?.trim()
        ? [
            {
              githubId: comment.id,
              kind: 'issue-comment' as const,
              author: comment.user?.login ?? 'unknown',
              authorType: comment.user?.type ?? 'Unknown',
              body: comment.body.trim(),
              path: null,
              line: null,
              side: null,
              commitSha: null,
              inReplyToGithubId: null,
              url: comment.html_url,
              createdAt: comment.created_at,
              updatedAt: comment.updated_at,
            },
          ]
        : [],
    ),
    ...reviews.flatMap((review) =>
      review.body?.trim() && review.submitted_at
        ? [
            {
              githubId: review.id,
              kind: 'review' as const,
              author: review.user?.login ?? 'unknown',
              authorType: review.user?.type ?? 'Unknown',
              body: review.body.trim(),
              path: null,
              line: null,
              side: null,
              commitSha: review.commit_id ?? null,
              inReplyToGithubId: null,
              url: review.html_url,
              createdAt: review.submitted_at,
              updatedAt: review.submitted_at,
            },
          ]
        : [],
    ),
    ...reviewComments.flatMap((comment) =>
      comment.body?.trim()
        ? [
            {
              githubId: comment.id,
              kind: 'review-comment' as const,
              author: comment.user?.login ?? 'unknown',
              authorType: comment.user?.type ?? 'Unknown',
              body: comment.body.trim(),
              path: comment.path,
              line: comment.line ?? comment.original_line ?? null,
              side: comment.side ?? null,
              commitSha: comment.commit_id ?? null,
              inReplyToGithubId: comment.in_reply_to_id ?? null,
              url: comment.html_url,
              createdAt: comment.created_at,
              updatedAt: comment.updated_at,
            },
          ]
        : [],
    ),
  ].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.githubId - right.githubId,
  );
}

async function paginatedRequest<T extends z.ZodTypeAny>(
  target: RepositoryTarget,
  path: string,
  schema: T,
  request: AuthenticatedRequest,
): Promise<Array<z.infer<T>>> {
  const items: Array<z.infer<T>> = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = repositoryApiUrl(target, path);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const response = await request(url, { method: 'GET' });
    const body = z.array(schema).parse(await response.json());
    items.push(...body);
    if (body.length < 100) break;
  }
  return items;
}

async function upsertPullRequestComment(
  target: RepositoryTarget,
  input: {
    pullNumber: number;
    marker: string;
    body: string;
    existingCommentId?: number | null;
  },
  request: AuthenticatedRequest,
): Promise<PullRequestCommentPublication> {
  if (!Number.isInteger(input.pullNumber) || input.pullNumber < 1) {
    throw new Error('A positive pull request number is required');
  }
  if (!input.marker || !input.body.includes(input.marker)) {
    throw new Error('The managed comment marker must be present in the body');
  }

  if (input.existingCommentId) {
    try {
      return await writePullRequestComment(target, input.body, input.existingCommentId, request);
    } catch (error) {
      if (!(error instanceof GitHubRequestError) || error.status !== 404) throw error;
    }
  }

  const recoveredCommentId = await findManagedPullRequestComment(
    target,
    input.pullNumber,
    input.marker,
    request,
  );
  return writePullRequestComment(target, input.body, recoveredCommentId, request, input.pullNumber);
}

async function findManagedPullRequestComment(
  target: RepositoryTarget,
  pullNumber: number,
  marker: string,
  request: AuthenticatedRequest,
): Promise<number | null> {
  for (let page = 1; page <= 20; page += 1) {
    const url = repositoryApiUrl(
      target,
      `issues/${encodeURIComponent(String(pullNumber))}/comments`,
    );
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const response = await request(url, { method: 'GET' });
    const comments = z.array(issueCommentSchema).parse(await response.json());
    const match = comments.find((comment) => comment.body?.includes(marker));
    if (match) return match.id;
    if (comments.length < 100) return null;
  }
  return null;
}

async function writePullRequestComment(
  target: RepositoryTarget,
  body: string,
  commentId: number | null,
  request: AuthenticatedRequest,
  pullNumber?: number,
): Promise<PullRequestCommentPublication> {
  const updating = commentId !== null;
  const path = updating
    ? `issues/comments/${encodeURIComponent(String(commentId))}`
    : `issues/${encodeURIComponent(String(pullNumber))}/comments`;
  const response = await request(repositoryApiUrl(target, path), {
    method: updating ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  const comment = issueCommentSchema.parse(await response.json());
  return {
    commentId: comment.id,
    commentUrl: comment.html_url,
    outcome: updating ? 'updated' : 'created',
  };
}

function repositoryApiUrl(target: RepositoryTarget, path: string): URL {
  return new URL(
    `repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/${path}`,
    ensureTrailingSlash(target.apiBaseUrl),
  );
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

// 모든 페이지를 정상적으로 가져온 경우에만 저장한다. 상한 도달 시 부분 결과를 성공으로 처리하지 않는다.
async function listRepositoryPulls(
  target: RepositoryTarget,
  etag: string | null | undefined,
  request: (url: URL, init: RequestInit) => Promise<Response>,
): Promise<PullResult> {
  const pulls = new Map<number, PullRequestObservation>();
  let responseEtag: string | null = null;
  for (let page = 1; page <= 1000; page += 1) {
    const url = new URL(
      `repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/pulls`,
      ensureTrailingSlash(target.apiBaseUrl),
    );
    url.search = new URLSearchParams({
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: '100',
      page: String(page),
    }).toString();
    const response = await request(url, {
      headers: page === 1 && etag ? { 'if-none-match': etag } : {},
      signal: AbortSignal.timeout(30_000),
    });
    if (page === 1 && response.status === 304)
      return { outcome: 'not-modified', etag: etag ?? null, pulls: [] };
    if (page === 1) responseEtag = response.headers.get('etag');
    const body = z.array(pullSchema).parse(await response.json());
    for (const item of body) {
      const pull = normalizePull(item);
      const previous = pulls.get(pull.number);
      if (!previous || pull.updatedAt >= previous.updatedAt) pulls.set(pull.number, pull);
    }
    if (body.length < 100)
      return { outcome: 'updated', etag: responseEtag, pulls: [...pulls.values()] };
  }
  throw new Error('GitHub pull request pagination exceeded 1000 pages');
}

function normalizePull(pull: z.infer<typeof pullSchema>): PullRequestObservation {
  return {
    githubId: pull.id,
    number: pull.number,
    title: pull.title,
    state: pull.state,
    mergedAt: pull.state === 'closed' ? (pull.merged_at ?? null) : null,
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
