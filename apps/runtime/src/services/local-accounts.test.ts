import { describe, expect, it } from 'vitest';
import {
  assertLocalPassword,
  assertLocalUsername,
  hashLocalPassword,
  normalizeLocalUsername,
  verifyLocalPassword,
} from './local-accounts.js';

describe('local account credentials', () => {
  it('normalizes and validates a local username', () => {
    expect(normalizeLocalUsername(' Reviewer.One ')).toBe('reviewer.one');
    expect(assertLocalUsername('Reviewer.One')).toBe('reviewer.one');
    expect(() => assertLocalUsername('../admin')).toThrow('사용자 이름');
    expect(() => assertLocalUsername('ab')).toThrow('사용자 이름');
  });

  it('enforces the password length policy', () => {
    expect(() => assertLocalPassword('short')).toThrow('12~128자');
    expect(() => assertLocalPassword('correct horse battery staple')).not.toThrow();
  });

  it('hashes with a random salt and verifies in constant-time comparison', async () => {
    const first = await hashLocalPassword('correct horse battery staple');
    const second = await hashLocalPassword('correct horse battery staple');
    expect(first).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(second).not.toBe(first);
    await expect(verifyLocalPassword('correct horse battery staple', first)).resolves.toBe(true);
    await expect(verifyLocalPassword('incorrect password', first)).resolves.toBe(false);
    await expect(verifyLocalPassword('correct horse battery staple', 'invalid')).resolves.toBe(
      false,
    );
  });
});
