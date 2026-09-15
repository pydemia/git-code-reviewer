import { z } from 'zod';
import { githubPrMemorySourceSchema, githubPrMessageHistorySchema } from './review-memory.js';
const id = z.string().uuid();
export const reviewHistoryCoverageSchema = z.object({
  state: z.enum(['uncollected', 'collected', 'failed', 'collecting']),
  lastCompleteAt: z.string().nullable(),
  syncStartedAt: z.string().nullable(),
  observedCount: z.number().int().nonnegative().nullable(),
  errorCode: z.string().nullable(),
});
export const reviewHistoryPullSchema = z.object({
  id,
  number: z.number().int(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  htmlUrl: z.string(),
  messageCount: z.number().int(),
  replyCount: z.number().int(),
  notReturnedCount: z.number().int(),
  coverage: reviewHistoryCoverageSchema,
});
export const reviewHistoryMessageSchema = githubPrMemorySourceSchema.omit({ state: true }).extend({
  githubId: z.string(),
  upstreamState: z.enum(['present', 'not-returned']),
  parentId: id.nullable(),
  reviewSourceId: id.nullable(),
  replyCount: z.number().int(),
  lastObservedAt: z.string(),
});
export const reviewHistoryMessageSummarySchema = reviewHistoryMessageSchema
  .omit({ body: true, provenance: true })
  .extend({ excerpt: z.string(), bodyCharacters: z.number().int() });
const page = {
  schemaVersion: z.literal(1),
  repositoryId: id,
  revision: z.string(),
  nextCursor: z.string().nullable(),
};
export const reviewHistoryPullListSchema = z.object({
  ...page,
  items: z.array(reviewHistoryPullSchema),
  capabilities: z.object({ manage: z.boolean() }),
});
export const reviewHistoryMessageListSchema = z.object({
  ...page,
  pull: reviewHistoryPullSchema,
  items: z.array(reviewHistoryMessageSummarySchema),
});
export const reviewHistoryMessageDetailSchema = z.object({
  schemaVersion: z.literal(1),
  repositoryId: id,
  pullNumber: z.number().int(),
  revision: z.string(),
  item: reviewHistoryMessageSchema,
});
export const reviewHistoryObservationListSchema = githubPrMessageHistorySchema.extend({
  repositoryId: id,
  revision: z.string(),
});
export type ReviewHistoryPull = z.infer<typeof reviewHistoryPullSchema>;
export type ReviewHistoryMessage = z.infer<typeof reviewHistoryMessageSchema>;
export type ReviewHistoryMessageSummary = z.infer<typeof reviewHistoryMessageSummarySchema>;
