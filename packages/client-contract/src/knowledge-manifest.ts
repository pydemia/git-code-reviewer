import { id, integer, literal, object, refined, sha256, text, timestamp, fail } from './codec.js';
import { KNOWLEDGE_BUNDLE_MAX_BYTES } from './central-knowledge.js';
export const knowledgeAudience = object({
  serverId: id,
  tenantId: id,
  repositoryId: id,
  userId: id,
});
const component = object({
  bundleId: id,
  releaseSequence: integer(1),
  contentHash: sha256,
  sizeBytes: integer(1, KNOWLEDGE_BUNDLE_MAX_BYTES),
});
export const knowledgeManifestPayload = refined(
  object({
    schemaVersion: literal(1),
    audience: knowledgeAudience,
    snapshotId: id,
    authorizationRevision: integer(1),
    components: object({ policy: component, collective: component, personal: component }),
    revocations: object({
      policyMinimumSequence: integer(1),
      collectiveMinimumSequence: integer(1),
      personalMinimumSequence: integer(1),
    }),
    compatibleClientContracts: object({ minimum: integer(1), maximum: integer(1) }),
    issuedAt: timestamp,
    refreshAfter: timestamp,
    offlineValidUntil: timestamp,
    signingKeyId: id,
  }),
  (value, at) => {
    if (value.compatibleClientContracts.minimum > value.compatibleClientContracts.maximum)
      fail(at, 'invalid client compatibility range');
    const issued = Date.parse(value.issuedAt),
      refresh = Date.parse(value.refreshAfter),
      offline = Date.parse(value.offlineValidUntil);
    if (
      refresh <= issued ||
      refresh > issued + 300000 ||
      offline < issued ||
      offline > issued + 86400000
    )
      fail(at, 'invalid manifest lifetime');
    for (const part of ['policy', 'collective', 'personal'] as const) {
      if (value.revocations[`${part}MinimumSequence`] > value.components[part].releaseSequence)
        fail(at, 'manifest contains revoked component');
    }
  },
);
export const signedKnowledgeManifest = object({
  payload: knowledgeManifestPayload,
  manifestHash: sha256,
  signature: text(86, 86, /^[A-Za-z0-9_-]+$/),
});
export type KnowledgeManifestPayload = ReturnType<typeof knowledgeManifestPayload>;
export type SignedKnowledgeManifest = ReturnType<typeof signedKnowledgeManifest>;
export type KnowledgeAudience = ReturnType<typeof knowledgeAudience>;
export const KNOWLEDGE_SIGNATURE_CONTEXT = 'git-code-reviewer/knowledge-manifest/v1\n';
