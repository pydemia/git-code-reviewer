import { describe, expect, it } from 'vitest';
import { analyzeAddedTests } from './test-analysis.js';

describe('added test analysis', () => {
  it('summarizes added JavaScript test cases and assertions', () => {
    const [file] = analyzeAddedTests([
      {
        path: 'src/auth/session.test.ts',
        additions: 8,
        patch: [
          'diff --git a/src/auth/session.test.ts b/src/auth/session.test.ts',
          '--- /dev/null',
          '+++ b/src/auth/session.test.ts',
          '@@ -0,0 +1,8 @@',
          "+describe('rotateSession', () => {",
          "+  it('serializes concurrent rotation attempts', async () => {",
          '+    const result = await Promise.all([rotate(), rotate()]);',
          '+    expect(result.filter(Boolean)).toHaveLength(1);',
          '+  });',
          "+  it('returns null for a revoked token', async () => {",
          '+    expect(await rotateRevoked()).toBeNull();',
          '+  });',
        ].join('\n'),
      },
    ]);

    expect(file?.cases).toHaveLength(2);
    expect(file?.cases[0]).toMatchObject({
      suite: 'rotateSession',
      line: 2,
      assertionCount: 1,
    });
    expect(file?.cases[0]?.explanation).toContain('동시 요청');
    expect(file?.summary).toContain('2개의 test case');
  });

  it('recognizes Python test functions', () => {
    const [file] = analyzeAddedTests([
      {
        path: 'tests/test_session.py',
        additions: 2,
        patch:
          '@@ -0,0 +1,2 @@\n+def test_invalid_token_returns_none():\n+    assert rotate("bad") is None',
      },
    ]);
    expect(file?.cases[0]).toMatchObject({
      title: 'invalid token returns none',
      line: 1,
      assertionCount: 1,
    });
  });

  it('reports when a snapshot omits the test patch body', () => {
    const [file] = analyzeAddedTests([
      {
        path: 'src/auth/session.test.ts',
        additions: 42,
        patch:
          'diff --git a/src/auth/session.test.ts b/src/auth/session.test.ts\nnew file mode 100644\n',
      },
    ]);
    expect(file).toMatchObject({ patchAvailable: false, cases: [] });
    expect(file?.summary).toContain('본문이 없습니다');
  });
});
