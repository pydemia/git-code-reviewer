import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalKnowledgeJson } from '@gcr/client-contract';
import {
  ciTrustPolicySchema,
  ciValidationInputSchema,
  signedCiValidationSchema,
  type CiEvidenceRejection,
  type CiTrustPolicy,
  type CiValidationInput,
  type SignedCiValidation,
} from '@gcr/contracts';
export const CI_VALIDATION_SIGNATURE_CONTEXT = 'git-code-reviewer:ci-validation:v1\n';
export function ciValidationSigningBytes(payload: SignedCiValidation['payload']): Buffer {
  return Buffer.from(CI_VALIDATION_SIGNATURE_CONTEXT + canonicalKnowledgeJson(payload));
}
export type VerifiedCiEvidence =
  | { status: 'verified'; value: SignedCiValidation['payload']; payloadHash: string }
  | { status: 'rejected'; reason: CiEvidenceRejection };
/** The issuer is authenticated by a pinned key, not by an asserted OIDC token or CI success flag. */
export function verifyCiEvidence(
  envelope: unknown,
  expected: CiValidationInput,
  trust: CiTrustPolicy,
  now = new Date(),
): VerifiedCiEvidence {
  const policy = ciTrustPolicySchema.safeParse(trust);
  if (!policy.success) return { status: 'rejected', reason: 'invalid-policy' };
  const parsed = signedCiValidationSchema.safeParse(envelope);
  if (!parsed.success || !Number.isFinite(now.getTime()))
    return { status: 'rejected', reason: 'invalid-envelope' };
  const { payload, signature } = parsed.data,
    p = policy.data;
  if (payload.issuer !== p.issuer || payload.keyId !== p.keyId)
    return { status: 'rejected', reason: 'issuer-mismatch' };
  try {
    const key = createPublicKey(p.publicKey);
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      Buffer.from(signature, 'base64url').toString('base64url') !== signature ||
      !verify(null, ciValidationSigningBytes(payload), key, Buffer.from(signature, 'base64url'))
    )
      return { status: 'rejected', reason: 'signature-invalid' };
  } catch {
    return { status: 'rejected', reason: 'invalid-policy' };
  }
  if (
    payload.input.apiBaseUrl !== p.apiBaseUrl ||
    payload.input.repositoryId !== p.repositoryId ||
    payload.input.repository !== p.repository
  )
    return { status: 'rejected', reason: 'repository-mismatch' };
  if (
    !p.allowedRefs.some(
      (ref) =>
        ref === payload.input.ref ||
        (ref === 'refs/pull/*/head' && /^refs\/pull\/[1-9][0-9]*\/head$/.test(payload.input.ref)),
    )
  )
    return { status: 'rejected', reason: 'ref-mismatch' };
  if (
    payload.workflow.workflowId !== p.workflowId ||
    payload.workflow.path !== p.workflowPath ||
    payload.workflow.contentHash !== p.workflowContentHash
  )
    return { status: 'rejected', reason: 'workflow-mismatch' };
  const issued = Date.parse(payload.issuedAt),
    expires = Date.parse(payload.expiresAt);
  if (issued > now.getTime()) return { status: 'rejected', reason: 'future-evidence' };
  if (
    expires <= now.getTime() ||
    now.getTime() - issued > p.maxAgeSeconds * 1000 ||
    expires - issued > p.maxAgeSeconds * 1000
  )
    return { status: 'rejected', reason: 'stale' };
  const identity = ciValidationInputSchema.safeParse(expected);
  if (
    !identity.success ||
    payload.input.environmentHash !== p.environmentHash ||
    canonicalKnowledgeJson(identity.data) !== canonicalKnowledgeJson(payload.input)
  )
    return { status: 'rejected', reason: 'input-mismatch' };
  return {
    status: 'verified',
    value: payload,
    payloadHash: createHash('sha256').update(canonicalKnowledgeJson(payload)).digest('hex'),
  };
}
