import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  credentialFingerprint,
  decryptCredential,
  encryptCredential,
  validCredentialEncryptionKey,
} from './credential-crypto.js';

describe('credential encryption', () => {
  const key = randomBytes(32).toString('base64');

  it('round trips a purpose-bound credential', () => {
    const encrypted = encryptCredential('secret-token', key, 'github-access-token');
    expect(decryptCredential(encrypted, key, 'github-access-token')).toBe('secret-token');
    expect(() => decryptCredential(encrypted, key, 'chat-account')).toThrow();
  });

  it('validates key length and returns a non-reversible fingerprint', () => {
    expect(validCredentialEncryptionKey(key)).toBe(true);
    expect(validCredentialEncryptionKey('short')).toBe(false);
    expect(credentialFingerprint('secret-token')).toMatch(/^[0-9a-f]{64}$/);
    expect(credentialFingerprint('secret-token')).not.toContain('secret-token');
  });
});
