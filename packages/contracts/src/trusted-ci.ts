import { z } from 'zod';
const apiBaseUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      value.endsWith('/')
    );
  }, 'Expected a canonical HTTPS API base URL');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const oid = z.string().regex(/^[a-f0-9]{40}$/);
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
const positiveId = z.string().regex(/^[1-9][0-9]{0,18}$/);
const ref = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^refs\/(heads|pull)\/[^\s]+$/);
/** Every field must match; a successful check status alone is not validation evidence. */
export const ciValidationInputSchema = z
  .object({
    apiBaseUrl,
    repositoryId: positiveId,
    repository: z
      .string()
      .min(3)
      .max(512)
      .regex(/^[^/\s]+\/[^/\s]+$/),
    ref,
    source: z
      .object({
        baseCommit: oid,
        headCommit: oid,
        mergeBaseCommit: oid,
        baseTree: oid,
        headTree: oid,
        mergeBaseTree: oid,
        sourceHash: hash,
      })
      .strict(),
    contextHash: hash,
    ruleHash: hash,
    toolHash: hash,
    profileHash: hash,
    environmentHash: hash,
  })
  .strict();
export type CiValidationInput = z.infer<typeof ciValidationInputSchema>;
export const ciValidationPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    issuer: z.string().url().max(2048),
    keyId: identifier,
    input: ciValidationInputSchema,
    workflow: z
      .object({
        runId: positiveId,
        attempt: z.number().int().min(1).max(1000),
        workflowId: positiveId,
        path: z
          .string()
          .regex(/^\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/)
          .max(512),
        contentHash: hash,
      })
      .strict(),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    checks: z
      .array(
        z
          .object({
            id: identifier,
            name: z.string().min(1).max(256),
            outcome: z.enum(['passed', 'failed', 'incomplete', 'unavailable']),
            command: z.string().min(1).max(4096),
            expected: z.string().min(1).max(4000),
            actual: z.string().min(1).max(4000),
            exitCode: z.number().int().min(-2147483648).max(2147483647).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.checks.map((check) => check.id)).size !== value.checks.length)
      context.addIssue({ code: 'custom', message: 'Duplicate CI check identity' });
    if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt))
      context.addIssue({ code: 'custom', message: 'CI evidence expiry must follow issuance' });
    if (value.checks.some((check) => check.outcome === 'passed' && check.exitCode !== 0))
      context.addIssue({ code: 'custom', message: 'Passed CI checks require exit code zero' });
  });
export type CiValidationPayload = z.infer<typeof ciValidationPayloadSchema>;
export const signedCiValidationSchema = z
  .object({
    payload: ciValidationPayloadSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
export type SignedCiValidation = z.infer<typeof signedCiValidationSchema>;
/** Operator configuration, never accepted from downloaded check output. */
export const ciTrustPolicySchema = z
  .object({
    issuer: z.string().url().max(2048),
    keyId: identifier,
    publicKey: z
      .string()
      .max(4096)
      .regex(
        /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----\r?\n?$/,
      ),
    apiBaseUrl,
    repositoryId: positiveId,
    repository: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/)
      .max(512),
    workflowId: positiveId,
    workflowPath: z
      .string()
      .regex(/^\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/)
      .max(512),
    workflowContentHash: hash,
    checkAppId: positiveId,
    checkName: z.string().min(1).max(256),
    allowedRefs: z.array(ref).min(1).max(100),
    environmentHash: hash,
    maxAgeSeconds: z.number().int().min(60).max(86400),
  })
  .strict();
export type CiTrustPolicy = z.infer<typeof ciTrustPolicySchema>;
export const ciEvidenceRejectionSchema = z.enum([
  'invalid-envelope',
  'invalid-policy',
  'issuer-mismatch',
  'signature-invalid',
  'repository-mismatch',
  'ref-mismatch',
  'workflow-mismatch',
  'stale',
  'future-evidence',
  'input-mismatch',
  'run-mismatch',
  'check-mismatch',
  'workflow-content-mismatch',
  'incomplete-discovery',
]);
export type CiEvidenceRejection = z.infer<typeof ciEvidenceRejectionSchema>;
export const ciValidationViewSchema = z.object({
  schemaVersion: z.literal(1),
  analysisId: z.string().uuid(),
  observedAt: z.string().datetime(),
  status: z.enum([
    'not-configured',
    'input-unavailable',
    'unavailable',
    'no-matching-evidence',
    'verified',
  ]),
  reason: z.string(),
  input: ciValidationInputSchema.nullable(),
  evidence: z.array(
    z.object({
      checkRunId: positiveId,
      runId: positiveId,
      attempt: z.number().int().positive(),
      issuer: z.string(),
      keyId: z.string(),
      payloadHash: hash,
      issuedAt: z.string(),
      expiresAt: z.string(),
      checks: ciValidationPayloadSchema.shape.checks,
    }),
  ),
  rejected: z.array(z.object({ checkRunId: positiveId, reason: ciEvidenceRejectionSchema })),
});
export type CiValidationView = z.infer<typeof ciValidationViewSchema>;

export const githubCiCheckSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().max(256),
  head_sha: oid,
  status: z.string(),
  conclusion: z.string().nullable(),
  app: z.object({ id: z.number().int().positive() }),
  output: z.object({ text: z.string().max(100000).nullable() }),
});
export type GitHubCiCheck = z.infer<typeof githubCiCheckSchema>;
export const githubCiRunSchema = z.object({
  id: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  workflow_id: z.number().int().positive(),
  head_sha: oid,
  event: z.enum(['push', 'pull_request']),
  status: z.string(),
  conclusion: z.string().nullable(),
  path: z.string().max(512),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  repository: z.object({ id: z.number().int().positive(), full_name: z.string().max(512) }),
  pull_requests: z
    .array(z.object({ number: z.number().int().positive(), head: z.object({ sha: oid }) }))
    .max(100),
});
export type GitHubCiRun = z.infer<typeof githubCiRunSchema>;
