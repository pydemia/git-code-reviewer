import { z } from 'zod';

export const reviewMemoryKindSchema = z.enum([
  'recurring-finding',
  'decision',
  'false-positive',
  'open-question',
]);
export type ReviewMemoryKind = z.infer<typeof reviewMemoryKindSchema>;

export const reviewMemoryStateSchema = z.enum([
  'candidate',
  'active',
  'rejected',
  'superseded',
  'retired',
]);
export type ReviewMemoryState = z.infer<typeof reviewMemoryStateSchema>;

export const reviewMemorySourceKindSchema = z.enum(['finding', 'chat-message', 'manual']);
export type ReviewMemorySourceKind = z.infer<typeof reviewMemorySourceKindSchema>;

export const reviewMemoryScopeSchema = z.enum(['personal', 'collective']);
export type ReviewMemoryScope = z.infer<typeof reviewMemoryScopeSchema>;

const scopeValueSchema = z.string().trim().min(1).max(500);

export const reviewMemorySchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  repositoryId: z.string().uuid(),
  scope: reviewMemoryScopeSchema,
  ownerUserId: z.string().uuid().nullable(),
  kind: reviewMemoryKindSchema,
  state: reviewMemoryStateSchema,
  revision: z.number().int().positive(),
  supersedesId: z.string().uuid().nullable(),
  summary: z.string().min(1).max(500),
  detail: z.string().max(4000),
  recommendation: z.string().max(2000),
  categories: z.array(scopeValueSchema),
  filePaths: z.array(scopeValueSchema),
  symbols: z.array(scopeValueSchema),
  aggregationKey: z.string().regex(/^[0-9a-f]{64}$/),
  contributorCount: z.number().int().positive(),
  conflictCount: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
  importance: z.number().int().min(1).max(5),
  sourceKind: reviewMemorySourceKindSchema,
  sourceAnalysisRunId: z.string().uuid().nullable(),
  sourceFindingId: z.string().uuid().nullable(),
  sourceChatMessageId: z.string().uuid().nullable(),
  sourceBaseSha: z.string().nullable(),
  sourceHeadSha: z.string().nullable(),
  sourceAnchor: z.record(z.string(), z.unknown()),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdBy: z.string().uuid().nullable(),
  reviewedBy: z.string().uuid().nullable(),
  reviewedAt: z.string().nullable(),
  reviewNote: z.string().max(2000),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ReviewMemory = z.infer<typeof reviewMemorySchema>;

export const reviewMemoryCandidateCreateSchema = z
  .object({
    kind: reviewMemoryKindSchema,
    summary: z.string().trim().min(1).max(500),
    detail: z.string().trim().max(4000).default(''),
    recommendation: z.string().trim().max(2000).default(''),
    categories: z.array(scopeValueSchema).max(20).default([]),
    filePaths: z.array(scopeValueSchema).max(100).default([]),
    symbols: z.array(scopeValueSchema).max(100).default([]),
    confidence: z.number().min(0).max(1).default(0.5),
    importance: z.number().int().min(1).max(5).default(3),
    sourceFindingId: z.string().uuid().optional(),
    sourceChatMessageId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    ({ sourceFindingId, sourceChatMessageId }) =>
      Number(Boolean(sourceFindingId)) + Number(Boolean(sourceChatMessageId)) === 1,
    { message: 'finding 또는 Chat message 출처 하나가 필요합니다.' },
  );
export type ReviewMemoryCandidateCreate = z.infer<typeof reviewMemoryCandidateCreateSchema>;

export const reviewMemoryReviewSchema = z
  .object({
    action: z.enum(['activate', 'reject', 'retire', 'supersede']),
    summary: z.string().trim().min(1).max(500).optional(),
    detail: z.string().trim().max(4000).optional(),
    recommendation: z.string().trim().max(2000).optional(),
    categories: z.array(scopeValueSchema).max(20).optional(),
    filePaths: z.array(scopeValueSchema).max(100).optional(),
    symbols: z.array(scopeValueSchema).max(100).optional(),
    confidence: z.number().min(0).max(1).optional(),
    importance: z.number().int().min(1).max(5).optional(),
    note: z.string().trim().max(2000).default(''),
  })
  .strict();
export type ReviewMemoryReview = z.infer<typeof reviewMemoryReviewSchema>;
