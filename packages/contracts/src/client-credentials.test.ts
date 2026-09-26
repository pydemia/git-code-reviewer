import { describe, expect, it } from 'vitest';
import { clientCredentialInputSchema } from './client-credentials.js';

const input = {
  name: 'Reader',
  clientId: 'commit-defender',
  tenantId: '10000000-0000-4000-8000-000000000001',
  repositoryIds: ['10000000-0000-4000-8000-000000000002'],
};
describe('client key expiry choices', () => {
  it('keeps a 30 day default and accepts explicit no expiration', () => {
    expect(clientCredentialInputSchema.parse(input).lifetimeDays).toBe(30);
    expect(
      clientCredentialInputSchema.parse({ ...input, lifetimeDays: null }).lifetimeDays,
    ).toBeNull();
  });
  it.each([0, -1, 91, 1.5, 'null', 'none', '30'])(
    'rejects an invalid lifetime %s',
    (lifetimeDays) => {
      expect(clientCredentialInputSchema.safeParse({ ...input, lifetimeDays }).success).toBe(false);
    },
  );
});
