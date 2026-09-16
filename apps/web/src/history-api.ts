import { browserUuid } from './browser-uuid.ts';
import {
  reviewHistoryBodyVersionListSchema,
  reviewHistoryPullListSchema,
  reviewHistoryMessageListSchema,
  reviewHistoryMessageDetailSchema,
  reviewHistoryObservationListSchema,
} from '@gcr/contracts';
import { fetchJson, mutateJson } from './api.ts';
const base = (repo: string) => `/api/v1/repositories/${encodeURIComponent(repo)}/review-history`;
const suffix = (cursor?: string | null) => (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
export const loadHistoryPulls = async (repo: string, signal: AbortSignal, cursor?: string | null) =>
  reviewHistoryPullListSchema.parse(await fetchJson(base(repo) + suffix(cursor), signal));
export const loadHistoryMessages = async (
  repo: string,
  number: number,
  signal: AbortSignal,
  cursor?: string | null,
) =>
  reviewHistoryMessageListSchema.parse(
    await fetchJson(`${base(repo)}/pulls/${number}/messages${suffix(cursor)}`, signal),
  );
export const loadHistoryMessage = async (
  repo: string,
  number: number,
  id: string,
  signal: AbortSignal,
) =>
  reviewHistoryMessageDetailSchema.parse(
    await fetchJson(`${base(repo)}/pulls/${number}/messages/${id}`, signal),
  );
export const loadHistoryObservations = async (
  repo: string,
  number: number,
  id: string,
  signal: AbortSignal,
  cursor?: string | null,
) =>
  reviewHistoryObservationListSchema.parse(
    await fetchJson(
      `${base(repo)}/pulls/${number}/messages/${id}/history${suffix(cursor)}`,
      signal,
    ),
  );
export type HistoryCollection = {
  id: string;
  state: string;
  completed: number;
  total: number;
  nextCursor: number | null;
  items: { number: number; state: string; attempts: number; errorCode: string | null }[];
};
export const collectHistory = async (repo: string, pullNumbers: number[]) =>
  (await mutateJson(`${base(repo)}/collections`, 'POST', {
    requestKey: browserUuid(),
    pullNumbers,
  })) as HistoryCollection;
export const loadHistoryCollection = async (repo: string, id: string, signal: AbortSignal) =>
  (await fetchJson(`${base(repo)}/collections/${id}`, signal)) as HistoryCollection;
export const retryHistoryCollection = async (repo: string, id: string) =>
  (await mutateJson(`${base(repo)}/collections/${id}/retry`, 'POST', {})) as HistoryCollection;

export type HistoryGuidance = {
  schemaVersion: 1;
  repositoryId: string;
  id: string;
  revision: number;
  state: string;
  needsReview: boolean;
  publicationRequested: boolean;
  content: import('@gcr/client-contract').CentralMemoryContent;
  source: {
    id: string;
    pullNumber: number;
    htmlUrl: string;
    contentHash: string;
    observationHash: string | null;
    upstreamState: 'present' | 'not-returned';
  };
};
export const loadHistoryGuidance = async (
  repo: string,
  source: string,
  signal: AbortSignal,
  cursor?: string | null,
) =>
  (await fetchJson(
    `${base(repo)}/guidance?sourceId=${source}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
    signal,
  )) as { items: HistoryGuidance[]; nextCursor: string | null };
export const createHistoryGuidance = async (
  repo: string,
  source: { id: string; contentHash: string; observationHash: string | null },
  content: HistoryGuidance['content'],
) =>
  (await mutateJson(`${base(repo)}/guidance`, 'POST', {
    sourceId: source.id,
    contentHash: source.contentHash,
    observationHash: source.observationHash,
    content,
  })) as HistoryGuidance;
export const changeHistoryGuidance = async (
  repo: string,
  item: HistoryGuidance,
  action: 'activate' | 'retire',
) =>
  (await mutateJson(`${base(repo)}/guidance/${item.id}/${action}`, 'POST', {
    revision: item.revision,
  })) as HistoryGuidance;

export const loadHistoryBodyVersions = async (
  repo: string,
  number: number,
  id: string,
  signal: AbortSignal,
  cursor?: string | null,
) =>
  reviewHistoryBodyVersionListSchema.parse(
    await fetchJson(
      `${base(repo)}/pulls/${number}/messages/${id}/versions${suffix(cursor)}`,
      signal,
    ),
  );
