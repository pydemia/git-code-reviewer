import { expect, it } from 'vitest';
import { ancestorPaths, buildFileTree, visibleFileTree } from './file-tree.ts';

it('groups folders before files with aggregate additions and deletions', () => {
  const tree = buildFileTree([
    { id: '1', path: 'src/b.ts', additions: 3, deletions: 1 },
    { id: '2', path: 'README.md', additions: 1, deletions: 0 },
    { id: '3', path: 'src/auth/a.ts', additions: 7, deletions: 4 },
  ]);
  expect(tree.map((node) => node.name)).toEqual(['src', 'README.md']);
  expect(tree[0]).toMatchObject({ additions: 10, deletions: 5 });
  expect(visibleFileTree(tree, new Set()).map(({ node }) => node.path)).toEqual([
    'src',
    'README.md',
  ]);
  expect(visibleFileTree(tree, new Set(['src'])).map(({ node }) => node.path)).toEqual([
    'src',
    'src/auth',
    'src/b.ts',
    'README.md',
  ]);
  expect(ancestorPaths('src/auth/a.ts')).toEqual(['src', 'src/auth']);
});

it('does not invent zero counts for binary or unknown changes', () => {
  expect(
    buildFileTree([{ id: '1', path: 'assets/image.png', additions: null, deletions: null }])[0],
  ).toMatchObject({ additions: null, deletions: null });
});
