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
  type SnapshotIdentity,
  type SourceFile,
} from '@gcr/client-contract';
import { contentHash } from './local-identity.js';
import {
  SourceCaptureError,
  sourcePathPolicy,
  type SourceExclusionReason,
} from './source-policy.js';
import { SourceGit, type GitEntry, type GitTree } from './source-git.js';

type Side = 'base' | 'source';
export interface SourceLimitation {
  path: string;
  side: Side;
  reason: SourceExclusionReason;
  detail: string;
}
export interface SourceChange {
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R' | 'T';
  side: Side;
}
interface CapturedFile {
  source: SourceFile;
  text: string;
  mode: string;
}
export type FixedSourceRead =
  | { status: 'available'; source: SourceFile; text: string }
  | { status: 'absent' }
  | { status: 'unavailable'; reason: SourceExclusionReason; detail: string };
export interface CaptureSourceOptions {
  cwd: string;
  kind: 'index' | 'working-tree';
  /** Resolve this ref once, then use its merge-base with the captured HEAD. */
  baseRef?: string;
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
class LocalSourceSnapshot {
  #files: Map<string, CapturedFile>;
  #closed = false;
  #identity: SnapshotIdentity;
  #selected: SourceChange[];
  #limitations: SourceLimitation[];
  #diff: string;
  #headCommit: string | null;
  constructor(
    identity: SnapshotIdentity,
    headCommit: string | null,
    files: Map<string, CapturedFile>,
    selected: SourceChange[],
    limitations: SourceLimitation[],
    diff: string,
  ) {
    this.#identity = snapshotIdentity(identity);
    this.#headCommit = headCommit;
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
  get diff(): string {
    this.open();
    return this.#diff;
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
    const result = this.readFile(file, side);
    if (
      !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(endLine) ||
      startLine < 1 ||
      endLine < startLine
    )
      throw new SourceCaptureError('invalid-source-request');
    if (result.status !== 'available') return result;
    const lines = result.text.split('\n');
    if (startLine > lines.length) throw new SourceCaptureError('invalid-source-request');
    const end = Math.min(endLine, startLine + 199, lines.length);
    const full = lines.slice(startLine - 1, end).join('\n');
    const text = full.slice(0, 24_000);
    return {
      status: 'available' as const,
      source: result.source,
      startLine,
      endLine: startLine + text.split('\n').length - 1,
      text,
      excerptHash: hash(text),
      truncated: text.length !== full.length || end < Math.min(endLine, lines.length),
    };
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

/** Synchronous bounded capture; extension hosts should run it outside their UI event loop. */
export function captureLocalSource(input: CaptureSourceOptions): LocalSourceSnapshot {
  const options = structuredClone(input);
  if (options.kind !== 'index' && options.kind !== 'working-tree')
    throw new SourceCaptureError('invalid-source-request');
  const selectedPaths = options.paths === undefined ? undefined : paths(options.paths);
  const untracked = paths(options.includeUntracked);
  if (options.kind === 'index' && untracked.length)
    throw new SourceCaptureError('invalid-source-request');
  const policy = sourcePathPolicy(options.excludePatterns);
  const fileLimit = limit(options.limits?.fileBytes, 1_048_576, 4_194_304);
  const byteLimit = limit(options.limits?.totalBytes, 33_554_432, 134_217_728);
  const fileCount = limit(options.limits?.files, 10_000, 10_000);
  const entryLimit = limit(options.limits?.entries, 50_000, 50_000);
  const deadline = Date.now() + limit(options.limits?.durationMs, 30_000, 120_000);
  if (options.baseRef !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/.test(options.baseRef))
    throw new SourceCaptureError('invalid-source-request');
  const git = new SourceGit(options.cwd, deadline, options.indexFile);
  try {
    const headCommit = git.initialHead;
    let baseCommit = headCommit;
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
    const sourceTree = git.oid(git.text(['write-tree']).trim());
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
          (side === 'base' || options.kind === 'index' || entry.mode === '160000') &&
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
    if (git.head() !== headCommit || checkIgnore() !== frozenIgnore)
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
    const identity = snapshotIdentity({
      kind: options.kind,
      objectFormat: git.objectFormat,
      baseCommit,
      baseTree,
      ...(options.kind === 'index' ? { sourceTree } : {}),
      hash: contentHash({
        version: 1,
        kind: options.kind,
        headCommit,
        baseCommit,
        baseTree,
        sourceTree,
        sourceFiles: [...files.values()].map((file) => ({ ...file.source, mode: file.mode })),
        selected,
        limitations,
        policy: options.excludePatterns ?? [],
        diffHash: hash(diff),
      }),
    });
    return new LocalSourceSnapshot(identity, headCommit, files, selected, limitations, diff);
  } finally {
    git.close();
  }
}
