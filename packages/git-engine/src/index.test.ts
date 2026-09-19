import { describe, expect, it } from 'vitest';
import { materializeFixtureSnapshot, parseChangedPaths } from './index.js';

describe('git engine', () => {
  it('materializes a deterministic fixture without executing repository source', () => {
    const snapshot = materializeFixtureSnapshot(
      'a13f2c8ef8ab792f7428c8bd45d86f2aa97f6d01',
      'd91b7a4f19af10fcb571cefb2d8a61495166c11a',
    );
    expect(snapshot.resolution).toBe('exact');
    expect(snapshot.files).toHaveLength(2);
    expect(snapshot.patch).toContain('database.transaction');
    expect(snapshot.files[1]?.patch).toContain('keeps concurrent rotation attempts consistent');
  });

  it('requires full commit identities', () => {
    expect(() => materializeFixtureSnapshot('a13f2c8', 'd91b7a4')).toThrow('full commit SHA');
  });

  it('keeps every path beyond 2000 files and preserves Git NUL-delimited names', () => {
    const paths = Array.from({ length: 2105 }, (_, index) => `src/file-${index}.py`);
    const result = parseChangedPaths(
      paths.map((path) => `A\0${path}\0`).join('') +
        'R100\0old\tname.py\0새\nname[1].py\0D\0removed.py\0',
    );
    expect(result).toHaveLength(2107);
    expect(result.slice(0, 2105).map((file) => file.path)).toEqual(paths);
    expect(result[2105]).toEqual({
      path: '새\nname[1].py',
      previousPath: 'old\tname.py',
      status: 'renamed',
    });
    expect(result[2106]).toEqual({ path: 'removed.py', previousPath: null, status: 'deleted' });
  });

  it.each(['A\0unterminated', 'R100\0old\0', 'A\0\0', 'unknown\0file\0'])(
    'rejects an incomplete or malformed manifest instead of silently accepting %j',
    (value) => {
      expect(() => parseChangedPaths(value)).toThrow();
    },
  );
});
