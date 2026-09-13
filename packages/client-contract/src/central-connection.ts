import { choice, id, list, literal, object, sha256, text, timestamp, union } from './codec.js';
import { knowledgeAudience } from './knowledge-manifest.js';
const keys = list(object({ id, pem: text(4096, 1) }), 16, 1);
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
  scopes: list(choice(['knowledge:read']), 1, 1),
  clientId: choice(['gcr-cli', 'commit-defender']),
  keyId: id,
  expiresAt: timestamp,
});
export const centralConnectionRecord = object({
  formatVersion: literal(1),
  id: sha256,
  status: choice(['pending', 'connected', 'disconnected']),
  serverUrl: text(4096, 1),
  audience: knowledgeAudience,
  trustedKeys: keys,
  ca: union(text(65536, 1), literal(null)),
  credentialReference: id,
  keyId: id,
  clientId: choice(['gcr-cli', 'commit-defender']),
  expiresAt: timestamp,
});
export type CentralConnectionRecord = ReturnType<typeof centralConnectionRecord>;
export const centralConnectionReference = sha256;
