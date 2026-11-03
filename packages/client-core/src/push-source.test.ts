import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { parsePrePush, resolvePrePush } from './push-source.js';
import { captureLocalSource } from './source-snapshot.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(format = 'sha1') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gcr-push-'));
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
        'core.hooksPath=/dev/null',
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
  git('init', '-b', 'main', `--object-format=${format}`);
  const write = (text: string) => writeFileSync(path.join(repo, 'file.ts'), text);
  const commit = (text: string) => {
    write(text);
    git('add', '.');
    git('commit', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  return { root, repo, git, write, commit };
}
it('validates the entire bounded input, duplicate destinations and object formats before processing', () => {
  const a = 'a'.repeat(40),
    b = 'b'.repeat(40);
  expect(parsePrePush(`HEAD~ ${a} refs/heads/main ${b}\n`, 'sha1')[0]?.localRef).toBe('HEAD~');
  expect(parsePrePush('', 'sha1')).toEqual([]);
  for (const input of [
    `x ${a} refs/heads/main ${b}\nBAD\n`,
    `x ${a} refs/heads/main ${b}\nx ${a} refs/heads/main ${b}\n`,
    `(delete) ${a} refs/heads/main ${b}\n`,
    `x ${a} refs/heads/main ${'0'.repeat(64)}\n`,
  ])
    expect(() => parsePrePush(input, 'sha1')).toThrow();
});
it('resolves actual multi-ref push input, including creation, force update and deletion', () => {
  const f = fixture();
  const a = f.commit('export const a=1;\n');
  const remote = path.join(f.root, 'remote.git');
  f.git('init', '--bare', remote);
  f.git('remote', 'add', 'origin', remote);
  f.git('push', 'origin', 'main');
  const b = f.commit('export const b=2;\n');
  f.git('branch', 'side');
  const hooks = path.join(f.root, 'hooks');
  mkdirSync(hooks);
  const stream = path.join(f.root, 'pre-push.txt');
  writeFileSync(
    path.join(hooks, 'pre-push'),
    `#!/bin/sh\ncat > '${stream.replace(/'/g, "'\\''")}'\n`,
    { mode: 0o700 },
  );
  f.git('-c', `core.hooksPath=${hooks}`, 'push', 'origin', 'main', 'side');
  const batch = resolvePrePush(f.repo, readFileSync(stream, 'utf8'));
  expect(batch.refs).toHaveLength(2);
  expect(batch.refs.find((r) => r.remoteRef === 'refs/heads/main')).toMatchObject({
    status: 'ready',
    action: 'fast-forward',
    capture: { baseCommit: a, sourceCommit: b },
  });
  const created = batch.refs.find((r) => r.remoteRef === 'refs/heads/side')!;
  expect(created).toMatchObject({
    status: 'ready',
    action: 'create',
    capture: { baseCommit: null, sourceCommit: b, targetBranch: 'side' },
  });
  f.git(
    '-c',
    `core.hooksPath=${hooks}`,
    'push',
    '--force',
    'origin',
    `${a}:refs/heads/main`,
    ':refs/heads/side',
  );
  const second = resolvePrePush(f.repo, readFileSync(stream, 'utf8'));
  expect(second.refs).toHaveLength(2);
  const forced = second.refs.find((r) => r.remoteRef === 'refs/heads/main')!;
  expect(forced).toMatchObject({
    action: 'force-update',
    capture: { baseCommit: b, sourceCommit: a },
  });
  expect(second.refs.find((r) => r.remoteRef === 'refs/heads/side')).toMatchObject({
    status: 'ref-deleted',
  });
  const snapshot = captureLocalSource(forced.capture!);
  try {
    expect(snapshot.readFile('file.ts')).toMatchObject({ text: 'export const a=1;\n' });
    expect(snapshot.readFile('file.ts', 'base')).toMatchObject({ text: 'export const b=2;\n' });
  } finally {
    snapshot.close();
  }
}, 30000);
it('retains unsupported refs and peels commit tags without consulting the current branch', () => {
  const f = fixture();
  const a = f.commit('export const a=1;\n');
  f.git('tag', '-a', 'v1', '-m', 'fixture');
  const tag = f.git('rev-parse', 'v1');
  const blob = f.git('rev-parse', 'HEAD:file.ts');
  const zero = '0'.repeat(40);
  const result = resolvePrePush(
    f.repo,
    `v1 ${tag} refs/tags/v1 ${zero}\nblob ${blob} refs/tags/blob ${zero}\nHEAD ${a} refs/heads/missing ${'a'.repeat(40)}\n`,
  );
  expect(result.refs.map((r) => r.status)).toEqual(['ready', 'unsupported', 'unsupported']);
  expect(result.refs[0]?.capture?.sourceCommit).toBe(a);
  expect(result.refs[0]?.capture?.targetBranch).toBeUndefined();
}, 20000);
it('supports SHA-256 pre-push object IDs and an empty new-ref base', () => {
  const f = fixture('sha256');
  const source = f.commit('export const a=1;\n');
  const result = resolvePrePush(f.repo, `HEAD ${source} refs/heads/main ${'0'.repeat(64)}\n`);
  expect(result.objectFormat).toBe('sha256');
  const snapshot = captureLocalSource(result.refs[0]!.capture!);
  try {
    expect(snapshot.identity).toMatchObject({
      objectFormat: 'sha256',
      kind: 'commit-tree',
      sourceCommit: source,
      baseCommit: null,
    });
  } finally {
    snapshot.close();
  }
}, 20000);
