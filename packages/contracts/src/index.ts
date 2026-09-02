import { z } from 'zod';

export const schemaVersion = 1 as const;

export const roleSchema = z.enum(['reviewer', 'administrator']);
export type Role = z.infer<typeof roleSchema>;

export const userSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  id: z.string(),
  subject: z.string(),
  displayName: z.string(),
  role: roleSchema,
});
export type User = z.infer<typeof userSchema>;

export const repositorySchema = z.object({
  id: z.string().uuid(),
  githubId: z.string(),
  owner: z.string(),
  name: z.string(),
  webBaseUrl: z.string().url(),
  lastPolledAt: z.string().nullable(),
  nextPollAt: z.string().nullable(),
  pollOutcome: z.string().nullable(),
  pollError: z.string().nullable(),
});
export type Repository = z.infer<typeof repositorySchema>;

export const pullRequestSchema = z.object({
  id: z.string().uuid(),
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  author: z.string(),
  htmlUrl: z.string().url(),
  baseRef: z.string(),
  baseSha: z.string(),
  headRef: z.string(),
  headSha: z.string(),
  updatedAt: z.string(),
  observedAt: z.string(),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

export const repositoryListSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  items: z.array(repositorySchema),
  nextCursor: z.string().nullable(),
});

export const pullRequestListSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  repositoryId: z.string().uuid(),
  items: z.array(pullRequestSchema),
  nextCursor: z.string().nullable(),
});

export const dependencyHealthSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  status: z.enum(['ok', 'degraded']),
  dependencies: z.record(
    z.string(),
    z.object({
      status: z.enum(['ok', 'degraded', 'disabled']),
      latencyMs: z.number().nonnegative().nullable(),
      message: z.string().optional(),
    }),
  ),
});
export type DependencyHealth = z.infer<typeof dependencyHealthSchema>;

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export function errorEnvelope(
  code: string,
  message: string,
  requestId: string,
  retryable = false,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      requestId,
      retryable,
      ...(details ? { details } : {}),
    },
  };
}
