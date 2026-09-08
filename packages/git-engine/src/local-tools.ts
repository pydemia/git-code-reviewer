import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
export type SourceToolInput = {
  name: string;
  revision?: string;
  path?: string;
  query?: string;
  startLine?: number;
  endLine?: number;
};
function validPath(value: string) {
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
export async function runLocalSourceTool(root: string, input: SourceToolInput): Promise<unknown> {
  const revision = input.revision ?? 'head';
  if (!['head', 'base', 'mergeBase'].includes(revision)) throw Error('invalid_revision');
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as Record<
    string,
    string
  >;
  const sha = manifest[revision]!;
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('invalid_revision');
  const git = async (arguments_: string[]) =>
    (
      await execute(
        'git',
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'protocol.allow=never',
          '-c',
          'core.attributesFile=/dev/null',
          '--git-dir',
          path.join(root, 'repository.git'),
          ...arguments_,
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: root,
            LC_ALL: 'C',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_NO_LAZY_FETCH: '1',
            GIT_OPTIONAL_LOCKS: '0',
            GIT_TERMINAL_PROMPT: '0',
          },
          timeout: 25000,
          maxBuffer: 8 * 1024 * 1024,
          encoding: 'utf8',
        },
      )
    ).stdout;
  const filePath = input.path ? validPath(input.path) : undefined;
  if (['git_diff', 'git_log', 'git_blame'].includes(input.name)) {
    const paths = filePath ? ['--', `:(literal)${filePath}`] : [];
    const arguments_ =
      input.name === 'git_diff'
        ? [
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--find-renames',
            manifest.mergeBase!,
            sha,
            ...paths,
          ]
        : input.name === 'git_log'
          ? ['log', '--no-show-signature', '-20', '--format=%H %s', sha, ...paths]
          : [
              'blame',
              '--no-textconv',
              '-L',
              `${Math.max(1, input.startLine ?? 1)},+40`,
              sha,
              '--',
              filePath ?? '',
            ];
    if (input.name === 'git_blame' && !filePath) throw Error('path_required');
    const content = await git(arguments_);
    return { revision, sha, content: content.slice(0, 24000), truncated: content.length > 24000 };
  }
  const entries = (await git(['ls-tree', '-r', '-z', '--long', sha]))
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const [header, name] = entry.split('\t');
      const [mode, type, blob, size] = header!.trim().split(/\s+/);
      return { path: name!, mode: mode!, type, blob: blob!, size: Number(size) };
    });
  if (input.name === 'list_files') {
    const files = entries.filter((entry) => !filePath || entry.path.startsWith(filePath));
    return { revision, sha, files: files.slice(0, 300), truncated: files.length > 300 };
  }
  const view = path.join(root, 'views', revision);
  const load = async (entry: (typeof entries)[number]) => {
    validPath(entry.path);
    if (!['100644', '100755'].includes(entry.mode) || entry.size > 1048576)
      throw Error('source_type_or_size_unsupported');
    const target = path.join(view, entry.path);
    if (
      !(await lstat(target)).isFile() ||
      !(await realpath(target)).startsWith(`${await realpath(view)}/`)
    )
      throw Error('source_path_escape');
    const content = await readFile(target);
    if (content.length > 1048576 || content.includes(0)) throw Error('source_binary_or_size_limit');
    const blob = createHash('sha1')
      .update(`blob ${content.length}\0`)
      .update(content)
      .digest('hex');
    if (blob !== entry.blob) throw Error('source_blob_mismatch');
    return new TextDecoder('utf-8', { fatal: true }).decode(content).split('\n');
  };
  if (input.name === 'read_file') {
    const entry = entries.find((item) => item.path === filePath);
    if (!entry) throw Error('source_not_found');
    const lines = await load(entry);
    const startLine = input.startLine ?? 1;
    const endLine = Math.min(lines.length, input.endLine ?? startLine + 159, startLine + 199);
    if (
      !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(endLine) ||
      startLine < 1 ||
      endLine < startLine
    )
      throw Error('invalid_line_range');
    const full = lines.slice(startLine - 1, endLine).join('\n');
    const content = full.slice(0, 24000);
    const hash = createHash('sha256').update(content).digest('hex');
    const id = createHash('sha256')
      .update(`${sha}:${entry.path}:${startLine}:${endLine}:${hash}`)
      .digest('hex')
      .slice(0, 24);
    return {
      id,
      revision,
      sha,
      path: entry.path,
      startLine,
      endLine,
      blob: entry.blob,
      hash,
      content,
      truncated: full.length > content.length || endLine < lines.length,
    };
  }
  if (input.name === 'search_code' || input.name === 'find_related_code') {
    const query = input.query?.trim();
    if (!query || query.length > 300) throw Error('invalid_search_query');
    const matches: Array<{ path: string; line: number; content: string }> = [];
    let omitted = 0;
    for (const entry of entries) {
      if (filePath && !entry.path.startsWith(filePath)) continue;
      try {
        const lines = await load(entry);
        for (const [index, line] of lines.entries())
          if (line.includes(query)) {
            matches.push({ path: entry.path, line: index + 1, content: line.slice(0, 300) });
            if (matches.length >= 60) return { revision, sha, matches, truncated: true, omitted };
          }
      } catch {
        omitted += 1;
      }
    }
    return { revision, sha, matches, truncated: false, omitted };
  }
  throw Error('tool_not_allowed');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > 8192) throw Error('tool_input_limit');
  }
  try {
    process.stdout.write(
      JSON.stringify(await runLocalSourceTool(process.argv[2] ?? '/source', JSON.parse(input))),
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ error: error instanceof Error ? error.message : 'source_tool_failed' }),
    );
    process.exitCode = 1;
  }
}
