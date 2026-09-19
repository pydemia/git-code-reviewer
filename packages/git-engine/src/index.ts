import { execFile } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gitTrustEnvironment } from './git-trust.js';
export { prepareSourceWorkspace, safeSourcePath, workspaceSize } from './workspace.js';
export type { WorkspaceManifest } from './workspace.js';
export type { SourceToolInput } from './local-tools.js';

const execFileAsync = promisify(execFile);
const fullSha = /^[a-f0-9]{40}$/i;

export type SnapshotFile = {
  path: string;
  previousPath: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'binary';
  additions: number | null;
  deletions: number | null;
  patch: string;
};

export type SnapshotMaterialization = {
  resolution: 'exact' | 'unresolved';
  mergeBaseSha: string | null;
  trees?: { base: string; head: string; mergeBase: string };
  baseSha: string;
  headSha: string;
  files: SnapshotFile[];
  patch: string;
  commits: Array<{ sha: string; subject: string; author: string; authoredAt: string }>;
};

export type GitSnapshotInput = {
  workspace: string;
  webBaseUrl: string;
  owner: string;
  repository: string;
  pullNumber: number;
  baseSha: string;
  headSha: string;
  credential: { username: string; password: string };
};

export async function materializeGitSnapshot(
  input: GitSnapshotInput,
): Promise<SnapshotMaterialization> {
  assertSha(input.baseSha);
  assertSha(input.headSha);
  const cloneUrl = buildCloneUrl(input.webBaseUrl, input.owner, input.repository);
  await mkdir(input.workspace, { recursive: true, mode: 0o700 });
  const askPassPath = path.join(input.workspace, 'git-askpass.sh');
  await writeFile(
    askPassPath,
    '#!/bin/sh\ncase "$1" in *Username*) printf "%s" "$GCR_GIT_USERNAME" ;; *) printf "%s" "$GCR_GIT_PASSWORD" ;; esac\n',
    { mode: 0o700 },
  );
  await chmod(askPassPath, 0o700);
  const run = createGitRunner(
    input.workspace,
    askPassPath,
    input.credential,
    await gitTrustEnvironment(input.workspace),
  );
  await run(['init', '--quiet']);
  await run(['remote', 'add', 'origin', cloneUrl]);
  await run([
    'fetch',
    '--quiet',
    '--no-tags',
    '--filter=blob:none',
    '--depth=64',
    'origin',
    `+${input.baseSha}:refs/gcr/base`,
    `+${input.headSha}:refs/gcr/head`,
  ]);
  const fetchedBase = (await run(['rev-parse', 'refs/gcr/base'])).trim();
  const fetchedHead = (await run(['rev-parse', 'refs/gcr/head'])).trim();
  if (fetchedBase !== input.baseSha || fetchedHead !== input.headSha) {
    throw new Error('Fetched commit identity does not match the observed pull request');
  }

  let mergeBase = await tryMergeBase(run);
  for (const deepen of [256, 1024]) {
    if (mergeBase) break;
    await run(['fetch', '--quiet', '--deepen', String(deepen), 'origin']);
    mergeBase = await tryMergeBase(run);
  }
  if (!mergeBase) {
    return {
      resolution: 'unresolved',
      mergeBaseSha: null,
      baseSha: input.baseSha,
      headSha: input.headSha,
      files: [],
      patch: '',
      commits: [],
    };
  }

  const trees = {
    base: (await run(['rev-parse', `${input.baseSha}^{tree}`])).trim(),
    head: (await run(['rev-parse', `${input.headSha}^{tree}`])).trim(),
    mergeBase: (await run(['rev-parse', `${mergeBase}^{tree}`])).trim(),
  };
  for (const tree of Object.values(trees)) assertSha(tree);
  const names = await run(['diff', '--name-status', '-z', '-M', mergeBase, input.headSha, '--']);
  const files: SnapshotFile[] = [];
  for (const parsed of parseChangedPaths(names)) {
    const stats = await fileStats(run, mergeBase, input.headSha, parsed.path, parsed.previousPath);
    const patchText = await run([
      'diff',
      '--no-ext-diff',
      '--binary',
      '--find-renames',
      mergeBase,
      input.headSha,
      '--',
      ...(parsed.previousPath ? [parsed.previousPath] : []),
      parsed.path,
    ]);
    files.push({
      ...parsed,
      additions: stats.additions,
      deletions: stats.deletions,
      status: stats.binary ? 'binary' : parsed.status,
      patch: patchText,
    });
  }
  const patchText = await run([
    'diff',
    '--no-ext-diff',
    '--binary',
    '--find-renames',
    mergeBase,
    input.headSha,
    '--',
  ]);
  const commitText = await run([
    'log',
    '--format=%H%x09%an%x09%aI%x09%s',
    `${mergeBase}..${input.headSha}`,
    '--max-count=200',
  ]);
  return {
    resolution: 'exact',
    trees,
    mergeBaseSha: mergeBase,
    baseSha: input.baseSha,
    headSha: input.headSha,
    files,
    patch: patchText,
    commits: commitText
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha = '', author = '', authoredAt = '', ...subject] = line.split('\t');
        return { sha, author, authoredAt, subject: subject.join('\t') };
      }),
  };
}

export function materializeFixtureSnapshot(
  baseSha: string,
  headSha: string,
): SnapshotMaterialization {
  assertSha(baseSha);
  assertSha(headSha);
  const oldLines = [
    'export async function rotateSession(token: string) {',
    '  const current = await sessions.findByToken(token);',
    '  if (!current || current.revokedAt) return null;',
    '',
    '  await sessions.revoke(current.id);',
    '  return sessions.create(current.userId);',
    '}',
  ];
  const newLines = [
    'export async function rotateSession(token: string) {',
    '  return database.transaction(async (tx) => {',
    '    const current = await sessions.findByToken(token, tx);',
    '    if (!current || current.revokedAt) return null;',
    '',
    '    await sessions.revoke(current.id, tx);',
    '    return sessions.create(current.userId, tx);',
    '  });',
    '}',
  ];
  const patchText = [
    'diff --git a/src/auth/session.ts b/src/auth/session.ts',
    'index 0d4b2ae..9ac81c3 100644',
    '--- a/src/auth/session.ts',
    '+++ b/src/auth/session.ts',
    '@@ -1,7 +1,9 @@',
    ` ${oldLines[0]}`,
    ...oldLines.slice(1, -1).map((line) => `-${line}`),
    ...newLines.slice(1, -1).map((line) => `+${line}`),
    ` ${oldLines.at(-1)}`,
    '',
  ].join('\n');
  const testLines = [
    "import { beforeEach, describe, expect, it, vi } from 'vitest';",
    "import { rotateSession } from './session.js';",
    '',
    "describe('rotateSession', () => {",
    '  beforeEach(() => {',
    '    vi.restoreAllMocks();',
    '  });',
    '',
    "  it('rotates an active token inside one transaction', async () => {",
    "    sessions.findByToken.mockResolvedValue({ id: 'old', userId: 'user-1' });",
    "    sessions.create.mockResolvedValue({ token: 'next' });",
    '',
    "    await expect(rotateSession('active')).resolves.toEqual({ token: 'next' });",
    '    expect(database.transaction).toHaveBeenCalledTimes(1);',
    "    expect(sessions.revoke).toHaveBeenCalledWith('old', expect.anything());",
    '  });',
    '',
    "  it('returns null for a revoked token without writing', async () => {",
    "    sessions.findByToken.mockResolvedValue({ id: 'old', revokedAt: new Date() });",
    '',
    "    await expect(rotateSession('revoked')).resolves.toBeNull();",
    '    expect(sessions.revoke).not.toHaveBeenCalled();',
    '    expect(sessions.create).not.toHaveBeenCalled();',
    '  });',
    '',
    "  it('keeps concurrent rotation attempts consistent', async () => {",
    "    sessions.findByToken.mockResolvedValue({ id: 'old', userId: 'user-1' });",
    "    sessions.create.mockResolvedValueOnce({ token: 'next' }).mockResolvedValueOnce(null);",
    '',
    '    const results = await Promise.all([',
    "      rotateSession('active'),",
    "      rotateSession('active'),",
    '    ]);',
    '',
    '    expect(results.filter(Boolean)).toHaveLength(1);',
    '    expect(database.transaction).toHaveBeenCalledTimes(2);',
    '  });',
    '});',
    '',
  ];
  const testPatch = [
    'diff --git a/src/auth/session.test.ts b/src/auth/session.test.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/auth/session.test.ts',
    `@@ -0,0 +1,${testLines.length} @@`,
    ...testLines.map((line) => `+${line}`),
    '',
  ].join('\n');
  return {
    resolution: 'exact',
    mergeBaseSha: baseSha,
    baseSha,
    headSha,
    patch: `${patchText}${testPatch}`,
    files: [
      {
        path: 'src/auth/session.ts',
        previousPath: null,
        status: 'modified',
        additions: 7,
        deletions: 5,
        patch: patchText,
      },
      {
        path: 'src/auth/session.test.ts',
        previousPath: null,
        status: 'added',
        additions: testLines.length,
        deletions: 0,
        patch: testPatch,
      },
    ],
    commits: [
      {
        sha: headSha,
        subject: 'Harden session rotation and token exchange',
        author: 'minseo-kim',
        authoredAt: new Date(0).toISOString(),
      },
    ],
  };
}

type GitRunner = (arguments_: string[]) => Promise<string>;

function createGitRunner(
  workspace: string,
  askPassPath: string,
  credential: { username: string; password: string },
  trustEnvironment: NodeJS.ProcessEnv,
): GitRunner {
  return async (arguments_: string[]) => {
    try {
      const result = await execFileAsync(
        'git',
        [
          '--literal-pathspecs',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'protocol.file.allow=never',
          '-c',
          'submodule.recurse=false',
          '-c',
          'filter.lfs.smudge=',
          '-c',
          'filter.lfs.required=false',
          ...arguments_,
        ],
        {
          cwd: workspace,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          timeout: 180_000,
          env: {
            PATH: process.env.PATH,
            HOME: workspace,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS_REQUIRE: 'force',
            GIT_ASKPASS: askPassPath,
            GIT_LFS_SKIP_SMUDGE: '1',
            ...trustEnvironment,
            GCR_GIT_USERNAME: credential.username,
            GCR_GIT_PASSWORD: credential.password,
          },
        },
      );
      return result.stdout;
    } catch {
      throw new Error('Git command failed');
    }
  };
}

async function tryMergeBase(run: GitRunner): Promise<string | null> {
  try {
    const result = (await run(['merge-base', 'refs/gcr/base', 'refs/gcr/head'])).trim();
    return fullSha.test(result) ? result : null;
  } catch {
    return null;
  }
}

/** Git -z preserves tabs, newlines and non-ASCII paths without quoting or truncation. */
export function parseChangedPaths(
  output: string,
): Array<Pick<SnapshotFile, 'path' | 'previousPath' | 'status'>> {
  if (!output) return [];
  if (!output.endsWith('\0')) throw new Error('Incomplete Git name-status output');
  const fields = output.slice(0, -1).split('\0');
  const files: Array<Pick<SnapshotFile, 'path' | 'previousPath' | 'status'>> = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++],
      first = fields[index++];
    if (!status || !/^[ACDMRTUXB][0-9]*$/.test(status) || !first)
      throw new Error('Invalid Git name-status output');
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const second = fields[index++];
      if (!second) throw new Error('Incomplete Git rename output');
      files.push({ path: second, previousPath: first, status: code === 'R' ? 'renamed' : 'added' });
    } else
      files.push({
        path: first,
        previousPath: null,
        status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified',
      });
  }
  return files;
}

async function fileStats(
  run: GitRunner,
  mergeBase: string,
  headSha: string,
  filePath: string,
  previousPath: string | null,
): Promise<{ additions: number | null; deletions: number | null; binary: boolean }> {
  const output = (
    await run([
      'diff',
      '--numstat',
      '-M',
      mergeBase,
      headSha,
      '--',
      ...(previousPath ? [previousPath] : []),
      filePath,
    ])
  ).trim();
  const [additions, deletions] = output.split('\t');
  if (additions === '-' || deletions === '-') {
    return { additions: null, deletions: null, binary: true };
  }
  return {
    additions: Number(additions || 0),
    deletions: Number(deletions || 0),
    binary: false,
  };
}

function buildCloneUrl(webBaseUrl: string, owner: string, repository: string): string {
  const base = new URL(webBaseUrl);
  if (base.protocol !== 'https:' || base.username || base.password)
    throw new Error('Unsafe Git origin');
  const url = new URL(
    `${encodeURIComponent(owner)}/${encodeURIComponent(repository)}.git`,
    webBaseUrl.endsWith('/') ? webBaseUrl : `${webBaseUrl}/`,
  );
  return url.toString();
}

function assertSha(value: string) {
  if (!fullSha.test(value)) throw new Error('A full commit SHA is required');
}
