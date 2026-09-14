import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { sourcePath } from '@gcr/client-contract';
import { contentHash } from './local-identity.js';
import { sourcePathPolicy, SourceCaptureError } from './source-policy.js';
import { createHash } from 'node:crypto';

async function git(cwd: string, args: string[], input?: string, allow = [0]) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      'git',
      [
        ...(args[0] === 'check-ignore' ? [] : ['--literal-pathspecs']),
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-C',
        cwd,
        ...args,
      ],
      {
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LC_ALL: 'C',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_NO_LAZY_FETCH: '1',
          GIT_TERMINAL_PROMPT: '0',
          GIT_ALLOW_PROTOCOL: '',
        },
      },
      (error, stdout) => {
        if (error && !allow.includes(Number(error.code)))
          reject(new SourceCaptureError('source-unavailable'));
        else resolve(stdout);
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
export interface AutomaticIndexChange {
  path: string;
  status: string;
  oldOid: string;
  oid: string;
  oldMode: string;
  mode: string;
}
export interface AutomaticRepository {
  root: string;
  indexPath: string;
  head: string | null;
  fingerprint: string;
  changes: AutomaticIndexChange[];
}
export async function observeAutomaticRepository(
  cwd: string,
  excludes: string[] = [],
): Promise<AutomaticRepository> {
  const root = await realpath((await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
  const indexPath = (
    await git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
  ).trim();
  const head =
    (await git(root, ['rev-parse', '--verify', 'HEAD'], undefined, [0, 128])).trim() || null;
  const index = await git(root, ['ls-files', '--stage', '-z']);
  const raw = (
    await git(root, [
      'diff',
      '--cached',
      '--raw',
      '--no-abbrev',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '-z',
      '--',
    ])
  ).split('\0');
  const policy = sourcePathPolicy(excludes),
    changes: AutomaticIndexChange[] = [];
  for (let i = 0; i < raw.length - 1; i += 2) {
    const header = raw[i]!.match(
      /^:(\d{6}) (\d{6}) ([a-f0-9]{40,64}) ([a-f0-9]{40,64}) ([AMDTU])$/,
    );
    if (!header) throw new SourceCaptureError('source-unavailable');
    const file = sourcePath(raw[i + 1]);
    if (policy(file) || !['000000', '100644', '100755'].includes(header[2]!) || header[5] === 'U')
      continue;
    changes.push({
      path: file,
      oldMode: header[1]!,
      mode: header[2]!,
      oldOid: header[3]!,
      oid: header[4]!,
      status: header[5]!,
    });
  }
  if (changes.length) {
    const ignored = new Set(
      (
        await git(
          root,
          ['check-ignore', '--no-index', '-z', '--stdin'],
          changes.map((c) => `./${c.path}\0`).join(''),
          [0, 1],
        )
      )
        .split('\0')
        .map((p) => p.replace(/^\.\//, '')),
    );
    for (let i = changes.length - 1; i >= 0; i--)
      if (ignored.has(changes[i]!.path)) changes.splice(i, 1);
  }
  const endHead =
    (await git(root, ['rev-parse', '--verify', 'HEAD'], undefined, [0, 128])).trim() || null;
  const endIndex = await git(root, ['ls-files', '--stage', '-z']);
  if (head !== endHead || index !== endIndex) throw new SourceCaptureError('source-unavailable');
  return { root, indexPath, head, fingerprint: contentHash({ head, index }), changes };
}
/** Whole-file unstaging/removal and index stat refreshes add no reviewable input. */
export function newlyStagedPaths(previous: AutomaticRepository, current: AutomaticRepository) {
  if (
    previous.root !== current.root ||
    previous.head !== current.head ||
    previous.fingerprint === current.fingerprint
  )
    return [];
  const before = new Map(previous.changes.map((c) => [c.path, contentHash(c)]));
  return current.changes.filter((c) => before.get(c.path) !== contentHash(c)).map((c) => c.path);
}
async function workingTreeChanged(root: string, file: string) {
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD'], undefined, [0, 128])).trim();
  if (!head) return !!(await git(root, ['status', '--porcelain=v1', '-z', '--', file]));
  // The index can differ while the saved file has already returned to HEAD.
  // Include untracked files explicitly: diff alone does not report them.
  return (
    !!(await git(root, [
      'diff',
      head,
      '--name-only',
      '-z',
      '--no-ext-diff',
      '--no-textconv',
      '--',
      file,
    ])) || !!(await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', file]))
  );
}
/** Reads one explicitly observed path only after metadata/ignore policy checks. */
export async function observeAutomaticFile(
  root: string,
  file: string,
  excludes: string[] = [],
): Promise<{ hash: string | null; changed: boolean } | undefined> {
  return readAutomaticFile(await realpath(root), file, excludes);
}
async function readAutomaticFile(
  root: string,
  file: string,
  excludes: string[],
  // Only the bulk observer may supply this after a bounded Git/ignore query.
  knownChanged = false,
): Promise<{ hash: string | null; changed: boolean } | undefined> {
  file = sourcePath(file);
  if (sourcePathPolicy(excludes)(file)) return undefined;
  const absolute = path.join(root, file);
  // A deleted directory still contains reviewable tracked deletions. Check its
  // nearest existing ancestor without accepting a symlink or an inaccessible path.
  let parent = path.dirname(absolute);
  for (;;) {
    try {
      if ((await realpath(parent)) !== parent) return undefined;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === root) return undefined;
      parent = path.dirname(parent);
    }
  }
  if (parent !== root && !parent.startsWith(root + path.sep)) return undefined;
  const ignored = knownChanged
    ? ''
    : await git(root, ['check-ignore', '--no-index', '-z', '--stdin'], `./${file}\0`, [0, 1]);
  if (ignored) return undefined;
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.size > 2 * 1024 * 1024) return undefined;
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      return undefined;
    if (buffer.subarray(0, length).includes(0)) return undefined;
    const changed = knownChanged || (await workingTreeChanged(root, file));
    return { hash: createHash('sha256').update(buffer.subarray(0, length)).digest('hex'), changed };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const changed = knownChanged || (await workingTreeChanged(root, file));
      return { hash: null, changed };
    }
    return undefined;
  } finally {
    await handle?.close();
  }
}

export interface AutomaticWorkingTree {
  root: string;
  head: string | null;
  fingerprint: string;
  files: Array<{ path: string; hash: string | null }>;
}
/** Re-query Git as well as file bytes so missed filesystem events can be recovered.
 * Only changed, permitted text files enter the observation; contents are not retained. */
export async function observeAutomaticWorkingTree(
  cwd: string,
  excludes: string[] = [],
): Promise<AutomaticWorkingTree> {
  const root = await realpath((await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
  const readHead = async () =>
    (await git(root, ['rev-parse', '--verify', 'HEAD'], undefined, [0, 128])).trim() || null;
  const head = await readHead();
  const candidates = async () => {
    const tracked = await git(
      root,
      head
        ? [
            'diff',
            head,
            '--name-only',
            '--no-renames',
            '--no-ext-diff',
            '--no-textconv',
            '-z',
            '--',
          ]
        : ['ls-files', '--cached', '-z'],
    );
    const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
    return [...new Set((tracked + untracked).split('\0').filter(Boolean))].sort();
  };
  const names = await candidates(),
    policy = sourcePathPolicy(excludes);
  const permitted = names.map((file) => sourcePath(file)).filter((file) => !policy(file));
  if (permitted.length > 512) throw new SourceCaptureError('source-unavailable');
  const ignored = new Set(
    permitted.length
      ? (
          await git(
            root,
            ['check-ignore', '--no-index', '-z', '--stdin'],
            permitted.map((file) => `./${file}\0`).join(''),
            [0, 1],
          )
        )
          .split('\0')
          .map((file) => file.replace(/^\.\//, ''))
      : [],
  );
  const files: AutomaticWorkingTree['files'] = [];
  const deadline = Date.now() + 20000;
  for (const file of permitted) {
    if (ignored.has(file)) continue;
    if (Date.now() > deadline) throw new SourceCaptureError('source-unavailable');
    const observed = await readAutomaticFile(root, file, excludes, true);
    if (observed?.changed) files.push({ path: file, hash: observed.hash });
  }
  if (head !== (await readHead()) || contentHash(names) !== contentHash(await candidates()))
    throw new SourceCaptureError('source-unavailable');
  return { root, head, files, fingerprint: contentHash({ head, files }) };
}
