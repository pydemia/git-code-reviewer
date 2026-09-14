import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  snapshotIdentity,
  sourceFile,
  sourcePath,
  sourceExclusionReason,
  type SnapshotIdentity,
  type SourceFile,
} from '@gcr/client-contract';
import { canonicalJson, contentHash } from './local-identity.js';
import {
  SourceCaptureError,
  sourcePathPolicy,
  type SourceExclusionReason,
} from './source-policy.js';
import { SourceGit, type GitEntry, type GitTree } from './source-git.js';

import {
  fixedSourceLines,
  type ReviewSourceView,
  type FixedSourceRead,
  type SourceChange,
  type SourceLimitation,
} from './review-source.js';
export type { FixedSourceRead, SourceChange, SourceLimitation } from './review-source.js';

type Side = 'base' | 'source';
interface CapturedFile {
  source: SourceFile;
  text: string;
  mode: string;
}
export interface FrozenLocalSource {
  formatVersion: 1;
  identity: SnapshotIdentity;
  repository: { repositoryKey: string; worktreeKey: string };
  headCommit: string | null;
  branchName: string | null;
  sourceTree: string;
  excludePatterns: string[];
  files: CapturedFile[];
  selected: SourceChange[];
  limitations: SourceLimitation[];
  diff: string;
}
export interface CaptureSourceOptions {
  cwd: string;
  kind: 'index' | 'working-tree' | 'commit-tree';
  /** Resolve this ref once, then use its merge-base with the captured HEAD. */
  baseRef?: string;
  /** Exact commit OIDs. Commit-tree capture requires both; null means an empty base. */
  sourceCommit?: string;
  baseCommit?: string | null;
  /** Explicit destination branch for committed-source policy; never inferred from checkout. */
  targetBranch?: string;
  /** Exact review paths; omitted means changes against base. No directory expansion. */
  paths?: readonly string[];
  /** Only these untracked files may enter a working-tree source view. */
  includeUntracked?: readonly string[];
  excludePatterns?: readonly string[];
  indexFile?: string;
  limits?: {
    fileBytes?: number;
    totalBytes?: number;
    files?: number;
    entries?: number;
    durationMs?: number;
  };
}
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const blobId = (bytes: Buffer, format: 'sha1' | 'sha256'): string =>
  createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const key = (side: Side, file: string): string => `${side}:${file}`;
const limit = (value: number | undefined, fallback: number, maximum: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new SourceCaptureError('invalid-source-request');
  return value;
};
function paths(values: readonly string[] = []): string[] {
  if (!Array.isArray(values) || values.length > 10_000)
    throw new SourceCaptureError('invalid-source-request');
  return [
    ...new Set(
      Array.from(values, (file) => {
        try {
          return sourcePath(file);
        } catch {
          throw new SourceCaptureError('invalid-source-request');
        }
      }),
    ),
  ].sort();
}

/** No Git command or original filesystem path is retained after capture returns. */
class LocalSourceSnapshot implements ReviewSourceView {
  #files: Map<string, CapturedFile>;
  #closed = false;
  #identity: SnapshotIdentity;
  #selected: SourceChange[];
  #limitations: SourceLimitation[];
  #diff: string;
  #headCommit: string | null;
  #branchName: string | null;
  #repository: { repositoryKey: string; worktreeKey: string };
  constructor(
    identity: SnapshotIdentity,
    repository: { repositoryKey: string; worktreeKey: string },
    headCommit: string | null,
    branchName: string | null,
    files: Map<string, CapturedFile>,
    selected: SourceChange[],
    limitations: SourceLimitation[],
    diff: string,
    private readonly captureTree: string,
    private readonly excludePatterns: string[],
  ) {
    this.#identity = snapshotIdentity(identity);
    this.#repository = { ...repository };
    this.#headCommit = headCommit;
    this.#branchName = branchName;
    this.#files = new Map([...files].map(([id, file]) => [id, structuredClone(file)]));
    this.#selected = structuredClone(selected);
    this.#limitations = structuredClone(limitations);
    this.#diff = diff;
  }
  private open(): void {
    if (this.#closed) throw new SourceCaptureError('snapshot-closed');
  }
  get identity(): SnapshotIdentity {
    this.open();
    return structuredClone(this.#identity);
  }
  get headCommit(): string | null {
    this.open();
    return this.#headCommit;
  }
  get repository(): { repositoryKey: string; worktreeKey: string } {
    this.open();
    return { ...this.#repository };
  }
  get branchName(): string | null {
    this.open();
    return this.#branchName;
  }
  get selected(): SourceChange[] {
    this.open();
    return structuredClone(this.#selected);
  }
  get sourceFiles(): SourceFile[] {
    this.open();
    return [...this.#files.values()].map((file) => structuredClone(file.source));
  }
  get limitations(): SourceLimitation[] {
    this.open();
    return structuredClone(this.#limitations);
  }
  get incomplete(): boolean {
    this.open();
    return this.#limitations.some((item) =>
      ['unreadable', 'unsupported-source'].includes(item.reason),
    );
  }
  get diff(): string {
    this.open();
    return this.#diff;
  }
  freeze(): FrozenLocalSource {
    this.open();
    const value: FrozenLocalSource = {
      formatVersion: 1,
      identity: this.identity,
      repository: this.repository,
      headCommit: this.headCommit,
      branchName: this.branchName,
      sourceTree: this.captureTree,
      excludePatterns: [...this.excludePatterns],
      files: [...this.#files.values()].map((file) => structuredClone(file)),
      selected: this.selected,
      limitations: this.limitations,
      diff: this.diff,
    };
    canonicalJson(value, 8 * 1024 * 1024);
    return value;
  }
  readFile(file: string, side: Side = 'source'): FixedSourceRead {
    this.open();
    paths([file]);
    if (side !== 'base' && side !== 'source')
      throw new SourceCaptureError('invalid-source-request');
    const found = this.#files.get(key(side, file));
    if (found)
      return { status: 'available', source: structuredClone(found.source), text: found.text };
    const limitation = this.#limitations.find((item) => item.path === file && item.side === side);
    if (limitation)
      return { status: 'unavailable', reason: limitation.reason, detail: limitation.detail };
    // A path excluded by the built-in policy is never described as an authorized missing file.
    const reason = sourcePathPolicy()(file);
    return reason ? { status: 'unavailable', reason, detail: reason } : { status: 'absent' };
  }
  readLines(file: string, side: Side = 'source', startLine = 1, endLine = startLine + 159) {
    return fixedSourceLines(this.readFile(file, side), startLine, endLine);
  }
  /** Literal text candidates, not a semantic call graph or proof that a defect exists. */
  search(query: string, side: Side = 'source', prefix = '') {
    this.open();
    if (
      typeof query !== 'string' ||
      !query ||
      query.length > 300 ||
      (side !== 'source' && side !== 'base')
    )
      throw new SourceCaptureError('invalid-source-request');
    if (prefix) paths([prefix]);
    const matches: Array<{
      source: SourceFile;
      line: number;
      text: string;
      textTruncated: boolean;
    }> = [];
    let truncated = false;
    for (const file of this.#files.values()) {
      if (
        file.source.side !== side ||
        (prefix && file.source.path !== prefix && !file.source.path.startsWith(`${prefix}/`))
      )
        continue;
      for (const [index, line] of file.text.split('\n').entries())
        if (line.includes(query)) {
          if (matches.length === 100) {
            truncated = true;
            break;
          }
          matches.push({
            source: structuredClone(file.source),
            line: index + 1,
            text: line.slice(0, 300),
            textTruncated: line.length > 300,
          });
        }
      if (truncated) break;
    }
    return {
      matches,
      truncated,
      omitted: this.#limitations.filter((item) => item.side === side).length,
      method: 'literal-text' as const,
      verifiedCallGraph: false as const,
    };
  }
  close(): void {
    this.#files.clear();
    this.#diff = '';
    this.#closed = true;
  }
}
export type { LocalSourceSnapshot };

/** Restore owned, encrypted source bytes without consulting Git or the checkout. */
export function restoreLocalSource(input: unknown): LocalSourceSnapshot {
  const value = JSON.parse(canonicalJson(input, 8 * 1024 * 1024)) as FrozenLocalSource;
  const invalid = () => {
    throw new SourceCaptureError('invalid-source-request');
  };
  if (
    !value ||
    value.formatVersion !== 1 ||
    !value.repository ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.selected) ||
    !Array.isArray(value.limitations) ||
    !Array.isArray(value.excludePatterns) ||
    typeof value.diff !== 'string'
  )
    invalid();
  const identity = snapshotIdentity(value.identity);
  const oid = identity.objectFormat === 'sha1' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
  if (
    !oid.test(value.sourceTree) ||
    !(value.headCommit === null || oid.test(value.headCommit)) ||
    !(
      value.branchName === null ||
      (typeof value.branchName === 'string' && value.branchName.length <= 1024)
    ) ||
    !/^[a-f0-9]{64}$/.test(value.repository.repositoryKey) ||
    !/^[a-f0-9]{64}$/.test(value.repository.worktreeKey) ||
    value.files.length > 20000 ||
    value.selected.length > 10000 ||
    value.limitations.length > 100000
  )
    invalid();
  if (
    ('sourceTree' in identity && identity.sourceTree !== value.sourceTree) ||
    (identity.kind === 'commit-tree' && identity.sourceCommit !== value.headCommit)
  )
    invalid();
  const policy = sourcePathPolicy(value.excludePatterns),
    files = new Map<string, CapturedFile>();
  for (const file of value.files) {
    const metadata = sourceFile(file.source);
    if (
      typeof file.text !== 'string' ||
      !['100644', '100755'].includes(file.mode) ||
      policy(metadata.path) ||
      files.has(key(metadata.side, metadata.path))
    )
      invalid();
    const bytes = Buffer.from(file.text, 'utf8');
    if (
      bytes.length !== metadata.byteLength ||
      file.text.split('\n').length !== metadata.lineCount ||
      hash(bytes) !== metadata.hash ||
      (metadata.gitBlob && blobId(bytes, identity.objectFormat) !== metadata.gitBlob)
    )
      invalid();
    files.set(key(metadata.side, metadata.path), {
      source: metadata,
      text: file.text,
      mode: file.mode,
    });
  }
  const selected = new Set<string>();
  for (const change of value.selected) {
    sourcePath(change.path);
    if (change.oldPath !== undefined) sourcePath(change.oldPath);
    if (
      !['A', 'M', 'D', 'R', 'T'].includes(change.status) ||
      !['source', 'base'].includes(change.side) ||
      change.side !== (change.status === 'D' ? 'base' : 'source') ||
      selected.has(change.path) ||
      !files.has(key(change.side, change.path))
    )
      invalid();
    selected.add(change.path);
  }
  for (const item of value.limitations) {
    sourcePath(item.path);
    sourceExclusionReason(item.reason);
    if (
      !['base', 'source'].includes(item.side) ||
      typeof item.detail !== 'string' ||
      item.detail.length > 1024 ||
      files.has(key(item.side, item.path))
    )
      invalid();
  }
  const expected = contentHash({
    version: 1,
    kind: identity.kind,
    headCommit: value.headCommit,
    baseCommit: identity.baseCommit,
    baseTree: identity.baseTree,
    sourceTree: value.sourceTree,
    ...(identity.kind === 'commit-tree' ? { targetBranch: value.branchName } : {}),
    sourceFiles: value.files.map((file) => ({ ...file.source, mode: file.mode })),
    selected: value.selected,
    limitations: value.limitations,
    policy: value.excludePatterns,
    diffHash: hash(value.diff),
  });
  if (expected !== identity.hash) invalid();
  return new LocalSourceSnapshot(
    identity,
    value.repository,
    value.headCommit,
    value.branchName,
    files,
    value.selected,
    value.limitations,
    value.diff,
    value.sourceTree,
    [...value.excludePatterns],
  );
}

/** Synchronous bounded capture; extension hosts should run it outside their UI event loop. */
export function captureLocalSource(input: CaptureSourceOptions): LocalSourceSnapshot {
  const options = structuredClone(input);
  if (!['index', 'working-tree', 'commit-tree'].includes(options.kind))
    throw new SourceCaptureError('invalid-source-request');
  const committed = options.kind === 'commit-tree';
  const validOid = (value: unknown) =>
    typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
  if (
    committed
      ? !validOid(options.sourceCommit) ||
        !(options.baseCommit === null || validOid(options.baseCommit)) ||
        options.baseRef !== undefined ||
        options.indexFile !== undefined
      : options.sourceCommit !== undefined ||
        options.baseCommit !== undefined ||
        options.targetBranch !== undefined
  )
    throw new SourceCaptureError('invalid-source-request');
  const selectedPaths = options.paths === undefined ? undefined : paths(options.paths);
  const untracked = paths(options.includeUntracked);
  if (options.kind !== 'working-tree' && untracked.length)
    throw new SourceCaptureError('invalid-source-request');
  const policy = sourcePathPolicy(options.excludePatterns);
  const fileLimit = limit(options.limits?.fileBytes, 1_048_576, 4_194_304);
  const byteLimit = limit(options.limits?.totalBytes, 33_554_432, 134_217_728);
  const fileCount = limit(options.limits?.files, 10_000, 10_000);
  const entryLimit = limit(options.limits?.entries, 50_000, 50_000);
  const deadline = Date.now() + limit(options.limits?.durationMs, 30_000, 120_000);
  if (options.baseRef !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/.test(options.baseRef))
    throw new SourceCaptureError('invalid-source-request');
  const git = new SourceGit(options.cwd, deadline, committed ? null : options.indexFile);
  try {
    const exactCommit = (oid: string) => {
      const exact = git.oid(oid);
      if (git.text(['cat-file', '-t', exact]).trim() !== 'commit')
        throw new SourceCaptureError('source-unavailable');
      return exact;
    };
    const headCommit = committed ? exactCommit(options.sourceCommit!) : git.initialHead;
    let baseCommit = committed
      ? options.baseCommit === null
        ? null
        : exactCommit(options.baseCommit!)
      : headCommit;
    if (options.targetBranch !== undefined) {
      if (!options.targetBranch || options.targetBranch.length > 1024)
        throw new SourceCaptureError('invalid-source-request');
      git.text(['check-ref-format', `refs/heads/${options.targetBranch}`]);
    }
    if (options.baseRef) {
      if (!headCommit) throw new SourceCaptureError('source-unavailable');
      const ref = git.oid(
        git
          .text(['rev-parse', '--verify', '--end-of-options', `${options.baseRef}^{commit}`])
          .trim(),
      );
      baseCommit = git.oid(git.text(['merge-base', headCommit, ref]).trim());
    }
    const baseTree = git.oid(
      git
        .text(
          baseCommit
            ? ['rev-parse', '--verify', `${baseCommit}^{tree}`]
            : ['hash-object', '-w', '-t', 'tree', '--stdin'],
          '',
        )
        .trim(),
    );
    const sourceTree = git.oid(
      git
        .text(committed ? ['rev-parse', '--verify', `${headCommit}^{tree}`] : ['write-tree'])
        .trim(),
    );
    const base = git.tree(baseTree, entryLimit);
    const source = git.tree(sourceTree, entryLimit);
    const skipWorktree = new Set(
      git
        .text(['ls-files', '-t', '-z'])
        .split('\0')
        .filter((entry) => entry.startsWith('S '))
        .map((entry) => entry.slice(2)),
    );
    const allPaths = [
      ...new Set([...base.keys(), ...source.keys(), ...untracked, ...(selectedPaths ?? [])]),
    ].sort();
    if (allPaths.length > entryLimit) throw new SourceCaptureError('capture-limit');
    const limitations: SourceLimitation[] = [];
    const denied = new Set<string>();
    const exclude = (
      file: string,
      side: Side,
      reason: SourceExclusionReason,
      detail = reason as string,
    ) => {
      if (denied.has(key(side, file))) return;
      denied.add(key(side, file));
      limitations.push({ path: file, side, reason, detail });
    };
    const eligible = allPaths.filter((file) => {
      if (Date.now() > deadline) throw new SourceCaptureError('capture-limit');
      const reason = policy(file);
      if (!reason) return true;
      for (const side of ['base', 'source'] as const) exclude(file, side, reason);
      return false;
    });
    // check-ignore refuses paths below a working-tree symlink. Record that policy
    // limitation before invoking it; never traverse the link to discover ignore files.
    const ignoreInputs = eligible.filter((file) => {
      const parts = file.split('/');
      for (let index = 1; index < parts.length; index++) {
        try {
          const stat = lstatSync(path.join(git.root, ...parts.slice(0, index)));
          if (stat.isSymbolicLink()) {
            for (const side of ['base', 'source'] as const)
              exclude(file, side, 'symlink', 'ignore-path-symlink');
            return false;
          }
          if (!stat.isDirectory()) break;
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            for (const side of ['base', 'source'] as const)
              exclude(file, side, 'unreadable', 'ignore-policy-unavailable');
            return false;
          }
          break;
        }
      }
      return true;
    });
    let frozenIgnore = '';
    const checkIgnore = () =>
      ignoreInputs.length
        ? git.text(
            ['check-ignore', '--no-index', '-z', '--stdin'],
            ignoreInputs.map((file) => `./${file}\0`).join(''),
            undefined,
            [0, 1],
          )
        : '';
    if (ignoreInputs.length) {
      // Freeze repository .gitignore/.git/info/exclude decisions once. Global Git
      // config is intentionally disabled; explicit user patterns are separate.
      const ignored = checkIgnore();
      frozenIgnore = ignored;
      for (const file of ignored
        .split('\0')
        .filter(Boolean)
        .map((file) => file.replace(/^\.\//, '')))
        for (const side of ['base', 'source'] as const) exclude(file, side, 'git-ignored');
    }
    if (committed) {
      // Either side may contain a privacy rule absent from the current checkout.
      for (const file of new Set([
        ...git.ignoredInTree(base, eligible),
        ...git.ignoredInTree(source, eligible),
      ]))
        for (const side of ['base', 'source'] as const) exclude(file, side, 'git-ignored');
    }
    const files = new Map<string, CapturedFile>();
    const known = { base: new Set(base.keys()), source: new Set(source.keys()) };
    if (options.kind === 'working-tree') for (const file of untracked) known.source.add(file);
    let bytes = 0,
      count = 0;
    const admit = (file: string, side: Side, size: number): boolean => {
      if (size > fileLimit) {
        exclude(file, side, 'unsupported-source', 'file-size-limit');
        return false;
      }
      if (bytes + size > byteLimit || count >= fileCount) {
        exclude(file, side, 'unsupported-source', 'snapshot-size-limit');
        return false;
      }
      bytes += size;
      count++;
      return true;
    };
    const add = (file: string, side: Side, body: Buffer, entry: GitEntry) => {
      if (body.includes(0)) {
        exclude(file, side, 'binary');
        return;
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
      } catch {
        exclude(file, side, 'unsupported-source', 'invalid-utf8');
        return;
      }
      if (/^version https:\/\/git-lfs.github.com\/spec\/v1(?:\r?\n|$)/.test(text)) {
        exclude(file, side, 'unsupported-source', 'lfs-pointer');
        return;
      }
      if (blobId(body, git.objectFormat) !== entry.oid)
        throw new SourceCaptureError('source-unavailable');
      files.set(key(side, file), {
        source: sourceFile({
          path: file,
          side,
          hash: hash(body),
          byteLength: body.length,
          lineCount: text.split('\n').length,
          gitBlob: entry.oid,
        }),
        text,
        mode: entry.mode,
      });
    };
    const candidates: Array<{ file: string; side: Side; entry: GitEntry }> = [];
    const workingWrites: Array<{ file: string; body: Buffer; entry: GitEntry }> = [];
    const observations: Array<{ file: string; signature: string }> = [];
    const signature = (stat: ReturnType<typeof fstatSync>) =>
      `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`;
    const ordered = selectedPaths
      ? [...selectedPaths, ...eligible.filter((file) => !selectedPaths.includes(file))]
      : eligible;
    for (const file of ordered) {
      if (Date.now() > deadline) throw new SourceCaptureError('capture-limit');
      for (const side of ['source', 'base'] as const) {
        if (denied.has(key(side, file))) continue;
        const tree = side === 'base' ? base : source;
        const entry = tree.get(file);
        if (
          entry &&
          (side === 'base' || options.kind !== 'working-tree' || entry.mode === '160000') &&
          (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))
        ) {
          exclude(
            file,
            side,
            entry.mode === '120000' ? 'symlink' : 'unsupported-source',
            entry.mode === '160000' ? 'submodule' : 'unsupported-mode',
          );
          continue;
        }
        if (side === 'source' && options.kind === 'working-tree' && known.source.has(file)) {
          let fd: number | undefined;
          try {
            const parts = file.split('/');
            for (let index = 1; index <= parts.length; index++) {
              const stat = lstatSync(path.join(git.root, ...parts.slice(0, index)));
              if (stat.isSymbolicLink()) {
                exclude(file, side, 'symlink');
                break;
              }
              if (index < parts.length ? !stat.isDirectory() : !stat.isFile()) {
                exclude(file, side, 'not-file');
                break;
              }
            }
            if (denied.has(key(side, file))) continue;
            const absolute = path.join(git.root, file);
            fd = openSync(
              absolute,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            const opened = fstatSync(fd);
            if (
              !opened.isFile() ||
              realpathSync(absolute) !== absolute ||
              signature(lstatSync(absolute)) !== signature(opened)
            )
              throw new SourceCaptureError('snapshot-changed');
            if (!admit(file, side, opened.size)) continue;
            // Bound allocation and reads even if another process grows this regular file.
            const buffer = Buffer.alloc(opened.size + 1);
            let length = 0;
            while (length < buffer.length) {
              const received = readSync(fd, buffer, length, buffer.length - length, null);
              if (!received) break;
              length += received;
            }
            const body = buffer.subarray(0, length);
            if (body.length !== opened.size || signature(fstatSync(fd)) !== signature(opened))
              throw new SourceCaptureError('snapshot-changed');
            observations.push({ file, signature: signature(opened) });
            const captured = {
              mode: opened.mode & 0o111 ? '100755' : '100644',
              type: 'blob',
              size: body.length,
              oid: blobId(body, git.objectFormat),
            };
            add(file, side, body, captured);
            if (files.has(key(side, file))) workingWrites.push({ file, body, entry: captured });
          } catch (error) {
            if (error instanceof SourceCaptureError) throw error;
            if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
              if (skipWorktree.has(file))
                exclude(file, side, 'unsupported-source', 'sparse-worktree');
              else if (untracked.includes(file))
                exclude(file, side, 'unreadable', 'requested-file-missing');
              else known.source.delete(file);
            } else exclude(file, side, 'unreadable');
          } finally {
            if (fd !== undefined) closeSync(fd);
          }
        } else if (entry) {
          if (entry.size === null) exclude(file, side, 'unsupported-source', 'missing-object');
          else if (admit(file, side, entry.size)) candidates.push({ file, side, entry });
        }
      }
    }
    if (candidates.length) {
      const output = git.run(
        ['cat-file', '--batch'],
        candidates.map(({ entry }) => `${entry.oid}\n`).join(''),
        byteLimit + candidates.length * 160,
      );
      let offset = 0;
      for (const { file, side, entry } of candidates) {
        const newline = output.indexOf(10, offset);
        if (newline < 0) throw new SourceCaptureError('source-unavailable');
        const header = output.subarray(offset, newline).toString('ascii');
        offset = newline + 1;
        if (header === `${entry.oid} missing`) {
          exclude(file, side, 'unsupported-source', 'missing-object');
          continue;
        }
        if (header !== `${entry.oid} blob ${entry.size}`)
          throw new SourceCaptureError('source-unavailable');
        const body = output.subarray(offset, offset + entry.size!);
        offset += entry.size!;
        if (body.length !== entry.size || output[offset++] !== 10)
          throw new SourceCaptureError('source-unavailable');
        add(file, side, body, entry);
      }
      if (offset !== output.length) throw new SourceCaptureError('source-unavailable');
    }
    for (const observation of observations) {
      try {
        const absolute = path.join(git.root, observation.file);
        if (
          realpathSync(absolute) !== absolute ||
          signature(lstatSync(absolute)) !== observation.signature
        )
          throw new SourceCaptureError('snapshot-changed');
      } catch {
        throw new SourceCaptureError('snapshot-changed');
      }
    }
    if (
      (!committed && (git.head() !== headCommit || git.branch() !== git.initialBranch)) ||
      checkIgnore() !== frozenIgnore
    )
      throw new SourceCaptureError('snapshot-changed');
    if (workingWrites.length) {
      const names = workingWrites.map(({ body }, index) => {
        const name = path.join(git.directory, `blob-${index}`);
        writeFileSync(name, body, { mode: 0o600 });
        return JSON.stringify(name);
      });
      const oids = git
        .text(['hash-object', '-w', '--no-filters', '--stdin-paths'], `${names.join('\n')}\n`)
        .trim()
        .split('\n');
      if (
        oids.length !== workingWrites.length ||
        oids.some((oid, index) => oid !== workingWrites[index]!.entry.oid)
      )
        throw new SourceCaptureError('source-unavailable');
    }
    // A missing/excluded opposite side must not become a fabricated addition/deletion.
    const comparable = new Set(
      eligible.filter((file) =>
        (['base', 'source'] as const).every(
          (side) =>
            !denied.has(key(side, file)) && (!known[side].has(file) || files.has(key(side, file))),
        ),
      ),
    );
    const filtered = (side: Side): GitTree =>
      new Map(
        [...files.values()]
          .filter((file) => file.source.side === side && comparable.has(file.source.path))
          .map((file) => [
            file.source.path,
            {
              mode: file.mode,
              type: 'blob',
              oid: file.source.gitBlob!,
              size: file.source.byteLength,
            },
          ]),
      );
    const left = git.selectedTree(filtered('base'));
    const right = git.selectedTree(filtered('source'));
    const records = git
      .text([
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--name-status',
        '-z',
        '-M',
        left,
        right,
      ])
      .split('\0');
    const changes: SourceChange[] = [];
    for (let index = 0; records[index];) {
      const status = records[index++]!;
      const first = records[index++]!;
      const oldPath = status.startsWith('R') ? first : undefined;
      const file = oldPath ? records[index++]! : first;
      if (
        !comparable.has(file) ||
        (oldPath && !comparable.has(oldPath)) ||
        !/^(?:[AMDT]|R\d+)$/.test(status)
      )
        throw new SourceCaptureError('source-unavailable');
      changes.push({
        path: file,
        ...(oldPath ? { oldPath } : {}),
        status: status[0] as SourceChange['status'],
        side: status === 'D' ? 'base' : 'source',
      });
    }
    const selected =
      selectedPaths === undefined
        ? changes
        : selectedPaths.flatMap((file) => {
            if (!comparable.has(file)) return [];
            const change = changes.find((change) => change.path === file);
            if (change) return [change];
            return files.has(key('source', file))
              ? [{ path: file, status: 'M' as const, side: 'source' as const }]
              : [];
          });
    for (const file of selectedPaths ?? [])
      if (
        !selected.some((entry) => entry.path === file) &&
        !limitations.some((item) => item.path === file)
      )
        exclude(file, 'source', 'unreadable', 'requested-file-not-captured');
    // Prune exact trees again for selected paths before producing a patch.
    const patchPaths = new Set(
      selected.flatMap((change) => [change.path, ...(change.oldPath ? [change.oldPath] : [])]),
    );
    const patchTree = (side: Side) =>
      git.selectedTree(new Map([...filtered(side)].filter(([file]) => patchPaths.has(file))));
    const diff = selected.length
      ? git.text(
          [
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-color',
            '-M',
            patchTree('base'),
            patchTree('source'),
          ],
          undefined,
          byteLimit * 2 + 1_048_576,
        )
      : '';
    // Capture selected paths first to preserve their byte/file budget priority.
    // Once capture is complete, identity and serialization use canonical order:
    // an explicit selection and all-changes capture of the same input must join.
    const canonicalFiles = new Map(
      [...files.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
    const identity = snapshotIdentity({
      kind: options.kind,
      objectFormat: git.objectFormat,
      baseCommit,
      baseTree,
      ...(options.kind !== 'working-tree' ? { sourceTree } : {}),
      ...(committed ? { sourceCommit: headCommit } : {}),
      hash: contentHash({
        version: 1,
        kind: options.kind,
        headCommit,
        baseCommit,
        baseTree,
        sourceTree,
        ...(committed ? { targetBranch: options.targetBranch ?? null } : {}),
        sourceFiles: [...canonicalFiles.values()].map((file) => ({
          ...file.source,
          mode: file.mode,
        })),
        selected,
        limitations,
        policy: options.excludePatterns ?? [],
        diffHash: hash(diff),
      }),
    });
    return new LocalSourceSnapshot(
      identity,
      git.repository,
      headCommit,
      committed ? (options.targetBranch ?? null) : git.initialBranch,
      canonicalFiles,
      selected,
      limitations,
      diff,
      sourceTree,
      [...(options.excludePatterns ?? [])],
    );
  } finally {
    git.close();
  }
}
