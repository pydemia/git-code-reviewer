import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identity = {
  id: z.string().min(1).max(200),
  revision: z.number().int().positive(),
  hash,
};
export const criterionAssessmentInputSchema = z.object({
  ...identity,
  outcome: z.enum(['violation', 'satisfied', 'uncertain']),
  rationale: z.string().trim().min(1).max(8000),
  counterEvidence: z.object({
    status: z.enum(['reviewed', 'not-reviewed']),
    explanation: z.string().trim().min(1).max(8000),
  }),
});
export type CriterionAssessmentInput = z.infer<typeof criterionAssessmentInputSchema>;

export const findingCriteriaSchema = z.object({
  status: z.enum(['linked', 'not-reported', 'unavailable']),
  rejected: z.number().int().nonnegative(),
  items: z
    .array(
      criterionAssessmentInputSchema.extend({
        title: z.string(),
        sourceHash: hash,
        pinHash: hash,
        contextHash: hash,
        validation: z.literal('pinned-target'),
        evaluator: z.literal('model'),
      }),
    )
    .max(16),
});
export type FindingCriteria = z.infer<typeof findingCriteriaSchema>;
