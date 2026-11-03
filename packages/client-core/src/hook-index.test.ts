import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gcr-commit-hook-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const hooks = path.join(root, 'hooks');
  mkdirSync(hooks);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        `core.hooksPath=${hooks}`,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
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
  const output = path.join(root, 'captured.json'),
    script = path.join(root, 'capture.mjs');
  // This subprocess consumes the built public core, just as a installed hook adapter will.
  writeFileSync(
    script,
    `import {captureLocalSource} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};\nimport {writeFileSync} from 'node:fs';\nconst snapshot=captureLocalSource({cwd:process.cwd(),kind:'index'});\ntry {writeFileSync(${JSON.stringify(output)},JSON.stringify({identity:snapshot.identity,selected:snapshot.selected,index:process.env.GIT_INDEX_FILE,files:Object.fromEntries(['a.ts','b.ts'].map(file=>[file,snapshot.readFile(file)]))}));} finally {snapshot.close();}\n`,
  );
  writeFileSync(
    path.join(hooks, 'pre-commit'),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)}\n`,
    { mode: 0o700 },
  );
  const write = (file: string, body: string) => writeFileSync(path.join(repo, file), body);
  return { root, repo, git, write, proof: () => JSON.parse(readFileSync(output, 'utf8')) };
}
it('captures an unborn commit from the actual pre-commit environment', () => {
  const f = fixture();
  f.write('a.ts', 'export const a=1;\n');
  f.write('b.ts', 'export const b=1;\n');
  f.git('add', '.');
  f.git('commit', '-m', 'initial');
  const proof = f.proof();
  expect(proof.identity.baseCommit).toBeNull();
  expect(proof.identity.sourceTree).toBe(f.git('rev-parse', 'HEAD^{tree}'));
  expect(proof.selected).toHaveLength(2);
}, 20000);
it('captures git commit --only temporary index while preserving unrelated staged changes', () => {
  const f = fixture();
  f.write('a.ts', 'export const a=1;\n');
  f.write('b.ts', 'export const b=1;\n');
  f.git('add', '.');
  f.git('commit', '-m', 'base');
  f.write('a.ts', 'export const a=2;\n');
  f.write('b.ts', 'export const b=2;\n');
  f.git('add', '.');
  f.write('a.ts', 'export const a=3;\n');
  f.git('commit', '--only', '-m', 'partial', '--', 'a.ts');
  const proof = f.proof();
  expect(proof.identity.sourceTree).toBe(f.git('rev-parse', 'HEAD^{tree}'));
  expect(proof.files['a.ts'].text).toBe('export const a=3;\n');
  expect(proof.files['b.ts'].text).toBe('export const b=1;\n');
  expect(proof.selected.map((p: { path: string }) => p.path)).toEqual(['a.ts']);
  expect(f.git('show', ':b.ts')).toBe('export const b=2;');
  expect(proof.index).toBeTruthy();
}, 30000);
it('captures the actual amend index as changes against the pre-amend HEAD', () => {
  const f = fixture();
  f.write('a.ts', 'export const a=1;\n');
  f.write('b.ts', 'export const b=1;\n');
  f.git('add', '.');
  f.git('commit', '-m', 'base');
  const before = f.git('rev-parse', 'HEAD');
  f.write('a.ts', 'export const a=2;\n');
  f.write('b.ts', 'export const b=2;\n');
  f.git('add', '.');
  f.write('a.ts', 'export const a=3;\n');
  f.git('commit', '--amend', '--no-edit', '--only', '--', 'a.ts');
  const proof = f.proof();
  expect(proof.identity.baseCommit).toBe(before);
  expect(proof.identity.sourceTree).toBe(f.git('rev-parse', 'HEAD^{tree}'));
  expect(proof.files['a.ts'].text).toBe('export const a=3;\n');
  expect(proof.files['b.ts'].text).toBe('export const b=1;\n');
  expect(f.git('show', ':b.ts')).toBe('export const b=2;');
}, 30000);
