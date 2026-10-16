import { describe, expect, it } from 'vitest';
import { isTestCodePath } from './test-code.js';

describe('test code path classification', () => {
  it.each([
    'tests/auth/session.py',
    'src/auth/__tests__/session.ts',
    'src/auth/session.test.ts',
    'src/auth/session.spec.tsx',
    'pkg/test_session.py',
    'pkg/session_test.go',
    'src/SessionTests.java',
    'src\\auth\\session.test.ts',
  ])('classifies %s as test code', (filePath) => {
    expect(isTestCodePath(filePath)).toBe(true);
  });

  it.each(['src/contest.ts', 'src/latest.py', 'src/testing.ts', 'src/Session.java'])(
    'does not classify %s as test code',
    (filePath) => {
      expect(isTestCodePath(filePath)).toBe(false);
    },
  );
});
