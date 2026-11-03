import {
  boolean,
  choice,
  id,
  integer,
  list,
  literal,
  object,
  sha256,
  text,
  timestamp,
  union,
} from './codec.js';
import { centralMemoryContent } from './central-knowledge.js';
const nullableId = union(id, literal(null));
const nullableTime = union(timestamp, literal(null));
export const knowledgePublicationStatus = object({
  schemaVersion: literal(1),
  enabled: boolean,
  compatibleClientContracts: object({ minimum: integer(1), maximum: integer(1) }),
  syncObservation: literal('unknown'),
  components: list(
    object({
      component: choice(['policy', 'collective', 'personal']),
      state: choice(['disabled', 'unpublished', 'pending', 'failed', 'published', 'unavailable']),
      requestedRevision: union(text(20, 1, /^\d+$/), literal(null)),
      publishedRevision: union(text(20, 1, /^\d+$/), literal(null)),
      releaseSequence: integer(),
      bundleId: nullableId,
      contentHash: union(sha256, literal(null)),
      sizeBytes: union(integer(), literal(null)),
      updatedAt: nullableTime,
      lastError: union(text(128), literal(null)),
      excludedCount: integer(),
    }),
    3,
    3,
  ),
});
export const knowledgeMemoryList = object({
  schemaVersion: literal(1),
  items: list(
    object({
      id,
      summary: text(500, 1),
      scope: choice(['collective', 'personal']),
      reviewed: boolean,
      projectionRevision: union(integer(1), literal(null)),
    }),
    100,
  ),
  nextCursor: nullableId,
});
export const knowledgeMemoryProjection = object({
  schemaVersion: literal(1),
  memoryId: id,
  scope: choice(['collective', 'personal']),
  state: choice(['candidate', 'active', 'rejected', 'superseded', 'retired']),
  reviewed: boolean,
  fingerprint: union(sha256, literal(null)),
  projection: union(
    object({
      revision: integer(1),
      sourceFingerprint: sha256,
      content: centralMemoryContent,
      approvedAt: timestamp,
    }),
    literal(null),
  ),
});
export type KnowledgePublicationStatus = ReturnType<typeof knowledgePublicationStatus>;
