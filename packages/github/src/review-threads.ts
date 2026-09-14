import { z } from 'zod';
import type { PullRequestMessageObservation, RepositoryTarget } from './index.js';

type Request = (url: URL, init: RequestInit) => Promise<Response>;
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const comments = z.object({
  nodes: z.array(z.object({ id: z.string().min(1) })).max(100),
  pageInfo,
});
const thread = z.object({
  id: z.string().min(1),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  comments,
});
const query = `query ReviewThreadEvidence($owner:String!,$name:String!,$number:Int!,$after:String) {
  repository(owner:$owner,name:$name) { pullRequest(number:$number) {
    reviewThreads(first:100,after:$after) { nodes { id isResolved isOutdated
      comments(first:100) { nodes { id } pageInfo { hasNextPage endCursor } }
    } pageInfo { hasNextPage endCursor } }
  } }
}`;
const commentQuery = `query ReviewThreadComments($id:ID!,$after:String) {
  node(id:$id) { ... on PullRequestReviewThread { id isResolved isOutdated
    pullRequest { number repository { nameWithOwner } }
    comments(first:100,after:$after) { nodes { id } pageInfo { hasNextPage endCursor } }
  } }
}`;

export function reviewGraphqlUrl(target: RepositoryTarget): URL | null {
  const url = new URL(target.apiBaseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    return null;
  const pathname = url.pathname.replace(/\/$/, '');
  if (url.hostname === 'api.github.com' && !pathname) url.pathname = '/graphql';
  else if (/^api\.[a-z0-9-]+\.ghe\.com$/.test(url.hostname) && !pathname) url.pathname = '/graphql';
  else if (pathname.endsWith('/api/v3')) url.pathname = pathname.slice(0, -3) + '/graphql';
  else return null;
  return url;
}

async function boundedJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw Error('Missing GraphQL response');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 2 * 1024 * 1024) throw Error('GraphQL response limit');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

// REST node_id and GraphQL id identify the same comment without lossy numeric IDs.
export async function enrichReviewThreads(
  target: RepositoryTarget,
  pullNumber: number,
  messages: PullRequestMessageObservation[],
  request: Request,
): Promise<PullRequestMessageObservation[]> {
  if (!messages.some((m) => m.kind === 'review-comment' && m.provenance?.commentNodeId))
    return messages;
  const endpoint = reviewGraphqlUrl(target);
  type State = 'observed' | 'not-observed' | 'unsupported' | 'unavailable' | 'partial';
  let state: State = endpoint ? 'not-observed' : 'unsupported';
  const byComment = new Map<string, { id: string; resolved: boolean; outdated: boolean }>();
  const failure: { state?: State } = {};
  let requests = 0;
  const signal = AbortSignal.timeout(20_000);
  const call = async (document: string, variables: object) => {
    if (++requests > 20) {
      failure.state = 'partial';
      throw Error('GraphQL request budget');
    }
    const response = await request(endpoint!, {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: document, variables }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error('GraphQL HTTP response');
    }
    const result = z
      .object({
        data: z.unknown().optional(),
        errors: z.array(z.object({ type: z.string().optional() })).optional(),
      })
      .parse(await boundedJson(response));
    if (result.errors?.length) {
      if (result.errors.every((e) => e.type === 'undefinedField')) failure.state = 'unsupported';
      throw Error('GraphQL query errors');
    }
    return result.data;
  };
  const add = (item: z.infer<typeof thread>, nodes: Array<{ id: string }>) => {
    for (const comment of nodes) {
      const prior = byComment.get(comment.id);
      if (
        prior &&
        (prior.id !== item.id ||
          prior.resolved !== item.isResolved ||
          prior.outdated !== item.isOutdated)
      )
        throw Error('Conflicting thread observation');
      byComment.set(comment.id, {
        id: item.id,
        resolved: item.isResolved,
        outdated: item.isOutdated,
      });
    }
  };
  try {
    if (endpoint) {
      let after: string | null = null;
      const seen = new Set<string>();
      const threads = new Set<string>();
      for (;;) {
        const data = z
          .object({
            repository: z.object({
              pullRequest: z.object({
                reviewThreads: z.object({ nodes: z.array(thread).max(100), pageInfo }),
              }),
            }),
          })
          .parse(
            await call(query, {
              owner: target.owner,
              name: target.name,
              number: pullNumber,
              after,
            }),
          );
        const page = data.repository.pullRequest.reviewThreads;
        for (const item of page.nodes) {
          if (threads.has(item.id)) throw Error('Repeated thread');
          threads.add(item.id);
          add(item, item.comments.nodes);
          let info = item.comments.pageInfo;
          const commentCursors = new Set<string>();
          while (info.hasNextPage) {
            if (!info.endCursor || commentCursors.has(info.endCursor))
              throw Error('Invalid comment cursor');
            commentCursors.add(info.endCursor);
            const next = z
              .object({
                node: thread.extend({
                  pullRequest: z.object({
                    number: z.number(),
                    repository: z.object({ nameWithOwner: z.string() }),
                  }),
                }),
              })
              .parse(await call(commentQuery, { id: item.id, after: info.endCursor })).node;
            if (
              next.id !== item.id ||
              next.isResolved !== item.isResolved ||
              next.isOutdated !== item.isOutdated ||
              next.pullRequest.number !== pullNumber ||
              next.pullRequest.repository.nameWithOwner.toLowerCase() !==
                `${target.owner}/${target.name}`.toLowerCase()
            )
              throw Error('Thread changed during pagination');
            add(item, next.comments.nodes);
            info = next.comments.pageInfo;
          }
        }
        if (!page.pageInfo.hasNextPage) break;
        if (!page.pageInfo.endCursor || seen.has(page.pageInfo.endCursor))
          throw Error('Invalid thread cursor');
        seen.add(page.pageInfo.endCursor);
        after = page.pageInfo.endCursor;
      }
    }
  } catch {
    byComment.clear();
    state = failure.state ?? 'unavailable';
  }
  return messages.map((message) => {
    if (message.kind !== 'review-comment' || !message.provenance) return message;
    const found = message.provenance.commentNodeId
      ? byComment.get(message.provenance.commentNodeId)
      : undefined;
    return {
      ...message,
      provenance: {
        ...message.provenance,
        threadObservation: found ? 'observed' : state,
        threadId: found?.id ?? null,
        threadResolved: found?.resolved ?? null,
        threadOutdated: found?.outdated ?? null,
      },
    };
  });
}
