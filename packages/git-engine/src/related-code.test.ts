import { describe, expect, it } from 'vitest';
import { findCodeCandidates, maskNonCode } from './related-code.js';

describe('bounded lexical source relationships', () => {
  it('distinguishes definitions, callers and callees without matching strings and comments', () => {
    const lines = [
      'function retry() {',
      '  backoff();',
      '}',
      'function send() {',
      '  retry();',
      '}',
      '// retry()',
      'const text="retry()";',
      'retryForever();',
    ];
    const matches = findCodeCandidates('src/client.ts', lines, 'retry');
    expect(
      matches.map(({ relation, line, symbol, enclosing }) => ({
        relation,
        line,
        symbol,
        enclosing,
      })),
    ).toEqual([
      { relation: 'definition', line: 1, symbol: 'retry', enclosing: null },
      { relation: 'callee', line: 2, symbol: 'backoff', enclosing: 'retry' },
      { relation: 'caller', line: 5, symbol: 'retry', enclosing: 'send' },
    ]);
  });
  it('finds Python lexical function boundaries and related tests', () => {
    const matches = findCodeCandidates(
      'tests/test_retry.py',
      ['def retry():', '    backoff()', 'def test_retry():', '    retry()', '# retry()'],
      'retry',
    );
    expect(matches.map((item) => item.relation)).toEqual(['definition', 'callee', 'test']);
    expect(matches[2]?.enclosing).toBe('test_retry');
  });
  it('retains line offsets while excluding docstrings and multiline comments', () => {
    expect(maskNonCode('"""retry()\nretry()"""\nretry()', true).split('\n')).toHaveLength(3);
    expect(
      findCodeCandidates('src/a.ts', ['/* retry()', 'retry() */', 'retry()'], 'retry'),
    ).toHaveLength(1);
    expect(() => findCodeCandidates('a.ts', [], 'a.*')).toThrow('symbol_identifier_required');
  });
});
