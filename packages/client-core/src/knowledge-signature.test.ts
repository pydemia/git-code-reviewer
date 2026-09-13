import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalKnowledgeJson,
  KNOWLEDGE_SIGNATURE_CONTEXT,
  type KnowledgeManifestPayload,
} from '@gcr/client-contract';
import { verifyKnowledgeManifest } from './knowledge-signature.js';

const key = generateKeyPairSync('ed25519');
const now = Date.parse('2026-09-14T00:00:00.000Z');
const audience = { serverId: 'server', tenantId: 'tenant', repositoryId: 'repo', userId: 'alice' };
const part = {
  bundleId: 'bundle',
  releaseSequence: 3,
  contentHash: 'a'.repeat(64),
  sizeBytes: 100,
};
const payload = (): KnowledgeManifestPayload => ({
  schemaVersion: 1,
  audience,
  snapshotId: 'snapshot',
  authorizationRevision: 10,
  components: { policy: part, collective: part, personal: part },
  revocations: {
    policyMinimumSequence: 3,
    collectiveMinimumSequence: 3,
    personalMinimumSequence: 3,
  },
  compatibleClientContracts: { minimum: 2, maximum: 2 },
  issuedAt: new Date(now).toISOString(),
  refreshAfter: new Date(now + 300000).toISOString(),
  offlineValidUntil: new Date(now + 86400000).toISOString(),
  signingKeyId: 'key-1',
});
const signed = (p = payload()) => {
  const bytes = canonicalKnowledgeJson(p);
  return {
    payload: p,
    manifestHash: createHash('sha256').update(bytes).digest('hex'),
    signature: sign(
      null,
      Buffer.from(KNOWLEDGE_SIGNATURE_CONTEXT + bytes),
      key.privateKey,
    ).toString('base64url'),
  };
};
const options = () => ({
  audience,
  trustedKeys: new Map([['key-1', key.publicKey]]),
  now,
  mode: 'online' as const,
});
describe('pinned knowledge manifest verification', () => {
  it('negotiates explicit v2 compatibility and permits legacy verification only when requested', () => {
    const legacy = signed({ ...payload(), compatibleClientContracts: { minimum: 1, maximum: 1 } });
    expect(() => verifyKnowledgeManifest(legacy, options())).toThrow('Incompatible');
    expect(() =>
      verifyKnowledgeManifest(legacy, { ...options(), clientContractVersion: 1 }),
    ).not.toThrow();
    expect(() =>
      verifyKnowledgeManifest(signed(), { ...options(), clientContractVersion: 1 }),
    ).toThrow('Incompatible');
    expect(() =>
      verifyKnowledgeManifest(
        signed({ ...payload(), compatibleClientContracts: { minimum: 3, maximum: 2 } }),
        options(),
      ),
    ).toThrow('compatibility range');
  });
  it('accepts authenticated canonical content and explicit offline leases', () => {
    expect(verifyKnowledgeManifest(signed(), options()).payload.audience).toEqual(audience);
    expect(() =>
      verifyKnowledgeManifest(signed(), { ...options(), now: now + 600000, mode: 'offline' }),
    ).not.toThrow();
    expect(() => verifyKnowledgeManifest(signed(), { ...options(), now: now + 300000 })).toThrow(
      'expired',
    );
    expect(() =>
      verifyKnowledgeManifest(signed(), { ...options(), now: now + 86400000, mode: 'offline' }),
    ).toThrow('expired');
  });
  it('rejects every audience mismatch, including another user on the same repository', () => {
    for (const field of Object.keys(audience))
      expect(() =>
        verifyKnowledgeManifest(signed(), {
          ...options(),
          audience: { ...audience, [field]: 'other' },
        }),
      ).toThrow('audience');
  });
  it('requires out-of-band key trust and rejects key substitution, payload or signature tampering', () => {
    expect(() =>
      verifyKnowledgeManifest(signed(), { ...options(), trustedKeys: new Map() }),
    ).toThrow('Untrusted');
    expect(() =>
      verifyKnowledgeManifest(signed(), {
        ...options(),
        trustedKeys: new Map([['key-1', generateKeyPairSync('ed25519').publicKey]]),
      }),
    ).toThrow('signature');
    const modified = signed();
    modified.payload.authorizationRevision++;
    expect(() => verifyKnowledgeManifest(modified, options())).toThrow('signature');
    modified.manifestHash = createHash('sha256')
      .update(canonicalKnowledgeJson(modified.payload))
      .digest('hex');
    expect(() => verifyKnowledgeManifest(modified, options())).toThrow('signature');
    expect(() =>
      verifyKnowledgeManifest({ ...signed(), signature: 'A'.repeat(86) }, options()),
    ).toThrow('signature');
  });
  it('rejects lower persisted authorization or component sequences and unknown payload fields', () => {
    expect(() =>
      verifyKnowledgeManifest(signed(), { ...options(), minimumAuthorizationRevision: 11 }),
    ).toThrow('revision replay');
    for (const component of ['policy', 'collective', 'personal'])
      expect(() =>
        verifyKnowledgeManifest(signed(), { ...options(), minimumSequences: { [component]: 4 } }),
      ).toThrow('sequence replay');
    expect(() =>
      verifyKnowledgeManifest({ ...signed(), publicKey: 'trust me' }, options()),
    ).toThrow('unknown field');
  });
  it('rejects invalid leases, future clocks, expired offline-disabled manifests and invalid keys', () => {
    const disabled = { ...payload(), offlineValidUntil: new Date(now).toISOString() };
    expect(() => verifyKnowledgeManifest(signed(disabled), options())).not.toThrow();
    expect(() =>
      verifyKnowledgeManifest(signed(disabled), { ...options(), mode: 'offline' }),
    ).toThrow('expired');
    expect(() => verifyKnowledgeManifest(signed(), { ...options(), now: now - 31000 })).toThrow(
      'not yet valid',
    );
    expect(() => verifyKnowledgeManifest(signed(), { ...options(), now: NaN })).toThrow('expired');
    expect(() =>
      verifyKnowledgeManifest(
        signed({ ...payload(), offlineValidUntil: new Date(now + 86400001).toISOString() }),
        options(),
      ),
    ).toThrow('lifetime');
    expect(() =>
      verifyKnowledgeManifest(signed(), {
        ...options(),
        trustedKeys: new Map([['key-1', key.privateKey]]),
      }),
    ).toThrow('verification key');
  });
  it('accepts a rotated key only when the caller explicitly trusts its ID and key', () => {
    const manifest = signed({ ...payload(), signingKeyId: 'key-2' });
    expect(() => verifyKnowledgeManifest(manifest, options())).toThrow('Untrusted');
    expect(() =>
      verifyKnowledgeManifest(manifest, {
        ...options(),
        trustedKeys: new Map([['key-2', key.publicKey]]),
      }),
    ).not.toThrow();
  });
});
