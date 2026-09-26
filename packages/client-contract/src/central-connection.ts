import {
  choice,
  id,
  list,
  literal,
  object,
  optional,
  sha256,
  text,
  timestamp,
  union,
} from './codec.js';
import { knowledgeAudience } from './knowledge-manifest.js';
import { offlineBehavior } from './review-execution.js';
const keys = list(object({ id, pem: text(4096, 1) }), 16, 1);
export const centralRepositoryIdentity = object({
  schemaVersion: literal(1),
  serverId: id,
  tenantId: id,
  repositoryId: id,
  instanceId: id,
  webBaseUrl: text(4096, 1),
  owner: text(100, 1),
  name: text(100, 1),
});
export const centralConnectionInput = object({
  serverUrl: text(4096, 1),
  serverId: id,
  tenantId: id,
  repositoryId: id,
  trustedKeys: keys,
  ca: union(text(65536, 1), literal(null)),
});
export const centralCredentialIdentity = object({
  schemaVersion: literal(1),
  serverId: id,
  userId: id,
  displayName: text(1000),
  tenantId: id,
  repositoryIds: list(id, 100),
  scopes: list(choice(['knowledge:read', 'reviews:submit', 'feedback:submit']), 3, 1),
  clientId: choice(['gcr-cli', 'commit-defender']),
  keyId: id,
  expiresAt: union(timestamp, literal(null)),
});
export const centralConnectionRecord = object({
  formatVersion: literal(1),
  id: sha256,
  status: choice(['pending', 'connected', 'disconnected']),
  serverUrl: text(4096, 1),
  audience: knowledgeAudience,
  trustedKeys: keys,
  ca: union(text(65536, 1), literal(null)),
  offlineBehavior: optional(offlineBehavior),
  repositoryBinding: optional(
    object({
      identity: centralRepositoryIdentity,
      remotesHash: sha256,
    }),
  ),
  credentialReference: id,
  keyId: id,
  clientId: choice(['gcr-cli', 'commit-defender']),
  expiresAt: union(timestamp, literal(null)),
});
export type CentralConnectionRecord = ReturnType<typeof centralConnectionRecord>;
export const centralConnectionReference = sha256;
