import {
  boolean,
  choice,
  integer,
  list,
  literal,
  object,
  optional,
  sha256,
  text,
  union,
} from './codec.js';
import { centralMemoryContent } from './central-knowledge.js';
const uuid = text(36, 36, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
const nullable = <T>(decode: (value: unknown, at?: string) => T) => union(decode, literal(null));
const short = text(4096);
const date = text(64);
const side = nullable(choice(['LEFT', 'RIGHT']));
const cursor = nullable(text(2048));
export const reviewHistoryRequest = object({
  kind: choice([
    'pulls',
    'messages',
    'message',
    'versions',
    'observations',
    'guidance',
    'guidance-detail',
  ]),
  pullNumber: optional(integer(1, 2147483647)),
  sourceId: optional(uuid),
  guidanceId: optional(uuid),
  parentId: optional(uuid),
  cursor: optional(text(2048, 1)),
  revision: optional(sha256),
});
export type ReviewHistoryRequest = ReturnType<typeof reviewHistoryRequest>;
const provenance = object({
  provider: literal('github-rest'),
  reviewState: nullable(short),
  reviewGithubId: nullable(short),
  originalCommitSha: nullable(short),
  originalLine: nullable(integer(1)),
  startLine: nullable(integer(1)),
  originalStartLine: nullable(integer(1)),
  startSide: side,
  subjectType: nullable(short),
  diffHunk: nullable(text(1_048_576)),
  commentNodeId: optional(short),
  threadId: optional(nullable(short)),
  threadObservation: optional(
    choice(['observed', 'not-observed', 'unsupported', 'unavailable', 'partial']),
  ),
  threadResolved: nullable(boolean),
  threadOutdated: nullable(boolean),
});
const observationSource = {
  kind: choice(['issue-comment', 'review', 'review-comment']),
  authorLogin: short,
  authorType: short,
  contentHash: sha256,
  path: nullable(short),
  line: nullable(integer(1)),
  side,
  commitSha: nullable(short),
  inReplyToGithubId: nullable(short),
  htmlUrl: short,
  githubCreatedAt: date,
  githubUpdatedAt: date,
};
const source = {
  id: uuid,
  pullRequestId: uuid,
  observationHash: nullable(sha256),
  ...observationSource,
};
const message = {
  ...source,
  githubId: short,
  upstreamState: choice(['present', 'not-returned']),
  parentId: nullable(uuid),
  reviewSourceId: nullable(uuid),
  replyCount: integer(0),
  lastObservedAt: date,
};
export const reviewHistoryMessage = object({
  ...message,
  body: text(1_048_576),
  provenance: nullable(provenance),
});
export type ReviewHistoryMessage = ReturnType<typeof reviewHistoryMessage>;
export const reviewHistoryPull = object({
  id: uuid,
  number: integer(1),
  title: short,
  state: choice(['open', 'closed']),
  htmlUrl: short,
  messageCount: integer(0),
  replyCount: integer(0),
  notReturnedCount: integer(0),
  coverage: object({
    state: choice(['uncollected', 'collected', 'failed', 'collecting']),
    lastCompleteAt: nullable(date),
    syncStartedAt: nullable(date),
    observedCount: nullable(integer(0)),
    errorCode: nullable(short),
  }),
});
const base = { schemaVersion: literal(1), repositoryId: uuid, revision: sha256 };
export const reviewHistoryPullPage = object({
  ...base,
  items: list(reviewHistoryPull, 50),
  nextCursor: cursor,
  capabilities: object({ manage: boolean }),
});
export const reviewHistoryMessagePage = object({
  ...base,
  pull: reviewHistoryPull,
  items: list(object({ ...message, excerpt: text(500), bodyCharacters: integer(0) }), 50),
  nextCursor: cursor,
});
export const reviewHistoryDetail = object({
  ...base,
  pullNumber: integer(1),
  item: reviewHistoryMessage,
});
export const reviewHistoryVersionPage = object({
  ...base,
  sourceId: uuid,
  nextCursor: cursor,
  items: list(
    object({
      id: uuid,
      body: text(1_048_576),
      contentHash: sha256,
      path: nullable(short),
      line: nullable(integer(1)),
      side,
      commitSha: nullable(short),
      githubUpdatedAt: date,
      observedAt: date,
    }),
    10,
  ),
});
export const reviewHistoryObservationPage = object({
  ...base,
  sourceId: uuid,
  nextCursor: cursor,
  items: list(
    object({
      id: text(30, 1, /^[1-9][0-9]*$/),
      observationHash: sha256,
      observedAt: date,
      syncStartedAt: date,
      snapshot: object({
        ...observationSource,
        githubId: short,
        body: text(1_048_576),
        provenance: nullable(provenance),
        upstreamState: optional(choice(['present', 'not-returned'])),
      }),
    }),
    10,
  ),
});
export const reviewHistoryGuidance = object({
  schemaVersion: literal(1),
  repositoryId: uuid,
  id: uuid,
  revision: integer(1),
  state: choice(['candidate', 'active', 'retired', 'rejected']),
  needsReview: boolean,
  publicationRequested: boolean,
  content: centralMemoryContent,
  source: object({
    id: uuid,
    pullNumber: integer(1),
    htmlUrl: short,
    contentHash: sha256,
    observationHash: nullable(sha256),
    upstreamState: choice(['present', 'not-returned']),
  }),
  createdAt: date,
  reviewedAt: nullable(date),
});
export const reviewHistoryGuidancePage = object({
  ...base,
  nextCursor: cursor,
  items: list(reviewHistoryGuidance, 50),
});
export type ReviewHistoryResponse = ReturnType<
  | typeof reviewHistoryPullPage
  | typeof reviewHistoryMessagePage
  | typeof reviewHistoryDetail
  | typeof reviewHistoryVersionPage
  | typeof reviewHistoryObservationPage
  | typeof reviewHistoryGuidance
  | typeof reviewHistoryGuidancePage
>;
export function decodeReviewHistory(
  request: ReviewHistoryRequest,
  value: unknown,
): ReviewHistoryResponse {
  return {
    pulls: reviewHistoryPullPage,
    messages: reviewHistoryMessagePage,
    message: reviewHistoryDetail,
    versions: reviewHistoryVersionPage,
    observations: reviewHistoryObservationPage,
    guidance: reviewHistoryGuidancePage,
    'guidance-detail': reviewHistoryGuidance,
  }[request.kind](value);
}
