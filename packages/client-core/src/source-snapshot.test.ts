import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { readSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureLocalSource } from './source-snapshot.js';
import { sourcePathPolicy } from './source-policy.js';
import { SourceGit } from './source-git.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
// Each capture uses synchronous Git plumbing. Let the test worker deliver its
// pending RPC updates between fixtures instead of starving them across the file.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

function fixture(action: (f: ReturnType<typeof createFixture>) => void, format = 'sha1') {
  const f = createFixture(format);
  try {
    action(f);
  } finally {
    vi.restoreAllMocks();
    vi.mocked(readSync).mockImplementation(fs.readSync);
    fs.rmSync(f.root, { recursive: true, force: true });
  }
}
function createFixture(format: string) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'gcr-source-test-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const gitAt = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        cwd,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        ...args,
      ],
      {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_INDEX_FILE: undefined,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      },
    ).trim();
  const git = (...args: string[]) => gitAt(repo, ...args);
  git('init', '-b', 'main', `--object-format=${format}`);
  const write = (file: string, content: string | Buffer) => {
    const target = path.join(repo, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const commit = () => {
    git('add', '.');
    git('commit', '-m', 'fixture');
  };
  return { root, repo, git, gitAt, write, commit };
}
function preserve(repo: string) {
  const index = execFileSync(
    'git',
    ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-path', 'index'],
    { encoding: 'utf8' },
  ).trim();
  const bytes = fs.existsSync(index) ? fs.readFileSync(index) : undefined;
  const modified = bytes ? fs.statSync(index).mtimeMs : undefined;
  const objectRoot = execFileSync(
    'git',
    ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-path', 'objects'],
    { encoding: 'utf8' },
  ).trim();
  const inventory = (root: string): string[] =>
    fs
      .readdirSync(root, { withFileTypes: true })
      .flatMap((entry) =>
        entry.isDirectory()
          ? inventory(path.join(root, entry.name)).map((file) => `${entry.name}/${file}`)
          : [entry.name],
      )
      .sort();
  const objects = inventory(objectRoot);
  return () => {
    expect(fs.existsSync(index)).toBe(bytes !== undefined);
    if (bytes) {
      expect(fs.readFileSync(index)).toEqual(bytes);
      expect(fs.statSync(index).mtimeMs).toBe(modified);
    }
    expect(inventory(objectRoot)).toEqual(objects);
  };
}

describe('immutable local source capture', { timeout: 20_000 }, () => {
  it('freezes partial stage, base and related source independently of later HEAD/index/working edits', () =>
    fixture((f) => {
      f.write('api.py', 'value = 0\n');
      f.write('caller.py', 'from api import value\n');
      f.commit();
      const head = f.git('rev-parse', 'HEAD');
      f.write('api.py', 'value = 1\n');
      f.git('add', 'api.py');
      f.write('api.py', 'value = 2 # unstaged\n');
      const before = preserve(f.repo);
      const snapshot = captureLocalSource({ cwd: f.repo, kind: 'index' });
      before();
      expect(captureLocalSource({ cwd: f.repo, kind: 'index' }).identity.hash).toBe(
        snapshot.identity.hash,
      );
      expect(snapshot.headCommit).toBe(head);
      expect(snapshot.selected).toEqual([{ path: 'api.py', status: 'M', side: 'source' }]);
      expect(snapshot.readFile('api.py')).toMatchObject({
        status: 'available',
        text: 'value = 1\n',
      });
      expect(snapshot.readFile('api.py', 'base')).toMatchObject({
        status: 'available',
        text: 'value = 0\n',
      });
      f.write('api.py', 'value = 7\n');
      f.write('caller.py', 'later = True\n');
      f.commit();
      expect(snapshot.readFile('caller.py')).toMatchObject({
        status: 'available',
        text: 'from api import value\n',
      });
      expect(snapshot.diff).toContain('+value = 1');
      expect(snapshot.diff).not.toContain('unstaged');
      const manifest = snapshot.sourceFiles;
      manifest[0]!.hash = '0'.repeat(64);
      expect(snapshot.sourceFiles[0]!.hash).not.toBe(manifest[0]!.hash);
      fs.rmSync(f.repo, { recursive: true });
      expect(snapshot.search('value').matches.map((match) => match.source.path)).toEqual([
        'api.py',
        'caller.py',
      ]);
      expect(snapshot.readLines('api.py')).toMatchObject({
        status: 'available',
        text: 'value = 1\n',
      });
      snapshot.close();
      expect(() => snapshot.readFile('api.py')).toThrow('snapshot-closed');
    }));
  it('uses saved working contents, explicit untracked inclusion and fixed related contents', () =>
    fixture((f) => {
      f.write('a.ts', 'export const x = 0;\n');
      f.write('related.rs', 'fn related() {}\n');
      f.commit();
      f.write('a.ts', 'export const x = 1;\n');
      f.git('add', 'a.ts');
      f.write('a.ts', 'export const x = 2;\n');
      f.write('new.py', 'new = 1\n');
      f.write('omitted.py', 'not_authorized = 1\n');
      const before = preserve(f.repo);
      const captured = captureLocalSource({
        cwd: f.repo,
        kind: 'working-tree',
        includeUntracked: ['new.py'],
      });
      before();
      expect(captured.selected.map((entry) => entry.path)).toEqual(['a.ts', 'new.py']);
      expect(captured.readFile('a.ts')).toMatchObject({ text: 'export const x = 2;\n' });
      expect(captured.readFile('omitted.py')).toEqual({ status: 'absent' });
      expect(captured.readFile('related.rs')).toMatchObject({ text: 'fn related() {}\n' });
      f.write('related.rs', 'later\n');
      expect(captured.readFile('related.rs')).toMatchObject({ text: 'fn related() {}\n' });
      expect(captured.identity.hash).not.toBe(
        captureLocalSource({ cwd: f.repo, kind: 'working-tree', includeUntracked: ['new.py'] })
          .identity.hash,
      );
    }));
  it('retains deleted base, renamed source and unchanged consumers without private descendants in a patch', () =>
    fixture((f) => {
      f.write('api.py', 'def load():\n    return 1\n');
      f.write('caller.py', 'from api import load\n');
      f.write('old.ts', 'export const moved = 1;\n');
      f.write('container.ts', 'export const old = 1;\n');
      f.commit();
      f.git('rm', 'api.py', 'container.ts');
      f.git('mv', 'old.ts', 'new.ts');
      f.write('container.ts/.env', 'SYNTHETIC_PRIVATE_CANARY');
      f.git('add', '-f', 'container.ts/.env');
      const before = preserve(f.repo);
      const captured = captureLocalSource({ cwd: f.repo, kind: 'index' });
      before();
      expect(captured.selected).toEqual([
        { path: 'api.py', status: 'D', side: 'base' },
        { path: 'container.ts', status: 'D', side: 'base' },
        { path: 'new.ts', oldPath: 'old.ts', status: 'R', side: 'source' },
      ]);
      expect(captured.readFile('api.py')).toEqual({ status: 'absent' });
      expect(captured.readFile('api.py', 'base')).toMatchObject({
        text: 'def load():\n    return 1\n',
      });
      expect(captured.diff).toContain('rename from old.ts');
      expect(captured.diff).toContain('-export const old');
      expect(captured.diff).not.toContain('CANARY');
      expect(captured.diff).not.toContain('container.ts/.env');
    }));
  for (const format of ['sha1', 'sha256'])
    it(`handles ${format} initial commits and intent-to-add without changing index or object storage`, () =>
      fixture((f) => {
        f.write('staged.ts', 'export const staged = 1;\n');
        f.git('add', 'staged.ts');
        f.write('intent.ts', 'not staged');
        f.git('add', '-N', 'intent.ts');
        const before = preserve(f.repo);
        const captured = captureLocalSource({ cwd: f.repo, kind: 'index' });
        before();
        expect(captured.identity.baseCommit).toBeNull();
        expect(captured.identity.baseTree.length).toBe(format === 'sha1' ? 40 : 64);
        expect(captured.selected.map((entry) => entry.path)).toEqual(['staged.ts']);
        expect(captured.diff).not.toContain('intent.ts');
      }, format));
  for (const mode of ['version4', 'split', 'sparse'])
    it(`reads a ${mode} index and preserves fixed related source`, () =>
      fixture((f) => {
        f.write('inside/a.py', 'value = 0\n');
        f.write('outside/b.py', 'from inside.a import value\n');
        f.commit();
        if (mode === 'sparse') {
          f.git('sparse-checkout', 'init', '--cone', '--sparse-index');
          f.git('sparse-checkout', 'set', 'inside');
        }
        f.write('inside/a.py', 'value = 1\n');
        f.git('add', 'inside/a.py');
        if (mode !== 'sparse')
          f.git('update-index', mode === 'split' ? '--split-index' : '--index-version=4');
        const before = preserve(f.repo);
        const captured = captureLocalSource({ cwd: f.repo, kind: 'index' });
        before();
        expect(captured.readFile('outside/b.py')).toMatchObject({
          text: 'from inside.a import value\n',
        });
        expect(captured.diff).toContain('+value = 1');
        if (mode === 'sparse') {
          expect(fs.existsSync(path.join(f.repo, 'outside/b.py'))).toBe(false);
          const working = captureLocalSource({ cwd: f.repo, kind: 'working-tree' });
          expect(working.readFile('outside/b.py')).toMatchObject({
            status: 'unavailable',
            detail: 'sparse-worktree',
          });
          expect(working.selected.map((entry) => entry.path)).toEqual(['inside/a.py']);
        }
      }));
  it('separates linked worktree and alternate index, including environment-driven hook use', () =>
    fixture((f) => {
      f.write('a.py', 'value = 0\n');
      f.commit();
      const linked = path.join(f.root, 'linked');
      f.git('worktree', 'add', '-b', 'linked', linked);
      fs.writeFileSync(path.join(linked, 'a.py'), 'value = 3\n');
      f.gitAt(linked, 'add', '.');
      const before = preserve(f.repo),
        linkedBefore = preserve(linked);
      expect(captureLocalSource({ cwd: linked, kind: 'index' }).readFile('a.py')).toMatchObject({
        text: 'value = 3\n',
      });
      expect(captureLocalSource({ cwd: f.repo, kind: 'index' }).selected).toEqual([]);
      const alternate = path.join(f.root, 'alternate');
      fs.copyFileSync(
        path.resolve(linked, f.gitAt(linked, 'rev-parse', '--git-path', 'index')),
        alternate,
      );
      const bytes = fs.readFileSync(alternate),
        mtime = fs.statSync(alternate).mtimeMs;
      expect(
        captureLocalSource({ cwd: linked, kind: 'index', indexFile: alternate }).readFile('a.py'),
      ).toMatchObject({ text: 'value = 3\n' });
      vi.stubEnv('GIT_INDEX_FILE', alternate);
      try {
        expect(captureLocalSource({ cwd: linked, kind: 'index' }).readFile('a.py')).toMatchObject({
          text: 'value = 3\n',
        });
      } finally {
        vi.unstubAllEnvs();
      }
      expect(fs.readFileSync(alternate)).toEqual(bytes);
      expect(fs.statSync(alternate).mtimeMs).toBe(mtime);
      before();
      linkedBefore();
    }));
  it('resolves the base ref once and compares against merge-base, not unrelated branch changes', () =>
    fixture((f) => {
      f.write('a.py', 'value = 0\n');
      f.commit();
      const base = f.git('rev-parse', 'HEAD');
      f.git('checkout', '-b', 'other');
      f.write('unrelated.py', 'other = 1');
      f.commit();
      f.git('checkout', 'main');
      f.write('a.py', 'value = 1\n');
      f.commit();
      const captured = captureLocalSource({ cwd: f.repo, kind: 'index', baseRef: 'other' });
      expect(captured.identity.baseCommit).toBe(base);
      expect(captured.selected.map((entry) => entry.path)).toEqual(['a.py']);
      f.git('branch', '-f', 'other', 'main');
      expect(captured.identity.baseCommit).toBe(base);
    }));
  it('distinguishes secret, ignored, generated, binary, invalid UTF-8, symlink, LFS and submodule sources', () =>
    fixture((f) => {
      f.write('ok.py', 'value = 1\n');
      f.commit();
      f.write('.gitignore', 'ignored.py\n');
      f.write('ignored.py', 'IGNORED_CANARY');
      f.write('.env', 'PRIVATE_CANARY');
      f.write('dist/generated.ts', 'GENERATED_CANARY');
      f.write('binary.data', Buffer.from([0, 1, 2]));
      f.write('invalid.data', Buffer.from([0xff, 0xfe]));
      f.write('large.data', 'x'.repeat(1025));
      f.write(
        'lfs.data',
        'version https://git-lfs.github.com/spec/v1\noid sha256:' +
          '1'.repeat(64) +
          '\nsize 12345\n',
      );
      fs.symlinkSync('.env', path.join(f.repo, 'link.py'));
      f.git('add', '-f', '.');
      f.git(
        'update-index',
        '--add',
        '--cacheinfo',
        '160000',
        f.git('rev-parse', 'HEAD'),
        'submodule',
      );
      const before = preserve(f.repo);
      const captured = captureLocalSource({
        cwd: f.repo,
        kind: 'index',
        limits: { fileBytes: 1024 },
      });
      before();
      for (const [file, reason, detail] of [
        ['.env', 'private-data', 'private-data'],
        ['ignored.py', 'git-ignored', 'git-ignored'],
        ['dist/generated.ts', 'generated', 'generated'],
        ['binary.data', 'binary', 'binary'],
        ['invalid.data', 'unsupported-source', 'invalid-utf8'],
        ['large.data', 'unsupported-source', 'file-size-limit'],
        ['lfs.data', 'unsupported-source', 'lfs-pointer'],
        ['link.py', 'symlink', 'unsupported-mode'],
        ['submodule', 'unsupported-source', 'submodule'],
      ])
        expect(captured.readFile(file!)).toMatchObject({ status: 'unavailable', reason, detail });
      expect(captured.diff).not.toContain('CANARY');
      expect(captured.search('CANARY').matches).toEqual([]);
      f.write('.gitignore', '');
      expect(captured.readFile('ignored.py')).toMatchObject({ reason: 'git-ignored' });
    }));
  it('does not invoke repository filters, textconv, hooks, fsmonitor, external diff or fetch', () =>
    fixture((f) => {
      f.write('a.py', 'value = 0\n');
      f.commit();
      f.write('a.py', 'value = 1\n');
      f.git('add', 'a.py');
      const witness = path.join(f.root, 'unexpected-execution');
      const command = `touch '${witness}'`;
      for (const option of [
        'core.fsmonitor',
        'diff.external',
        'diff.evil.textconv',
        'filter.evil.clean',
        'filter.evil.smudge',
      ])
        f.git('config', option, command);
      f.write('.gitattributes', '*.py filter=evil diff=evil\n');
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(path.join(f.repo, 'a.py'), later, later);
      for (const kind of ['index', 'working-tree'] as const)
        expect(captureLocalSource({ cwd: f.repo, kind }).readFile('a.py')).toMatchObject({
          text: 'value = 1\n',
        });
      expect(fs.existsSync(witness)).toBe(false);
    }));
  it('reports missing objects and refuses unmerged indexes without a working-tree fallback', () =>
    fixture((f) => {
      f.write('a.py', 'value = 0\n');
      f.commit();
      f.git('update-index', '--cacheinfo', '100644', '1'.repeat(40), 'a.py');
      const witness = path.join(f.root, 'unexpected-fetch');
      f.git('config', 'remote.partial.url', `ext::touch ${witness}`);
      f.git('config', 'remote.partial.promisor', 'true');
      f.git('config', 'protocol.ext.allow', 'always');
      const before = preserve(f.repo);
      expect(() => captureLocalSource({ cwd: f.repo, kind: 'index' })).toThrow(
        'source-unavailable',
      );
      before();
      expect(fs.existsSync(witness)).toBe(false);
      f.git('read-tree', 'HEAD');
      f.git('checkout', '-b', 'other');
      f.write('a.py', 'value = 2\n');
      f.commit();
      f.git('checkout', 'main');
      f.write('a.py', 'value = 1\n');
      f.commit();
      expect(() => f.git('merge', 'other')).toThrow();
      const unmerged = preserve(f.repo);
      expect(() => captureLocalSource({ cwd: f.repo, kind: 'index' })).toThrow(
        'source-unavailable',
      );
      unmerged();
    }));
  it('keeps empty/BOM/CRLF text hashes exact, bounds reads and excludes oversized context explicitly', () =>
    fixture((f) => {
      f.write('a.py', '\ufeffvalue = 1\r\n');
      f.write('empty.py', '');
      f.write('many.py', 'value = 1\n'.repeat(300));
      f.commit();
      const captured = captureLocalSource({
        cwd: f.repo,
        kind: 'index',
        paths: ['a.py', 'empty.py', 'many.py'],
      });
      expect(captured.readFile('a.py')).toMatchObject({
        text: '\ufeffvalue = 1\r\n',
        source: { hash: createHash('sha256').update('\ufeffvalue = 1\r\n').digest('hex') },
      });
      expect(captured.readFile('empty.py')).toMatchObject({
        source: { byteLength: 0, lineCount: 1 },
        text: '',
      });
      expect(captured.readLines('many.py', 'source', 1, 300)).toMatchObject({
        endLine: 200,
        truncated: true,
      });
      expect(captured.search('value').truncated).toBe(true);
      expect(() => captured.readFile('../escape')).toThrow('invalid-source-request');
      expect(() => captured.readLines('a.py', 'source', 0)).toThrow('invalid-source-request');
      const bounded = captureLocalSource({
        cwd: f.repo,
        kind: 'index',
        paths: ['a.py'],
        limits: { totalBytes: 80, files: 4 },
      });
      expect(bounded.selected.map((entry) => entry.path)).toEqual(['a.py']);
      expect(bounded.readFile('many.py')).toMatchObject({ detail: 'snapshot-size-limit' });
      expect(bounded.diff).not.toContain('many.py');
    }));
  it('rejects working-tree parent symlinks at the read boundary', () =>
    fixture((f) => {
      f.write('dir/a.py', 'value = 0\n');
      f.commit();
      const outside = path.join(f.root, 'outside');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'a.py'), 'OUTSIDE_CANARY');
      fs.rmSync(path.join(f.repo, 'dir'), { recursive: true });
      fs.symlinkSync(outside, path.join(f.repo, 'dir'));
      const captured = captureLocalSource({ cwd: f.repo, kind: 'working-tree' });
      expect(captured.readFile('dir/a.py')).toMatchObject({
        status: 'unavailable',
        reason: 'symlink',
      });
      expect(captured.diff).not.toContain('CANARY');
      expect(captured.selected).toEqual([]);
    }));
  it('rejects files that grow while reading without allocating the new size', () =>
    fixture((f) => {
      f.write('a.py', 'value = 1\n');
      f.commit();
      const original = fs.readSync;
      let changed = false;
      vi.mocked(readSync).mockImplementation(((
        fd: number,
        buffer: NodeJS.ArrayBufferView,
        offset: number,
        length: number,
        position: number | null,
      ) => {
        const received = original(fd, buffer, offset, length, position);
        if (!changed && buffer.byteLength === 11) {
          changed = true;
          fs.appendFileSync(path.join(f.repo, 'a.py'), 'x'.repeat(1_000_000));
        }
        return received;
      }) as typeof fs.readSync);
      expect(() =>
        captureLocalSource({ cwd: f.repo, kind: 'working-tree', limits: { fileBytes: 100 } }),
      ).toThrow('snapshot-changed');
      expect(changed).toBe(true);
    }));
  it('treats index removal as deletion unless the now-untracked file is explicitly included', () =>
    fixture((f) => {
      f.write('a.py', 'value = 1\n');
      f.commit();
      f.git('rm', '--cached', 'a.py');
      expect(captureLocalSource({ cwd: f.repo, kind: 'working-tree' }).selected).toEqual([
        { path: 'a.py', side: 'base', status: 'D' },
      ]);
      expect(
        captureLocalSource({ cwd: f.repo, kind: 'working-tree', includeUntracked: ['a.py'] })
          .selected,
      ).toEqual([]);
    }));
  for (const mutation of ['head', 'ignore', 'branch'])
    it(`refuses a ${mutation} change during capture`, () =>
      fixture((f) => {
        f.write('a.py', 'value = 0\n');
        f.commit();
        const old = f.git('rev-parse', 'HEAD');
        f.write('a.py', 'value = 1\n');
        f.commit();
        const original = SourceGit.prototype.run;
        let changed = false;
        vi.spyOn(SourceGit.prototype, 'run').mockImplementation(function (
          this: SourceGit,
          ...args: Parameters<typeof original>
        ) {
          const result = original.apply(this, args);
          if (!changed && args[0][0] === 'cat-file') {
            changed = true;
            if (mutation === 'head') f.git('update-ref', 'HEAD', old);
            else if (mutation === 'branch') {
              f.git('branch', 'same-commit');
              f.git('symbolic-ref', 'HEAD', 'refs/heads/same-commit');
            } else f.write('.gitignore', 'a.py\n');
          }
          return result;
        });
        expect(() => captureLocalSource({ cwd: f.repo, kind: 'index' })).toThrow(
          'snapshot-changed',
        );
        expect(changed).toBe(true);
      }));
  it('bounds index reads and refuses symlink/FIFO indexes without following or blocking', () =>
    fixture((f) => {
      f.write('a.py', 'value = 1\n');
      f.commit();
      const index = f.git('rev-parse', '--path-format=absolute', '--git-path', 'index');
      const outside = path.join(f.root, 'outside');
      fs.writeFileSync(outside, 'SYNTHETIC_PRIVATE_CANARY');
      fs.rmSync(index);
      fs.symlinkSync(outside, index);
      expect(() => captureLocalSource({ cwd: f.repo, kind: 'index' })).toThrow(
        'source-unavailable',
      );
      fs.rmSync(index);
      execFileSync('mkfifo', [index]);
      expect(() => captureLocalSource({ cwd: f.repo, kind: 'index' })).toThrow('capture-limit');
      fs.rmSync(index);
      fs.writeFileSync(index, '');
      fs.truncateSync(index, 64 * 1024 * 1024 + 1);
      expect(() => captureLocalSource({ cwd: f.repo, kind: 'index' })).toThrow('capture-limit');
      expect(fs.readFileSync(outside, 'utf8')).toBe('SYNTHETIC_PRIVATE_CANARY');
    }));
  it('validates deny patterns and protects private defaults from user overrides', () => {
    const deny = sourcePathPolicy(['src/**/skip?.py', '*.generated.ts', '/top/', 'vendor-custom/']);
    for (const file of [
      'src/skip1.py',
      'src/deep/skip2.py',
      'nested/a.generated.ts',
      'top/a.py',
      'any/vendor-custom/a.py',
    ])
      expect(deny(file)).toBe('user-excluded');
    expect(deny('nested/top/a.py')).toBeUndefined();
    expect(deny('src/keep.py')).toBeUndefined();
    expect(deny('nested/.codex-work/auth.json')).toBe('private-data');
    for (const pattern of ['!secret.py', 'a[0].py', '../a', 'a/**bad', ''])
      expect(() => sourcePathPolicy([pattern])).toThrow('invalid-source-request');
  });
});
