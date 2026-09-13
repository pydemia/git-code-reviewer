import { choice, id, integer, literal, object, optional, sha256, union } from './codec.js';
import { signedKnowledgeManifest } from './knowledge-manifest.js';
export const knowledgeSequences = object({
  policy: integer(),
  collective: integer(),
  personal: integer(),
});
export const centralCacheIndex = object({
  formatVersion: literal(1),
  bindingHash: sha256,
  generation: integer(),
  observedAt: integer(),
  status: choice(['enabled', 'disconnected', 'authentication-required', 'revoked']),
  minimumAuthorizationRevision: integer(),
  minimumSequences: knowledgeSequences,
  revocationMinimumSequences: optional(knowledgeSequences),
  claim: union(object({ id, deadline: integer() }), literal(null)),
  active: union(
    object({
      manifest: signedKnowledgeManifest,
      records: object({ policy: id, collective: id, personal: id }),
    }),
    literal(null),
  ),
});
export type CentralCacheIndex = ReturnType<typeof centralCacheIndex>;
