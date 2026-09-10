import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { FileTree } from './FileTree.tsx';

it('shows every file and directory unfolded before any selection', () => {
  const files = [
    { id: 'main', path: 'src/deep/feature/main.ts', additions: 10, deletions: 2 },
    { id: 'test', path: 'tests/nested/main.test.ts', additions: 3, deletions: 0 },
    { id: 'readme', path: 'README.md', additions: 1, deletions: 1 },
  ];
  const html = renderToStaticMarkup(<FileTree files={files} selectedPath="" onSelect={() => {}} />);
  for (const file of files) expect(html).toContain(`title="${file.path}"`);
  expect(html).not.toContain('aria-expanded="false"');
  expect(html.split('aria-expanded="true"')).toHaveLength(6);
  expect(html).toContain('class="additions">+10');
  expect(html).toContain('class="deletions">−2');
});
