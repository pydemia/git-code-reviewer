import { execFile } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

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
  const run = createGitRunner(input.workspace, askPassPath, input.credential);
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

  const names = await run(['diff', '--name-status', '-M', mergeBase, input.headSha, '--']);
  const files: SnapshotFile[] = [];
  for (const line of names.split('\n').filter(Boolean).slice(0, 2_000)) {
    const parsed = parseNameStatus(line);
    const stats = await fileStats(run, mergeBase, input.headSha, parsed.path);
    const patchText = await run([
      'diff',
      '--no-ext-diff',
      '--binary',
      '--find-renames',
      mergeBase,
      input.headSha,
      '--',
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
  return {
    resolution: 'exact',
    mergeBaseSha: baseSha,
    baseSha,
    headSha,
    patch: patchText,
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
        additions: 42,
        deletions: 0,
        patch:
          'diff --git a/src/auth/session.test.ts b/src/auth/session.test.ts\nnew file mode 100644\n',
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
): GitRunner {
  return async (arguments_: string[]) => {
    try {
      const result = await execFileAsync(
        'git',
        [
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

function parseNameStatus(line: string): Pick<SnapshotFile, 'path' | 'previousPath' | 'status'> {
  const [rawStatus = '', first = '', second] = line.split('\t');
  const statusCode = rawStatus.charAt(0);
  if (!first || (statusCode === 'R' && !second)) throw new Error('Invalid Git name-status output');
  if (statusCode === 'R') return { path: second!, previousPath: first, status: 'renamed' };
  if (statusCode === 'A') return { path: first, previousPath: null, status: 'added' };
  if (statusCode === 'D') return { path: first, previousPath: null, status: 'deleted' };
  return { path: first, previousPath: null, status: 'modified' };
}

async function fileStats(
  run: GitRunner,
  mergeBase: string,
  headSha: string,
  filePath: string,
): Promise<{ additions: number | null; deletions: number | null; binary: boolean }> {
  const output = (await run(['diff', '--numstat', mergeBase, headSha, '--', filePath])).trim();
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
