import { z } from 'zod';

export const clientCredentialInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    clientId: z.enum(['commit-defender', 'gcr-cli']),
    tenantId: z.string().uuid(),
    repositoryIds: z
      .array(z.string().uuid())
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
    scopes: z.tuple([z.literal('knowledge:read')]).default(['knowledge:read']),
    lifetimeDays: z.number().int().min(1).max(90).default(30),
  })
  .strict();

export const clientCredentialSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    clientId: z.enum(['commit-defender', 'gcr-cli']),
    tenantId: z.string().uuid(),
    repositoryIds: z.array(z.string().uuid()),
    scopes: z.tuple([z.literal('knowledge:read')]),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    revokedAt: z.string().datetime().nullable(),
  })
  .strict();

export const clientCredentialListSchema = z
  .object({
    schemaVersion: z.literal(1),
    items: z.array(clientCredentialSchema),
    nextCursor: z.string().uuid().nullable(),
  })
  .strict();

export const clientCredentialIssuedSchema = clientCredentialSchema.extend({
  schemaVersion: z.literal(1),
  token: z.string().regex(/^gcr_key_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/),
});

export const clientAuthConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    serverId: z.string().uuid().nullable(),
    methods: z.array(z.literal('api-key')),
    clientIds: z.array(z.enum(['commit-defender', 'gcr-cli'])),
    scopes: z.array(z.literal('knowledge:read')),
  })
  .strict();

export type ClientCredential = z.infer<typeof clientCredentialSchema>;
export type ClientCredentialInput = z.input<typeof clientCredentialInputSchema>;
