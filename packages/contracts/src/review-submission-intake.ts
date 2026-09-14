import { z } from 'zod';
import {
  criterionDocumentSchema,
  criterionExceptionTermsSchema,
  reviewDecisionOutcomeSchema,
  criterionStateSchema,
} from './review-criteria.js';
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const common = { expectedPayloadHash: hash, note: z.string().trim().min(1).max(2000) };
export const submissionIntakeActionSchema = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('dismiss') }).strict(),
  z
    .object({
      ...common,
      action: z.literal('create-candidate'),
      document: criterionDocumentSchema,
      outcome: reviewDecisionOutcomeSchema,
      reasoning: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('link-feedback'),
      ruleId: z.string().uuid(),
      expectedVersion: z.number().int().positive(),
      exceptionTerms: criterionExceptionTermsSchema.optional(),
    })
    .strict(),
]);
export type SubmissionIntakeAction = z.infer<typeof submissionIntakeActionSchema>;
export const submissionIntakeDecisionSchema = z
  .object({
    action: z.enum(['dismiss', 'create-candidate', 'link-feedback']),
    note: z.string(),
    actorUserId: z.string().uuid().nullable(),
    createdAt: z.string(),
    ruleId: z.string().uuid().nullable(),
    feedbackId: z.string().uuid().nullable(),
    rule: z
      .object({
        id: z.string().uuid(),
        state: criterionStateSchema,
        revision: z.number().int(),
        version: z.number().int(),
      })
      .nullable(),
    feedbackResolution: z
      .object({
        action: z.enum(['acknowledge', 'approve-exception', 'reject']),
        note: z.string(),
        actorUserId: z.string().uuid(),
        createdAt: z.string(),
      })
      .nullable(),
  })
  .strict();
export type SubmissionIntakeDecision = z.infer<typeof submissionIntakeDecisionSchema>;
