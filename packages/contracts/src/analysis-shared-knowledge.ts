import { z } from 'zod';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const analysisSharedKnowledgeSchema = z.object({
  schemaVersion: z.literal(1),
  analysisId: z.string().uuid(),
  status: z.enum(['legacy', 'disabled', 'unavailable', 'queued', 'selected']),
  reason: z.string(),
  pinHash: hash.nullable(),
  branch: z.string().nullable(),
  releases: z.array(
    z.object({
      component: z.enum(['policy', 'collective']),
      id: z.string().uuid(),
      sequence: z.number().int().positive(),
      hash,
    }),
  ),
  selection: z
    .object({
      hash,
      selectedAt: z.string().datetime(),
      validUntil: z.string().datetime().nullable(),
      items: z.array(
        z.object({
          component: z.enum(['policy', 'collective']),
          kind: z.enum(['policy', 'memory', 'skill']),
          id: z.string(),
          title: z.string(),
          revision: z.number().int().positive(),
          hash,
          targets: z.array(z.object({ path: z.string(), side: z.enum(['source', 'base']), hash })),
        }),
      ),
      omitted: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type AnalysisSharedKnowledge = z.infer<typeof analysisSharedKnowledgeSchema>;
