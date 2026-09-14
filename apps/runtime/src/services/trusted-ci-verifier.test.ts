import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { verifyCiEvidence } from './trusted-ci-verifier.js';
import { input, keys, payload, policy, signed } from '../../test/trusted-ci-fixtures.js';

describe('pinned CI signature and complete input identity', () => {
  it('verifies origin even when a signed regression failed, without changing the outcome', () => {
    expect(verifyCiEvidence(signed(), input, policy)).toMatchObject({
      status: 'verified',
      value: { checks: [{ outcome: 'failed', exitCode: 1 }] },
    });
  });
  it('rejects tampering without a valid replacement signature', () => {
    const evidence = signed();
    evidence.payload.checks[0]!.actual = 'forged success';
    expect(verifyCiEvidence(evidence, input, policy)).toEqual({
      status: 'rejected',
      reason: 'signature-invalid',
    });
  });
  it.each(['contextHash', 'ruleHash', 'toolHash', 'profileHash', 'environmentHash'] as const)(
    'rejects a correctly signed different %s',
    (field) => {
      const p = payload();
      p.input[field] = '9'.repeat(64);
      expect(verifyCiEvidence(signed(p), input, policy)).toEqual({
        status: 'rejected',
        reason: 'input-mismatch',
      });
    },
  );
  it.each([
    'baseCommit',
    'headCommit',
    'mergeBaseCommit',
    'baseTree',
    'headTree',
    'mergeBaseTree',
    'sourceHash',
  ] as const)('rejects a correctly signed different source.%s', (field) => {
    const p = payload();
    p.input.source[field] = '9'.repeat(field === 'sourceHash' ? 64 : 40);
    expect(verifyCiEvidence(signed(p), input, policy)).toEqual({
      status: 'rejected',
      reason: 'input-mismatch',
    });
  });
  it.each(['apiBaseUrl', 'repositoryId', 'repository'] as const)(
    'rejects another %s despite a trusted signature',
    (field) => {
      const p = payload();
      p.input[field] = {
        apiBaseUrl: 'https://other.example/api/v3/',
        repositoryId: '43',
        repository: 'other/repo',
      }[field];
      expect(verifyCiEvidence(signed(p), input, policy)).toMatchObject({
        reason: 'repository-mismatch',
      });
    },
  );
  it('enforces issuer, key id, exact ref and workflow content', () => {
    for (const field of ['issuer', 'keyId'] as const) {
      const p = payload();
      p[field] += 'other';
      expect(verifyCiEvidence(signed(p), input, policy)).toMatchObject({
        reason: 'issuer-mismatch',
      });
    }
    const p = payload();
    p.input.ref = 'refs/heads/main';
    expect(verifyCiEvidence(signed(p), input, policy)).toMatchObject({ reason: 'ref-mismatch' });
    p.input.ref = input.ref;
    p.workflow.contentHash = '9'.repeat(64);
    expect(verifyCiEvidence(signed(p), input, policy)).toMatchObject({
      reason: 'workflow-mismatch',
    });
    expect(verifyCiEvidence(signed(), input, { ...policy, allowedRefs: [input.ref] }).status).toBe(
      'verified',
    );
  });
  it('rejects expired, future, over-age and overlong assertions at the boundary', () => {
    const now = new Date('2026-09-15T00:00:00.000Z');
    for (const delta of [0, -1]) {
      const p = payload(now);
      p.expiresAt = new Date(now.getTime() + delta).toISOString();
      expect(verifyCiEvidence(signed(p), input, policy, now)).toMatchObject({ reason: 'stale' });
    }
    const future = payload(now);
    future.issuedAt = new Date(now.getTime() + 1).toISOString();
    expect(verifyCiEvidence(signed(future), input, policy, now)).toMatchObject({
      reason: 'future-evidence',
    });
    const old = payload(now);
    old.issuedAt = new Date(now.getTime() - 3600001).toISOString();
    expect(verifyCiEvidence(signed(old), input, policy, now)).toMatchObject({ reason: 'stale' });
    const long = payload(now);
    long.expiresAt = new Date(now.getTime() + 3600000).toISOString();
    expect(verifyCiEvidence(signed(long), input, policy, now)).toMatchObject({ reason: 'stale' });
  });
  it('rejects duplicated checks and inconsistent success', () => {
    const duplicate = payload();
    duplicate.checks.push(duplicate.checks[0]!);
    expect(verifyCiEvidence(signed(duplicate), input, policy)).toMatchObject({
      reason: 'invalid-envelope',
    });
    const inconsistent = payload();
    inconsistent.checks[0]!.outcome = 'passed';
    expect(verifyCiEvidence(signed(inconsistent), input, policy)).toMatchObject({
      reason: 'invalid-envelope',
    });
  });
  it('trusts nothing by default and rejects private, invalid or duplicate verification configuration', () => {
    const base = { DATABASE_URL: 'postgresql://example.invalid/gcr' };
    expect(loadConfig(base).TRUSTED_CI_POLICIES).toEqual([]);
    expect(
      loadConfig({ ...base, TRUSTED_CI_POLICIES: JSON.stringify([policy]) }).TRUSTED_CI_POLICIES,
    ).toEqual([policy]);
    for (const publicKey of [
      'invalid',
      keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    ]) {
      expect(() =>
        loadConfig({ ...base, TRUSTED_CI_POLICIES: JSON.stringify([{ ...policy, publicKey }]) }),
      ).toThrow('TRUSTED_CI_POLICIES');
    }
    expect(() =>
      loadConfig({ ...base, TRUSTED_CI_POLICIES: JSON.stringify([policy, policy]) }),
    ).toThrow('TRUSTED_CI_POLICIES');
  });
});
