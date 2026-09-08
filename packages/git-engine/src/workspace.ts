import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitSnapshotInput } from './index.js';
import { gitTrustEnvironment } from './git-trust.js';

const execute = promisify(execFile);
export const safeGitOptions = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'protocol.file.allow=never',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'submodule.recurse=false',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'core.autocrlf=false',
];
export function gitEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
}
export type WorkspaceManifest = {
  base: string;
  mergeBase: string;
  head: string;
  files: number;
  bytes: number;
};
export function safeSourcePath(value: string): string {
  if (
    !value ||
    value.length > 1000 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    [...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    value
      .split('/')
      .some((part) => !part || part === '..' || part === '.' || part.toLowerCase() === '.git')
  )
    throw Error('invalid_source_path');
  return value;
}
export async function workspaceSize(directory: string, limit: number): Promise<number> {
  let total = 0;
  async function walk(current: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const location = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(location);
      else if (entry.isFile()) total += (await stat(location)).size;
      if (total > limit) throw Error('workspace_size_limit');
    }
  }
  await walk(directory);
  return total;
}
export async function prepareSourceWorkspace(
  input: GitSnapshotInput & { mergeBaseSha: string; maxBytes: number },
): Promise<WorkspaceManifest> {
  for (const sha of [input.baseSha, input.headSha, input.mergeBaseSha])
    if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('invalid_revision');
  const origin = new URL(input.webBaseUrl);
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    !/^[A-Za-z0-9_.-]+$/.test(input.owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(input.repository)
  )
    throw Error('invalid_origin');
  const url = new URL(
    `${input.owner}/${input.repository}.git`,
    origin.href.endsWith('/') ? origin : `${origin.href}/`,
  );
  await mkdir(input.workspace, { recursive: true, mode: 0o700 });
  const gitDirectory = path.join(input.workspace, 'repository.git');
  const manifestPath = path.join(input.workspace, 'manifest.json');
  try {
    const existing = JSON.parse(await readFile(manifestPath, 'utf8')) as WorkspaceManifest;
    if (
      existing.base === input.baseSha &&
      existing.head === input.headSha &&
      existing.mergeBase === input.mergeBaseSha
    )
      return existing;
    throw Error('workspace_revision_mismatch');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const askpass = path.join(input.workspace, 'askpass.sh');
  await writeFile(
    askpass,
    '#!/bin/sh\ncase "$1" in *Username*) printf "%s" "$GCR_GIT_USERNAME" ;; *) printf "%s" "$GCR_GIT_PASSWORD" ;; esac\n',
    { mode: 0o700 },
  );
  const environment = {
    ...gitEnvironment(input.workspace),
    ...(await gitTrustEnvironment(input.workspace)),
    GIT_ASKPASS: askpass,
    GCR_GIT_USERNAME: input.credential.username,
    GCR_GIT_PASSWORD: input.credential.password,
  };
  const run = async (arguments_: string[], maxBuffer = 8 * 1024 * 1024) =>
    (
      await execute('git', [...safeGitOptions, '--git-dir', gitDirectory, ...arguments_], {
        env: environment,
        timeout: 180000,
        maxBuffer,
        encoding: 'utf8',
      })
    ).stdout;
  try {
    await execute('git', ['init', '--bare', '--quiet', gitDirectory], { env: environment });
    await run(['config', 'remote.origin.url', url.href]);
    await run([
      'fetch',
      '--quiet',
      '--no-tags',
      '--depth=64',
      'origin',
      ...[...new Set([input.baseSha, input.headSha, input.mergeBaseSha])],
    ]);
    let bytes = await workspaceSize(input.workspace, input.maxBytes);
    let files = 0;
    for (const [revision, sha] of Object.entries({
      head: input.headSha,
      base: input.baseSha,
      mergeBase: input.mergeBaseSha,
    })) {
      if ((await run(['rev-parse', `${sha}^{commit}`])).trim() !== sha)
        throw Error('revision_unavailable');
      const view = path.join(input.workspace, 'views', revision);
      await run(['worktree', 'add', '--quiet', '--detach', '--no-checkout', view, sha]);
      const entries = (await run(['ls-tree', '-r', '-z', '--long', sha]))
        .split('\0')
        .filter(Boolean);
      if (entries.length > 50000) throw Error('workspace_file_limit');
      for (const entry of entries) {
        const [header, filePath] = entry.split('\t');
        const [mode, type, blob, size] = header!.trim().split(/\s+/);
        if (type !== 'blob' || !['100644', '100755'].includes(mode!)) continue;
        safeSourcePath(filePath!);
        const length = Number(size);
        if (length > 1024 * 1024) continue;
        bytes += length;
        if (bytes > input.maxBytes) throw Error('workspace_size_limit');
        const content = await execute(
          'git',
          [...safeGitOptions, '--git-dir', gitDirectory, 'cat-file', 'blob', blob!],
          { env: environment, encoding: 'buffer', maxBuffer: 1024 * 1024, timeout: 30000 },
        );
        const target = path.join(view, filePath!);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content.stdout, { mode: 0o444 });
        files += 1;
      }
    }
    const manifest = {
      head: input.headSha,
      base: input.baseSha,
      mergeBase: input.mergeBaseSha,
      files,
      bytes,
    };
    await run(['config', '--remove-section', 'remote.origin']);
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o444 });
    return manifest;
  } catch (error) {
    await rm(input.workspace, { recursive: true, force: true });
    throw Error('source_workspace_unavailable', { cause: error });
  } finally {
    await rm(askpass, { force: true });
  }
}
