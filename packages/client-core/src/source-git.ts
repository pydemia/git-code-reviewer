// Safe Git flags/environment are adapted from GCR git-engine workspace/local-tools.
// Temporary-index capture is adapted from Commit Defender gitSnapshot.ts (Apache-2.0).
// All generated objects and index writes go to this capture's private temporary directory.
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SourceCaptureError } from './source-policy.js';
import { contentHash } from './local-identity.js';

export interface GitEntry {
  mode: string;
  oid: string;
  size: number | null;
  type: string;
}
export type GitTree = Map<string, GitEntry>;
export class SourceGit {
  readonly directory = mkdtempSync(path.join(tmpdir(), 'gcr-source-'));
  readonly root: string;
  readonly index: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly initialHead: string | null;
  readonly initialBranch: string | null;
  readonly repository: { repositoryKey: string; worktreeKey: string };
  private readonly environment: NodeJS.ProcessEnv;
  constructor(
    cwd: string,
    private readonly deadline: number,
    indexFile = process.env.GIT_INDEX_FILE,
  ) {
    this.root = cwd;
    this.index = path.join(this.directory, 'index');
    this.environment = {
      PATH: process.env.PATH,
      LC_ALL: 'C',
      HOME: this.directory,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_LFS_SKIP_SMUDGE: '1',
      GIT_ALLOW_PROTOCOL: '',
      ...(indexFile ? { GIT_INDEX_FILE: path.resolve(cwd, indexFile) } : {}),
    };
    try {
      this.root = realpathSync(
        this.text(['rev-parse', '--path-format=absolute', '--show-toplevel']).trim(),
      );
      const format = this.text(['rev-parse', '--show-object-format']).trim();
      if (format !== 'sha1' && format !== 'sha256')
        throw new SourceCaptureError('source-unavailable');
      this.objectFormat = format;
      const common = realpathSync(
        this.text(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(),
      );
      const directory = realpathSync(
        this.text(['rev-parse', '--path-format=absolute', '--git-dir']).trim(),
      );
      this.repository = {
        repositoryKey: contentHash({ version: 1, commonDirectory: common }),
        worktreeKey: contentHash({
          version: 1,
          commonDirectory: common,
          gitDirectory: directory,
          root: this.root,
        }),
      };
      this.initialHead = this.head();
      this.initialBranch = this.branch();
      const originalIndex = this.text([
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'index',
      ]).trim();
      const objects = realpathSync(
        this.text(['rev-parse', '--path-format=absolute', '--git-path', 'objects']).trim(),
      );
      const objectDirectory = path.join(this.directory, 'objects');
      mkdirSync(objectDirectory, { mode: 0o700 });
      mkdirSync(path.join(this.directory, 'empty-worktree'), { mode: 0o700 });
      this.environment.GIT_OBJECT_DIRECTORY = objectDirectory;
      this.environment.GIT_ALTERNATE_OBJECT_DIRECTORIES = JSON.stringify(objects);
      this.environment.GIT_INDEX_FILE = this.index;
      try {
        const fd = openSync(
          originalIndex,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const before = fstatSync(fd);
          if (!before.isFile() || before.size > 64 * 1024 * 1024)
            throw new SourceCaptureError('capture-limit');
          const buffer = Buffer.alloc(before.size + 1);
          let length = 0;
          while (length < buffer.length) {
            const received = readSync(fd, buffer, length, buffer.length - length, null);
            if (!received) break;
            length += received;
          }
          const after = fstatSync(fd);
          if (
            length !== before.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs
          )
            throw new SourceCaptureError('snapshot-changed');
          writeFileSync(this.index, buffer.subarray(0, length), { mode: 0o600 });
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.text(['read-tree', '--empty']);
      }
    } catch (error) {
      this.close();
      if (error instanceof SourceCaptureError) throw error;
      throw new SourceCaptureError('source-unavailable');
    }
  }
  run(
    args: string[],
    input?: string | Buffer,
    maxBuffer = 8 * 1024 * 1024,
    accepted = [0],
  ): Buffer {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new SourceCaptureError('capture-limit');
    try {
      return execFileSync(
        'git',
        [
          '--no-replace-objects',
          ...(args[0] === 'check-ignore' ? [] : ['--literal-pathspecs']),
          '-C',
          this.root,
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'protocol.allow=never',
          '-c',
          'submodule.recurse=false',
          '-c',
          'core.attributesFile=/dev/null',
          '-c',
          'core.autocrlf=false',
          '-c',
          'diff.external=',
          '-c',
          'diff.autoRefreshIndex=false',
          '-c',
          'maintenance.auto=false',
          ...args,
        ],
        {
          // Even tree-only commands can refresh/smudge a racy index and invoke
          // a clean filter. Index writes/diffs see an empty worktree, never source.
          env: ['read-tree', 'write-tree', 'update-index', 'diff'].includes(args[0] ?? '')
            ? { ...this.environment, GIT_WORK_TREE: path.join(this.directory, 'empty-worktree') }
            : this.environment,
          input,
          maxBuffer,
          timeout: Math.min(remaining, 10_000),
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    } catch (error) {
      const failure = error as { status?: number; stdout?: Buffer };
      if (accepted.includes(failure.status ?? -1)) return failure.stdout ?? Buffer.alloc(0);
      // Do not attach stderr/cause: repository configuration can contain credentials.
      throw new SourceCaptureError('source-unavailable');
    }
  }
  text(args: string[], input?: string | Buffer, maxBuffer?: number, accepted?: number[]): string {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(
        this.run(args, input, maxBuffer, accepted),
      );
    } catch (error) {
      if (error instanceof SourceCaptureError) throw error;
      throw new SourceCaptureError('source-unavailable');
    }
  }
  oid(value: string): string {
    if (!(this.objectFormat === 'sha1' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/).test(value))
      throw new SourceCaptureError('source-unavailable');
    return value;
  }
  head(): string | null {
    const value = this.text(
      ['rev-parse', '--verify', '--quiet', 'HEAD'],
      undefined,
      undefined,
      [0, 1],
    ).trim();
    if (value)
      return this.oid(this.text(['rev-parse', '--verify', `${this.oid(value)}^{commit}`]).trim());
    this.text(['symbolic-ref', '--quiet', 'HEAD']);
    return null;
  }
  branch(): string | null {
    const value = this.text(
      ['symbolic-ref', '--quiet', 'HEAD'],
      undefined,
      undefined,
      [0, 1],
    ).trim();
    if (!value) return null;
    if (!value.startsWith('refs/heads/')) throw new SourceCaptureError('source-unavailable');
    return value.slice('refs/heads/'.length);
  }
  tree(oid: string, maxEntries: number): GitTree {
    const tree: GitTree = new Map();
    for (const record of this.text(['ls-tree', '-r', '-z', '--long', this.oid(oid)])
      .split('\0')
      .filter(Boolean)) {
      const tab = record.indexOf('\t');
      const match = /^(\d{6}) (blob|commit) ([a-f0-9]+) +([0-9]+|-)\s*$/.exec(record.slice(0, tab));
      if (tab < 0 || !match || tree.has(record.slice(tab + 1)))
        throw new SourceCaptureError('source-unavailable');
      const size = match[4] === '-' ? null : Number(match[4]);
      if (size !== null && !Number.isSafeInteger(size))
        throw new SourceCaptureError('source-unavailable');
      tree.set(record.slice(tab + 1), {
        mode: match[1]!,
        type: match[2]!,
        oid: this.oid(match[3]!),
        size,
      });
      if (tree.size > maxEntries) throw new SourceCaptureError('capture-limit');
    }
    return tree;
  }
  /** Literal exact entries prevent file-to-directory pathspecs from exposing excluded children. */
  selectedTree(entries: GitTree): string {
    this.text(['read-tree', '--empty']);
    if (entries.size)
      this.text(
        ['update-index', '-z', '--index-info'],
        [...entries].map(([file, entry]) => `${entry.mode} ${entry.oid}\t${file}\0`).join(''),
      );
    return this.oid(this.text(['write-tree']).trim());
  }
  close(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}
