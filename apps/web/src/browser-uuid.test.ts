import { webcrypto } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { browserUuid } from './browser-uuid.ts';

it('uses randomUUID when available', () => {
  const randomUUID = vi.fn(() => 'native-uuid');
  expect(browserUuid({ randomUUID } as unknown as Crypto)).toBe('native-uuid');
  expect(randomUUID).toHaveBeenCalledOnce();
});
it('generates unique RFC 4122 v4 UUIDs without randomUUID on HTTP', () => {
  const getRandomValues = vi.fn((bytes: Uint8Array) => webcrypto.getRandomValues(bytes));
  const cryptoApi = { getRandomValues } as unknown as Crypto;
  const values = Array.from({ length: 100 }, () => browserUuid(cryptoApi));
  expect(new Set(values).size).toBe(100);
  for (const value of values)
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(getRandomValues).toHaveBeenCalledTimes(100);
});
it('fails clearly without weakening randomness', () => {
  expect(() => browserUuid({} as Crypto)).toThrow('최신 브라우저');
});
