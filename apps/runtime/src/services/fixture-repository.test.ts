import { expect, it } from 'vitest';
import { isFixtureRepository } from './fixture-repository.js';

it('limits fixture data to the explicitly registered demo repository', () => {
  expect(isFixtureRepository('fixture', { credentialId: null, installationId: 'fixture' })).toBe(
    true,
  );
  expect(
    isFixtureRepository('fixture', { credentialId: 'real-pat', installationId: 'fixture' }),
  ).toBe(false);
  expect(isFixtureRepository('fixture', { credentialId: null, installationId: '123' })).toBe(false);
  expect(isFixtureRepository('app', { credentialId: null, installationId: 'fixture' })).toBe(false);
});
