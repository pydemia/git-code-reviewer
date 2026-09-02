import { describe, expect, it } from 'vitest';
import { materializeFixtureSnapshot } from './index.js';

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
});
