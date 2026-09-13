import { z } from 'zod';

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        ![...value].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) && Buffer.from(value).toString('utf8') === value,
    );
const uuid = z.string().uuid();
const username = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/);
const email = z.string().email().max(320);
const existingTarget = z
  .object({ kind: z.literal('existing'), userId: uuid, expectedSubject: text(4096) })
  .strict();
export const identityProvisioningRequest = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('create'),
      requestId: uuid,
      username,
      email,
      displayName: text(120),
      target: z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('new'),
            role: z.enum(['reviewer', 'administrator']),
            tenantIds: z.array(uuid).min(1).max(100),
          })
          .strict(),
        existingTarget,
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal('link'),
      requestId: uuid,
      target: existingTarget,
      keycloakUserId: uuid,
      expectedUsername: text(255),
      expectedEmail: email,
      expectedNameId: text(4096),
    })
    .strict(),
  z
    .object({
      kind: z.literal('invite'),
      requestId: uuid,
      target: existingTarget,
      expectedEmail: email,
    })
    .strict(),
  z
    .object({
      kind: z.literal('password-reset'),
      requestId: uuid,
      target: existingTarget,
      expectedEmail: email,
      revokeAllSessions: z.literal(true),
    })
    .strict(),
]);
export type IdentityProvisioningRequest = z.infer<typeof identityProvisioningRequest>;

export const identityLifecycleRequest = z
  .object({
    kind: z.enum(['disable', 'enable', 'logout-all']),
    requestId: uuid,
    target: existingTarget,
    revokeAllSessions: z.literal(true),
  })
  .strict();
export type IdentityLifecycleRequest = z.infer<typeof identityLifecycleRequest>;

export const identityAdministrationCapabilitiesSchema = z.object({
  enabled: z.boolean(),
  authMode: z.enum(['development', 'local', 'oidc', 'proxy', 'saml']),
  actions: z.array(
    z.enum(['create', 'link', 'invite', 'password-reset', 'disable', 'enable', 'logout-all']),
  ),
});
export const identityOperationViewSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  kind: z.enum(['create', 'link', 'invite', 'disable', 'enable', 'password-reset', 'logout-all']),
  state: z.enum(['pending', 'running', 'succeeded', 'failed']),
  username: z.string().nullable(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  errorCode: z.string().nullable(),
  retryAllowed: z.boolean(),
  mailDelivery: z.enum(['not-requested', 'pending', 'accepted', 'unconfirmed']),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const identityOperationListSchema = z.object({
  items: z.array(identityOperationViewSchema),
});
export const identityPreviewSchema = z.object({
  keycloakUserId: z.string().uuid(),
  username: z.string(),
  email: z.string().email(),
  displayName: z.string(),
  enabled: z.boolean(),
  nameId: z.string(),
});
export const identityOperationResponseSchema = z.object({ operation: identityOperationViewSchema });
export type IdentityOperationView = z.infer<typeof identityOperationViewSchema>;
export type IdentityPreview = z.infer<typeof identityPreviewSchema>;
export type IdentityAdministrationCapabilities = z.infer<
  typeof identityAdministrationCapabilitiesSchema
>;
