import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  observeAutomaticRepository,
  observeAutomaticFile,
  newlyStagedPaths,
  observeAutomaticWorkingTree,
} from './automatic-source.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gcr-auto-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      {
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      },
    ).trim();
  git('init', '-b', 'main');
  writeFileSync(path.join(repo, 'a.ts'), 'export const a=1;\n');
  writeFileSync(path.join(repo, 'b.ts'), 'export const b=1;\n');
  git('add', '.');
  git('commit', '-m', 'base');
  return {
    root,
    repo,
    git,
    write: (file: string, text: string) => writeFileSync(path.join(repo, file), text),
  };
}
it('re-queries working changes including nested deletions, ignores private files and notices return to base', async () => {
  const f = fixture();
  mkdirSync(path.join(f.repo, 'nested'));
  f.write('nested/old.ts', 'export const old=1;\n');
  f.git('add', '.');
  f.git('commit', '-m', 'nested');
  const clean = await observeAutomaticWorkingTree(f.repo);
  expect(clean.files).toEqual([]);
  rmSync(path.join(f.repo, 'nested'), { recursive: true });
  f.write('new.ts', 'export const fresh=2;\n');
  f.write('.env', 'PRIVATE');
  f.write('.gitignore', 'ignored.ts\n');
  f.write('ignored.ts', 'PRIVATE');
  f.write('binary.ts', 'BINARY\0CONTENT');
  const changed = await observeAutomaticWorkingTree(f.repo, ['.gitignore']);
  expect(changed.files.map((f) => f.path)).toEqual(['nested/old.ts', 'new.ts']);
  expect(changed.files[0]?.hash).toBeNull();
  expect((await observeAutomaticWorkingTree(f.repo, ['.gitignore'])).fingerprint).toBe(
    changed.fingerprint,
  );
  rmSync(path.join(f.repo, 'new.ts'));
  f.git('restore', 'nested/old.ts');
  expect((await observeAutomaticWorkingTree(f.repo, ['.gitignore'])).files).toEqual([]);
}, 20000);
it('observes actual staged content, ignores index refresh and whole-file unstaging, and resets on commit', async () => {
  const f = fixture();
  const empty = await observeAutomaticRepository(f.repo);
  expect(empty.changes).toEqual([]);
  f.write('a.ts', 'export const a=2;\n');
  f.write('b.ts', 'export const b=2;\n');
  f.git('add', '.');
  const both = await observeAutomaticRepository(f.repo);
  expect(await newlyStagedPaths(empty, both)).toEqual(['a.ts', 'b.ts']);
  f.git('update-index', '--refresh');
  expect((await observeAutomaticRepository(f.repo)).fingerprint).toBe(both.fingerprint);
  f.git('restore', '--staged', 'a.ts');
  const one = await observeAutomaticRepository(f.repo);
  expect(await newlyStagedPaths(both, one)).toEqual([]);
  f.git('commit', '-m', 'one');
  const committed = await observeAutomaticRepository(f.repo);
  expect(await newlyStagedPaths(one, committed)).toEqual([]);
}, 20000);
it.each([
  ['separate replacements', 'A\nb\nC\nd\n', 'a\nb\nC\nd\n', false],
  ['adjacent replacements', 'A\nB\nc\nd\n', 'a\nB\nc\nd\n', false],
  ['insertions', 'first\nsecond\na\nb\nc\nd\n', 'second\na\nb\nc\nd\n', false],
  ['deletions', 'a\nd\n', 'a\nb\nd\n', false],
  ['mixed unstage and new edit', 'A\nb\nC\nd\n', 'a\nb\nNEW\nd\n', true],
  ['new deletion of an unchanged line', 'A\nb\nc\nd\n', 'A\nc\nd\n', true],
  ['new insertion of an existing line', 'A\nb\nc\nd\n', 'A\nb\nb\nc\nd\n', true],
])(
  'classifies %s from fixed index blobs',
  async (_name, staged, partial, shouldReview) => {
    const f = fixture();
    f.write('a.ts', 'a\nb\nc\nd\n');
    f.git('add', 'a.ts');
    f.git('commit', '-m', 'multiline base');
    f.write('a.ts', staged);
    f.git('add', 'a.ts');
    const before = await observeAutomaticRepository(f.repo);
    f.write('a.ts', partial);
    f.git('add', 'a.ts');
    f.write('a.ts', 'UNRELATED DIRTY EDITOR CONTENT\n');
    const current = await observeAutomaticRepository(f.repo);
    expect(await newlyStagedPaths(before, current)).toEqual(shouldReview ? ['a.ts'] : []);
  },
  20000,
);
it('recognizes partial unstaging of added and deleted files and preserves new mode changes', async () => {
  const f = fixture();
  f.write('new.ts', 'first\nsecond\n');
  f.git('add', 'new.ts');
  const added = await observeAutomaticRepository(f.repo);
  f.write('new.ts', 'second\n');
  f.git('add', 'new.ts');
  const partial = await observeAutomaticRepository(f.repo);
  expect(await newlyStagedPaths(added, partial)).toEqual([]);
  f.git('update-index', '--chmod=+x', 'new.ts');
  expect(await newlyStagedPaths(partial, await observeAutomaticRepository(f.repo))).toEqual([
    'new.ts',
  ]);
  f.write('b.ts', 'first\nsecond\n');
  f.git('add', 'b.ts');
  f.git('commit', '-m', 'base for deletion');
  f.git('rm', 'b.ts');
  const deleted = await observeAutomaticRepository(f.repo);
  f.write('b.ts', 'second\n');
  f.git('add', 'b.ts');
  expect(await newlyStagedPaths(deleted, await observeAutomaticRepository(f.repo))).toEqual([]);
}, 20000);
it('discovers worktree index paths and a repository opened at a subdirectory', async () => {
  const f = fixture();
  mkdirSync(path.join(f.repo, 'sub'));
  expect((await observeAutomaticRepository(path.join(f.repo, 'sub'))).root).toBe(
    await import('node:fs/promises').then((m) => m.realpath(f.repo)),
  );
  const other = path.join(f.root, 'worktree');
  f.git('worktree', 'add', '-b', 'other', other);
  const state = await observeAutomaticRepository(other);
  expect(state.indexPath).toContain('/worktrees/');
  expect(state.indexPath).not.toBe((await observeAutomaticRepository(f.repo)).indexPath);
}, 20000);
it('reads only reviewable saved paths and distinguishes clean saves, content edits and exclusions', async () => {
  const f = fixture();
  expect((await observeAutomaticFile(f.repo, 'a.ts'))?.changed).toBe(false);
  f.write('a.ts', 'export const a=3;\n');
  expect((await observeAutomaticFile(f.repo, 'a.ts'))?.changed).toBe(true);
  f.git('add', 'a.ts');
  f.write('a.ts', 'export const a=1;\n');
  expect((await observeAutomaticFile(f.repo, 'a.ts'))?.changed).toBe(false);
  f.write('new.ts', 'export const fresh=1;\n');
  expect((await observeAutomaticFile(f.repo, 'new.ts'))?.changed).toBe(true);
  expect(await observeAutomaticFile(f.repo, 'a.ts', ['*.ts'])).toBeUndefined();
  f.write('.env', 'SECRET');
  expect(await observeAutomaticFile(f.repo, '.env')).toBeUndefined();
  mkdirSync(path.join(f.repo, '.codex'));
  f.write('.codex/private.ts', 'SECRET');
  symlinkSync(path.join(f.repo, '.codex'), path.join(f.repo, 'alias'));
  expect(await observeAutomaticFile(f.repo, 'alias/private.ts')).toBeUndefined();
  f.write('.gitignore', 'ignored.ts\n');
  f.write('ignored.ts', 'PRIVATE_IGNORED');
  expect(await observeAutomaticFile(f.repo, 'ignored.ts')).toBeUndefined();
}, 20000);
it('supports an unborn repository and keeps a partial stage separate from working bytes', async () => {
  const f = fixture();
  f.write('a.ts', 'export const staged=2;\n');
  f.git('add', 'a.ts');
  const staged = await observeAutomaticRepository(f.repo);
  f.write('a.ts', 'export const working=3;\n');
  expect((await observeAutomaticRepository(f.repo)).fingerprint).toBe(staged.fingerprint);
  const unborn = path.join(f.root, 'unborn');
  mkdirSync(unborn);
  execFileSync('git', ['init', '-b', 'main', unborn], { stdio: 'ignore' });
  writeFileSync(path.join(unborn, 'a.ts'), 'const a=1;\n');
  execFileSync('git', ['-C', unborn, 'add', 'a.ts'], { stdio: 'ignore' });
  const state = await observeAutomaticRepository(unborn);
  expect(state.head).toBeNull();
  expect(state.changes[0]?.status).toBe('A');
}, 20000);
