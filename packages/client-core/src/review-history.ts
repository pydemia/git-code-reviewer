import {
  canonicalKnowledgeJson,
  centralMemoryContent,
  reviewHistoryRequest,
  type ReviewHistoryRequest,
} from '@gcr/client-contract';
import {
  reviewHistoryGuidance,
  reviewHistoryDetail,
  reviewHistoryMessagePage,
  type ReviewHistoryResponse,
  type ReviewHistoryMessage,
} from '@gcr/client-contract';
import { KnowledgeSyncError } from './central-binding.js';
import type { CentralSelection } from './central-selection.js';
export type SourceHistoryContext = {
  format: 'review-history-source-v1';
  repositoryId: string;
  repositoryName?: string | undefined;
  pullNumber: number;
  apiRevision: string;
  source: ReviewHistoryMessage;
  replies: ReviewHistoryMessage[];
  repliesComplete: boolean;
};

/** Expand at most five already selected source-linked guidelines. Selection is
 * local; requests contain only central IDs. Missing history never replaces the
 * base review, while an authority failure stops use of central material. */
export async function loadSelectedSourceHistory(
  selection: CentralSelection,
  read: (request: ReviewHistoryRequest) => Promise<{ data: ReviewHistoryResponse }>,
): Promise<SourceHistoryContext[]> {
  const result: SourceHistoryContext[] = [];
  for (const item of selection.items
    .filter(
      (item) =>
        item.component === 'collective' &&
        item.kind === 'memory' &&
        /^[a-f0-9-]{36}$/.test(item.id),
    )
    .slice(0, 5)) {
    try {
      const guidance = reviewHistoryGuidance(
        (await read({ kind: 'guidance-detail', guidanceId: item.id })).data,
      );
      if (
        guidance.needsReview ||
        guidance.state !== 'active' ||
        guidance.source.upstreamState !== 'present'
      )
        continue;
      const memory = (item.value as { memory?: { sourceRevision: number; content: unknown } })
        .memory;
      if (
        !memory ||
        memory.sourceRevision !== guidance.revision ||
        canonicalKnowledgeJson(centralMemoryContent(memory.content)) !==
          canonicalKnowledgeJson(guidance.content)
      )
        continue;
      const pullNumber = guidance.source.pullNumber;
      const detail = reviewHistoryDetail(
        (await read({ kind: 'message', pullNumber, sourceId: guidance.source.id })).data,
      );
      if (
        detail.item.contentHash !== guidance.source.contentHash ||
        detail.item.observationHash !== guidance.source.observationHash
      )
        continue;
      const source = detail.item;
      const current = (value: ReturnType<typeof reviewHistoryDetail>) => {
        if (value.revision !== detail.revision)
          throw new KnowledgeSyncError('superseded', 'History changed during capture.');
        return value.item;
      };
      const replies: ReviewHistoryMessage[] = [];
      let complete = true;
      if (source.kind === 'review-comment') {
        const page = reviewHistoryMessagePage(
          (await read({ kind: 'messages', pullNumber, parentId: source.parentId ?? source.id }))
            .data,
        );
        if (page.revision !== detail.revision)
          throw new KnowledgeSyncError('superseded', 'History changed during capture.');
        complete = page.nextCursor === null;
        if (source.parentId)
          replies.push(
            current(
              reviewHistoryDetail(
                (await read({ kind: 'message', pullNumber, sourceId: source.parentId })).data,
              ),
            ),
          );
        for (const reply of page.items.filter((reply) => reply.id !== source.id).slice(0, 10))
          replies.push(
            current(
              reviewHistoryDetail(
                (await read({ kind: 'message', pullNumber, sourceId: reply.id })).data,
              ),
            ),
          );
        if (page.items.length > 10) complete = false;
      }
      if (!result.some((entry) => entry.source.id === source.id))
        result.push({
          format: 'review-history-source-v1',
          repositoryId: detail.repositoryId,
          pullNumber,
          apiRevision: detail.revision,
          source,
          replies,
          repliesComplete: complete,
        });
    } catch (error) {
      if (
        !(error instanceof KnowledgeSyncError) ||
        !['unavailable', 'timeout', 'cache-unavailable', 'superseded'].includes(error.code)
      )
        throw error;
      // An older server or an uncached source may lack this optional context.
    }
  }
  return result;
}
/** Only server-owned identifiers and pagination cross this boundary. */
export function historyReadRoute(
  repositoryId: string,
  value: unknown,
): { request: ReviewHistoryRequest; route: string } {
  const request = reviewHistoryRequest(value);
  const common = ['kind'];
  const allowed: Record<ReviewHistoryRequest['kind'], string[]> = {
    pulls: ['pullNumber', 'cursor', 'revision'],
    messages: ['pullNumber', 'parentId', 'cursor', 'revision'],
    message: ['pullNumber', 'sourceId'],
    versions: ['pullNumber', 'sourceId', 'cursor'],
    observations: ['pullNumber', 'sourceId', 'cursor'],
    guidance: ['sourceId', 'cursor'],
    'guidance-detail': ['guidanceId'],
  };
  if (Object.keys(request).some((key) => ![...common, ...allowed[request.kind]].includes(key)))
    throw Error('invalid-history-request');
  const base = `api/v1/repositories/${encodeURIComponent(repositoryId)}/review-history`;
  let route = base;
  if (['messages', 'message', 'versions', 'observations'].includes(request.kind)) {
    if (!request.pullNumber) throw Error('invalid-history-request');
    route += `/pulls/${request.pullNumber}/messages`;
    if (request.kind !== 'messages') {
      if (!request.sourceId) throw Error('invalid-history-request');
      route += '/' + request.sourceId;
      if (request.kind === 'versions') route += '/versions';
      if (request.kind === 'observations') route += '/history';
    }
  } else if (request.kind === 'guidance') route += '/guidance';
  else if (request.kind === 'guidance-detail') {
    if (!request.guidanceId) throw Error('invalid-history-request');
    route += '/guidance/' + request.guidanceId;
  }
  const query = new URLSearchParams();
  for (const name of ['cursor', 'revision', 'parentId'] as const)
    if (request[name]) query.set(name, request[name]);
  if (request.kind === 'pulls' && request.pullNumber)
    query.set('pullNumber', String(request.pullNumber));
  if (request.kind === 'guidance' && request.sourceId) query.set('sourceId', request.sourceId);
  return { request, route: route + (query.size ? '?' + query.toString() : '') };
}
