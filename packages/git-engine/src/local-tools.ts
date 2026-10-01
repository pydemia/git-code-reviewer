import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { findCodeCandidates, type CodeCandidate } from './related-code.js';

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
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as {
    head: string;
    base: string;
    mergeBase: string;
    format?: number;
  };
  const sha = manifest[revision as 'head' | 'base' | 'mergeBase'];
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) throw Error('invalid_revision');
  if (manifest.format !== undefined && manifest.format !== 2)
    throw Error('invalid_workspace_format');
  const gitArguments = (arguments_: string[]) => [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'protocol.allow=never',
    '-c',
    'core.attributesFile=/dev/null',
    '--git-dir',
    path.join(root, 'repository.git'),
    ...arguments_,
  ];
  const gitEnvironment = {
    PATH: process.env.PATH,
    HOME: root,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = async (arguments_: string[]) =>
    (
      await execute('git', gitArguments(arguments_), {
        env: gitEnvironment,
        timeout: 25000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
      })
    ).stdout;
  const gitBlob = async (blob: string) => {
    if (!/^[a-f0-9]{40}$/.test(blob)) throw Error('invalid_source_blob');
    return (
      await execute('git', gitArguments(['cat-file', 'blob', blob]), {
        env: gitEnvironment,
        timeout: 25000,
        maxBuffer: 1048576 + 1024,
        encoding: 'buffer',
      })
    ).stdout;
  };
  const gitBlobs = async (batch: Array<{ blob: string; size: number }>) => {
    if (batch.some(({ blob }) => !/^[a-f0-9]{40}$/.test(blob))) throw Error('invalid_source_blob');
    const maxOutput = batch.reduce((total, entry) => total + entry.size + 128, 0);
    return new Promise<Buffer[]>((resolve, reject) => {
      const child = spawn('git', gitArguments(['cat-file', '--batch']), {
        env: gitEnvironment,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const parts: Buffer[] = [];
      let length = 0;
      const timeout = setTimeout(() => child.kill('SIGKILL'), 25000);
      child.stdout.on('data', (part: Buffer) => {
        length += part.length;
        if (length > maxOutput) child.kill('SIGKILL');
        else parts.push(part);
      });
      child.stderr.resume();
      child.stdin.on('error', () => undefined);
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) return reject(Error('source_blob_unavailable'));
        try {
          const output = Buffer.concat(parts);
          const contents: Buffer[] = [];
          let offset = 0;
          for (const entry of batch) {
            const newline = output.indexOf(10, offset);
            if (newline < 0) throw Error('source_blob_mismatch');
            const header = output.subarray(offset, newline).toString('ascii');
            if (header !== `${entry.blob} blob ${entry.size}`) throw Error('source_blob_mismatch');
            const end = newline + 1 + entry.size;
            if (end >= output.length || output[end] !== 10) throw Error('source_blob_mismatch');
            contents.push(output.subarray(newline + 1, end));
            offset = end + 1;
          }
          if (offset !== output.length) throw Error('source_blob_mismatch');
          resolve(contents);
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(`${batch.map(({ blob }) => blob).join('\n')}\n`);
    });
  };
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
            manifest.mergeBase,
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
      const separator = entry.indexOf('\t');
      if (separator < 0) throw Error('invalid_source_tree');
      const [mode, type, blob, size] = entry.slice(0, separator).trim().split(/\s+/);
      return {
        path: entry.slice(separator + 1),
        mode: mode!,
        type,
        blob: blob!,
        size: Number(size),
      };
    });
  if (input.name === 'list_files') {
    const files = entries.filter((entry) => !filePath || entry.path.startsWith(filePath));
    return { revision, sha, files: files.slice(0, 300), truncated: files.length > 300 };
  }
  const view = path.join(root, 'views', revision);
  type Entry = (typeof entries)[number];
  const validateEntry = (entry: Entry) => {
    validPath(entry.path);
    if (
      !['100644', '100755'].includes(entry.mode) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > 1048576
    )
      throw Error('source_type_or_size_unsupported');
  };
  const decode = (entry: Entry, content: Buffer) => {
    if (content.length > 1048576 || content.includes(0)) throw Error('source_binary_or_size_limit');
    const blob = createHash('sha1')
      .update(`blob ${content.length}\0`)
      .update(content)
      .digest('hex');
    if (blob !== entry.blob) throw Error('source_blob_mismatch');
    return new TextDecoder('utf-8', { fatal: true }).decode(content).split('\n');
  };
  const load = async (entry: Entry) => {
    validateEntry(entry);
    let content: Buffer;
    if (manifest.format === 2) content = await gitBlob(entry.blob);
    else {
      const target = path.join(view, entry.path);
      if (
        !(await lstat(target)).isFile() ||
        !(await realpath(target)).startsWith(`${await realpath(view)}/`)
      )
        throw Error('source_path_escape');
      content = await readFile(target);
    }
    return decode(entry, content);
  };
  async function* loadMany(
    candidates: Entry[],
  ): AsyncGenerator<{ entry: Entry; lines?: string[] }> {
    if (manifest.format !== 2) {
      for (const entry of candidates) {
        try {
          yield { entry, lines: await load(entry) };
        } catch {
          yield { entry };
        }
      }
      return;
    }
    let batch: Entry[] = [];
    let bytes = 0;
    async function* flush(): AsyncGenerator<{ entry: Entry; lines?: string[] }> {
      if (!batch.length) return;
      const current = batch;
      batch = [];
      bytes = 0;
      try {
        const contents = await gitBlobs(current);
        for (const [index, entry] of current.entries()) {
          try {
            yield { entry, lines: decode(entry, contents[index]!) };
          } catch {
            yield { entry };
          }
        }
      } catch {
        for (const entry of current) yield { entry };
      }
    }
    for (const entry of candidates) {
      try {
        validateEntry(entry);
      } catch {
        yield* flush();
        yield { entry };
        continue;
      }
      if (batch.length >= 128 || bytes + entry.size > 4194304) yield* flush();
      batch.push(entry);
      bytes += entry.size;
    }
    yield* flush();
  }
  if (input.name === 'read_file') {
    if (!filePath) throw Error('path_required');
    const entry = entries.find((item) => item.path === filePath);
    if (!entry)
      return {
        revision,
        sha,
        path: filePath,
        exists: false,
        reason: 'path_not_present_in_revision',
      };
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
  if (input.name === 'find_related_code') {
    const query = input.query?.trim();
    if (!query || !/^[A-Za-z_$][\w$]*$/.test(query)) throw Error('symbol_identifier_required');
    const matches: CodeCandidate[] = [];
    let omitted = 0;
    let scanned = 0;
    let bytes = 0;
    const candidates: Entry[] = [];
    for (const entry of entries) {
      if (filePath && !entry.path.startsWith(filePath)) continue;
      if (
        !/\.(?:[cm]?[jt]sx?|py)$/.test(entry.path) ||
        scanned >= 512 ||
        bytes + entry.size > 4194304
      ) {
        omitted++;
        continue;
      }
      candidates.push(entry);
      scanned++;
      bytes += entry.size;
    }
    scanned = 0;
    for await (const { entry, lines } of loadMany(candidates)) {
      if (!lines) {
        omitted++;
        continue;
      }
      scanned++;
      try {
        matches.push(...findCodeCandidates(entry.path, lines, query));
      } catch {
        scanned--;
        omitted++;
      }
    }
    return {
      revision,
      sha,
      query,
      matches: matches.slice(0, 60),
      truncated: matches.length > 60,
      omitted,
      scanned,
      coverage: {
        method: 'typescript-syntax-python-lexical-v1',
        verifiedCallGraph: false,
        testsExecuted: false,
        limitations: [
          '정의·호출·테스트 후보입니다. read_file로 확인하세요.',
          'JS/TS는 구문 AST, Python은 lexical 후보입니다. import alias, overload, 동적 method binding과 다른 언어는 의미적으로 해석하지 않습니다.',
        ],
      },
    };
  }
  if (input.name === 'search_code') {
    const query = input.query?.trim();
    if (!query || query.length > 300) throw Error('invalid_search_query');
    const matches: Array<{ path: string; line: number; content: string }> = [];
    let omitted = 0;
    const candidates = entries.filter((entry) => !filePath || entry.path.startsWith(filePath));
    for await (const { entry, lines } of loadMany(candidates)) {
      if (!lines) {
        omitted++;
        continue;
      }
      for (const [index, line] of lines.entries())
        if (line.includes(query)) {
          matches.push({ path: entry.path, line: index + 1, content: line.slice(0, 300) });
          if (matches.length >= 60) return { revision, sha, matches, truncated: true, omitted };
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
