import { z } from 'zod';

export const chatRunStatusSchema = z.enum([
  'queued',
  'running',
  'awaiting_input',
  'waiting_capacity',
  'cancelling',
  'completed',
  'partial',
  'failed',
  'cancelled',
]);
export type ChatRunStatus = z.infer<typeof chatRunStatusSchema>;
export const terminalChatStatuses: ChatRunStatus[] = [
  'completed',
  'partial',
  'failed',
  'cancelled',
];
export const sourceRevisionSchema = z.enum(['base', 'mergeBase', 'head']);
export const sourceEvidenceSchema = z.object({
  id: z.string(),
  revision: sourceRevisionSchema,
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  path: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  blob: z.string(),
  hash: z.string(),
  content: z.string(),
  truncated: z.boolean(),
});
export type SourceEvidence = z.infer<typeof sourceEvidenceSchema>;
export const chatQuestionSchema = z.object({
  id: z.string().uuid(),
  question: z.string().min(1).max(2000),
  options: z.array(z.string().min(1).max(300)).max(6),
  answer: z.string().max(4000).nullable(),
  expiresAt: z.string(),
});
export const chatRunViewSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  status: chatRunStatusSchema,
  assistantMessageId: z.string().uuid().nullable(),
  phase: z.string(),
  content: z.string(),
  error: z.string().nullable(),
  modelCalls: z.number(),
  toolCalls: z.number(),
  contextBytes: z.number(),
  question: chatQuestionSchema.nullable(),
  questions: z.array(chatQuestionSchema).optional(),
  resumeAfter: z.string().nullable(),
  evidence: z.array(sourceEvidenceSchema.omit({ content: true })),
  timeline: z.array(z.object({ id: z.string(), type: z.string(), label: z.string() })),
});
export type ChatRunView = z.infer<typeof chatRunViewSchema>;
export const chatRunHistorySchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      status: chatRunStatusSchema,
      createdAt: z.string(),
      question: z.string(),
      snapshotId: z.string().uuid(),
    }),
  ),
  nextCursor: z.string().uuid().nullable(),
});
export type ChatRunHistory = z.infer<typeof chatRunHistorySchema>;
export const createChatRunSchema = z.object({
  idempotencyKey: z.string().uuid(),
  content: z.string().trim().min(1).max(4000),
  scope: z
    .object({
      findingId: z.string().uuid().optional(),
      fileId: z.string().uuid().optional(),
      symbolId: z.string().uuid().optional(),
    })
    .default({}),
});
export function isTerminalChatRun(status: ChatRunStatus): boolean {
  return terminalChatStatuses.includes(status);
}
