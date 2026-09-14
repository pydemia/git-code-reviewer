import { z } from 'zod';
import { githubPrMessageProvenanceSchema } from './review-memory.js';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const text = (maximum: number) => z.string().trim().min(1).max(maximum);
const terms = z.array(text(500)).max(100).default([]);

export const criterionScopeSchema = z
  .object({
    languages: terms,
    filePaths: terms,
    symbols: terms,
    contracts: terms,
    branches: terms,
  })
  .strict();

export const reviewDecisionOutcomeSchema = z.enum([
  'defect',
  'false-positive',
  'accepted-exception',
  'design-decision',
  'open-question',
]);
export const criterionStateSchema = z.enum(['draft', 'evaluated', 'shadow', 'active', 'retired']);
export const criterionSourceInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('memory'), id: z.string().uuid(), contentHash: hash }).strict(),
  z
    .object({ kind: z.literal('snapshot-change'), id: z.string().uuid(), contentHash: hash })
    .strict(),
  z
    .object({
      kind: z.literal('github-pr-message'),
      id: z.string().uuid(),
      contentHash: hash,
      observationHash: hash.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('manual'), content: text(8000) }).strict(),
]);
export const criterionCodeChangeSchema = z
  .object({
    snapshotId: z.string().uuid(),
    pullRequestNumber: z.number().int().positive(),
    path: z.string().min(1).max(4096),
    previousPath: z.string().min(1).max(4096).nullable(),
    status: z.enum(['added', 'modified', 'deleted', 'renamed']),
    baseSha: z.string().regex(/^[a-f0-9]{40}$/i),
    headSha: z.string().regex(/^[a-f0-9]{40}$/i),
    mergeBaseSha: z.string().regex(/^[a-f0-9]{40}$/i),
    evidenceKind: z.literal('diff-hunks'),
    validation: z.literal('not-observed'),
  })
  .strict();
export const criterionSourceSchema = z
  .object({
    kind: z.enum(['memory', 'github-pr-message', 'snapshot-change', 'manual']),
    id: z.string().uuid().nullable(),
    contentHash: hash,
    content: z
      .string()
      .min(1)
      .max(12000)
      .refine((value) => value.trim().length > 0),
    label: text(500),
    baseSha: z.string().nullable(),
    headSha: z.string().nullable(),
    observationHash: hash.optional(),
    discussion: githubPrMessageProvenanceSchema.optional(),
    codeChange: criterionCodeChangeSchema.optional(),
  })
  .strict();

export const criterionDocumentSchema = z
  .object({
    title: text(300),
    topicKey: text(200),
    requirement: text(4000),
    rationale: text(4000),
    counterEvidence: z.array(text(2000)).min(1).max(30),
    appliesTo: criterionScopeSchema,
    reviewSteps: z.array(text(2000)).min(1).max(30),
    severity: z.enum(['P0', 'P1', 'P2', 'P3']),
    enforcement: z.literal('advisory').default('advisory'),
    reviewAfter: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict();
export type CriterionDocument = z.infer<typeof criterionDocumentSchema>;

export const criterionCreateSchema = z
  .object({
    document: criterionDocumentSchema,
    decision: z
      .object({
        outcome: reviewDecisionOutcomeSchema,
        reasoning: text(4000),
        sources: z.array(criterionSourceInputSchema).min(1).max(12),
      })
      .strict(),
    origin: z.enum(['maintainer-curated', 'model-candidate']).default('maintainer-curated'),
  })
  .strict();
export type CriterionCreate = z.infer<typeof criterionCreateSchema>;
export const criterionRevisionCreateSchema = criterionCreateSchema
  .extend({
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const criterionEvaluationCaseSchema = z
  .object({
    kind: z.enum(['defect', 'fixed', 'normal', 'counter-evidence']),
    name: text(300),
    source: text(20000),
    observed: z.enum(['finding', 'clear', 'needs-context']),
    evidence: text(4000),
  })
  .strict();
export const criterionEvaluationCreateSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    cases: z.array(criterionEvaluationCaseSchema).length(4),
    note: text(2000),
  })
  .strict()
  .refine(({ cases }) => new Set(cases.map(({ kind }) => kind)).size === 4, {
    message: '결함·수정·정상·반증 사례를 각각 하나씩 기록해야 합니다.',
  });
export type CriterionEvaluationCreate = z.infer<typeof criterionEvaluationCreateSchema>;
export const criterionActionSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    action: z.enum(['evaluate', 'approve-owner', 'shadow', 'activate', 'retire']),
    note: text(2000),
  })
  .strict();
export type CriterionAction = z.infer<typeof criterionActionSchema>;
export const criterionRoleSchema = z.enum(['maintainer', 'security-owner', 'domain-owner']);

export const criterionExceptionTermsSchema = z
  .object({
    appliesTo: criterionScopeSchema,
    startsAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((value) => Date.parse(value.expiresAt) > Date.parse(value.startsAt), {
    message: '예외 만료는 시작 시각 이후여야 합니다.',
  })
  .refine((value) => Object.values(value.appliesTo).some((terms) => terms.length > 0), {
    message: '예외의 적용 범위를 하나 이상 지정해 주세요.',
  });
export const criterionFeedbackContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('correction'), message: text(4000) }).strict(),
  z
    .object({
      kind: z.literal('exception'),
      message: text(4000),
      terms: criterionExceptionTermsSchema,
    })
    .strict(),
]);
export const criterionFeedbackCreateSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    request: criterionFeedbackContentSchema,
  })
  .strict();
export const criterionFeedbackResolutionSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    action: z.enum(['acknowledge', 'approve-exception', 'reject']),
    note: text(2000),
  })
  .strict();
export const criterionExceptionRevokeSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    note: text(2000),
  })
  .strict();
export type CriterionFeedbackCreate = z.infer<typeof criterionFeedbackCreateSchema>;
export type CriterionFeedbackResolution = z.infer<typeof criterionFeedbackResolutionSchema>;
export type CriterionExceptionRevoke = z.infer<typeof criterionExceptionRevokeSchema>;

export const criterionRoleAssignmentSchema = z
  .object({
    userId: z.string().uuid(),
    role: criterionRoleSchema,
    enabled: z.boolean(),
  })
  .strict();
export const criterionRoleListSchema = z.object({
  schemaVersion: z.literal(1),
  users: z.array(
    z.object({
      id: z.string().uuid(),
      displayName: z.string(),
      eligible: z.boolean(),
      roles: z.array(criterionRoleSchema),
    }),
  ),
});
export type CriterionRoleAssignment = z.infer<typeof criterionRoleAssignmentSchema>;
export const criterionGenerationCreateSchema = z
  .object({
    requestId: z.string().uuid(),
    accountId: z.string().uuid(),
    modelName: text(200),
    reasoningEffort: text(40),
    sources: z.array(criterionSourceInputSchema).min(1).max(6),
    focus: text(2000),
  })
  .strict();
export const criterionGeneratedDocumentSchema = z
  .object({
    document: criterionDocumentSchema,
    decision: z.object({ outcome: reviewDecisionOutcomeSchema, reasoning: text(4000) }).strict(),
  })
  .strict();
export const criterionGenerationSchema = z.object({
  id: z.string().uuid(),
  repositoryId: z.string().uuid(),
  state: z.enum(['queued', 'running', 'completed', 'failed', 'uncertain', 'cancelled']),
  modelName: z.string(),
  reasoningEffort: z.string(),
  ruleId: z.string().uuid().nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const criterionGenerationListSchema = z.object({
  schemaVersion: z.literal(1),
  enabled: z.boolean(),
  items: z.array(criterionGenerationSchema),
});
export type CriterionGenerationCreate = z.infer<typeof criterionGenerationCreateSchema>;
export type CriterionGeneration = z.infer<typeof criterionGenerationSchema>;

export const criterionReviewStatusSchema = z.object({
  checkedAt: z.string().datetime({ offset: true }),
  requiresReview: z.boolean(),
  promotionBlocked: z.boolean(),
  reviewDateReached: z.boolean(),
  expiredExceptions: z.number().int().nonnegative(),
  sourceSetChanged: z.boolean(),
  sources: z.array(
    z.object({
      kind: criterionSourceSchema.shape.kind,
      id: z.string().uuid().nullable(),
      status: z.enum(['current', 'changed', 'unavailable']),
    }),
  ),
});
export type CriterionReviewStatus = z.infer<typeof criterionReviewStatusSchema>;
export const criterionSummarySchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  repositoryId: z.string().uuid(),
  revision: z.number().int().positive(),
  version: z.number().int().positive(),
  state: criterionStateSchema,
  contentHash: hash,
  document: criterionDocumentSchema,
  origin: z.enum(['maintainer-curated', 'model-candidate']),
  outcome: reviewDecisionOutcomeSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  reviewStatus: criterionReviewStatusSchema.optional(),
});
export const criterionCapabilitiesSchema = z.object({
  manage: z.boolean(),
  approveOwner: z.boolean(),
  delegate: z.boolean(),
});
export const criterionListSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(criterionSummarySchema),
  capabilities: criterionCapabilitiesSchema,
});
export const criterionDetailSchema = z.object({
  schemaVersion: z.literal(1),
  criterion: criterionSummarySchema,
  generation: criterionGenerationSchema.nullable().default(null),
  capabilities: criterionCapabilitiesSchema,
  feedback: z.array(
    z.object({
      id: z.string().uuid(),
      revision: z.number().int().positive(),
      request: criterionFeedbackContentSchema,
      clientSource: z.string().max(8000).nullable().optional(),
      createdBy: z.string().uuid(),
      createdAt: z.string(),
      resolution: z
        .object({
          action: z.enum(['acknowledge', 'approve-exception', 'reject']),
          note: z.string(),
          actorUserId: z.string().uuid(),
          createdAt: z.string(),
        })
        .nullable(),
    }),
  ),
  exceptions: z.array(
    z.object({
      id: z.string().uuid(),
      requestId: z.string().uuid(),
      revision: z.number().int().positive(),
      appliesTo: criterionScopeSchema,
      reason: z.string(),
      startsAt: z.string(),
      expiresAt: z.string(),
      approvedBy: z.string().uuid(),
      status: z.enum(['scheduled', 'active', 'expired', 'revoked', 'superseded', 'retired']),
      revocation: z
        .object({ note: z.string(), actorUserId: z.string().uuid(), createdAt: z.string() })
        .nullable(),
    }),
  ),
  revisions: z.array(
    z.object({
      revision: z.number().int().positive(),
      supersedes: z.number().int().positive().nullable(),
      contentHash: hash,
      document: criterionDocumentSchema,
      createdBy: z.string().uuid(),
      createdAt: z.string(),
      decision: z.object({
        id: z.string().uuid(),
        outcome: reviewDecisionOutcomeSchema,
        reasoning: text(4000),
        origin: z.enum(['maintainer-curated', 'model-candidate']),
        sourceHash: hash,
        sources: z.array(criterionSourceSchema.extend({ unavailable: z.boolean().optional() })),
      }),
    }),
  ),
  evaluations: z.array(
    z.object({
      id: z.string().uuid(),
      revision: z.number().int().positive(),
      method: z.literal('manual'),
      passed: z.boolean(),
      cases: z.array(criterionEvaluationCaseSchema.extend({ sourceHash: hash })),
      note: text(2000),
      actorUserId: z.string().uuid(),
      createdAt: z.string(),
    }),
  ),
  events: z.array(
    z.object({
      id: z.string().uuid(),
      revision: z.number().int().positive(),
      action: z.string(),
      actorUserId: z.string().uuid(),
      note: z.string(),
      createdAt: z.string(),
    }),
  ),
});
export type CriterionDetail = z.infer<typeof criterionDetailSchema>;
export type CriterionSummary = z.infer<typeof criterionSummarySchema>;
export const criterionSourceListSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(criterionSourceSchema),
});

// Exceptions remain a separate approval object; they never rewrite rule content.
export const criterionExceptionSchema = z
  .object({
    id: z.string().uuid(),
    ruleId: z.string().uuid(),
    revision: z.number().int().positive(),
    appliesTo: criterionScopeSchema,
    reason: text(4000),
    startsAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    approvedBy: z.string().uuid(),
  })
  .strict()
  .refine((value) => Date.parse(value.expiresAt) > Date.parse(value.startsAt), {
    message: '예외 만료는 시작 시각 이후여야 합니다.',
  });
