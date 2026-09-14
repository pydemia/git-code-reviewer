import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  observeAutomaticRepository,
  observeAutomaticFile,
  newlyStagedPaths,
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
it('observes actual staged content, ignores index refresh and whole-file unstaging, and resets on commit', async () => {
  const f = fixture();
  const empty = await observeAutomaticRepository(f.repo);
  expect(empty.changes).toEqual([]);
  f.write('a.ts', 'export const a=2;\n');
  f.write('b.ts', 'export const b=2;\n');
  f.git('add', '.');
  const both = await observeAutomaticRepository(f.repo);
  expect(newlyStagedPaths(empty, both)).toEqual(['a.ts', 'b.ts']);
  f.git('update-index', '--refresh');
  expect((await observeAutomaticRepository(f.repo)).fingerprint).toBe(both.fingerprint);
  f.git('restore', '--staged', 'a.ts');
  const one = await observeAutomaticRepository(f.repo);
  expect(newlyStagedPaths(both, one)).toEqual([]);
  f.git('commit', '-m', 'one');
  const committed = await observeAutomaticRepository(f.repo);
  expect(newlyStagedPaths(one, committed)).toEqual([]);
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
