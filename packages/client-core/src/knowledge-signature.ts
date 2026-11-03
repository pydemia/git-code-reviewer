import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import {
  signedKnowledgeManifest,
  canonicalKnowledgeJson,
  knowledgeAudience,
  KNOWLEDGE_SIGNATURE_CONTEXT,
  KNOWLEDGE_CLIENT_CONTRACT_VERSION,
  KNOWLEDGE_CLIENT_CONTRACT_MINIMUM,
  type KnowledgeAudience,
  type SignedKnowledgeManifest,
} from '@gcr/client-contract';
export function verifyKnowledgeManifest(
  value: unknown,
  options: {
    audience: KnowledgeAudience;
    trustedKeys: ReadonlyMap<string, string | KeyObject>;
    now: number;
    mode: 'online' | 'offline';
    minimumAuthorizationRevision?: number;
    clientContractVersion?: number;
    minimumSequences?: Partial<Record<'policy' | 'collective' | 'personal', number>>;
  },
): SignedKnowledgeManifest {
  const manifest = signedKnowledgeManifest(value);
  const payload = manifest.payload;
  const version =
    options.clientContractVersion ??
    Math.min(KNOWLEDGE_CLIENT_CONTRACT_VERSION, payload.compatibleClientContracts.maximum);
  if (
    !Number.isSafeInteger(version) ||
    (options.clientContractVersion === undefined && version < KNOWLEDGE_CLIENT_CONTRACT_MINIMUM) ||
    version < payload.compatibleClientContracts.minimum ||
    version > payload.compatibleClientContracts.maximum
  )
    throw Error('Incompatible knowledge client contract');
  if (
    canonicalKnowledgeJson(payload.audience) !==
    canonicalKnowledgeJson(knowledgeAudience(options.audience))
  )
    throw Error('Knowledge manifest audience mismatch');
  const trusted = options.trustedKeys.get(payload.signingKeyId);
  if (!trusted) throw Error('Untrusted knowledge signing key');
  const key = typeof trusted === 'string' ? createPublicKey(trusted) : trusted;
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519')
    throw Error('Invalid knowledge verification key');
  const bytes = canonicalKnowledgeJson(payload);
  if (
    createHash('sha256').update(bytes).digest('hex') !== manifest.manifestHash ||
    !verify(
      null,
      Buffer.from(KNOWLEDGE_SIGNATURE_CONTEXT + bytes),
      key,
      Buffer.from(manifest.signature, 'base64url'),
    )
  )
    throw Error('Invalid knowledge manifest signature');
  const issued = Date.parse(payload.issuedAt),
    until = Date.parse(
      options.mode === 'online' ? payload.refreshAfter : payload.offlineValidUntil,
    );
  if (!Number.isFinite(options.now) || issued > options.now + 30000 || options.now >= until)
    throw Error('Knowledge manifest expired or not yet valid');
  if (payload.authorizationRevision < (options.minimumAuthorizationRevision ?? 0))
    throw Error('Knowledge authorization revision replay');
  for (const part of ['policy', 'collective', 'personal'] as const) {
    const minimum = Math.max(
      payload.revocations[`${part}MinimumSequence`],
      options.minimumSequences?.[part] ?? 0,
    );
    if (payload.components[part].releaseSequence < minimum)
      throw Error('Knowledge component sequence replay');
  }
  return manifest;
}
