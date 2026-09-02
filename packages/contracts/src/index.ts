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
