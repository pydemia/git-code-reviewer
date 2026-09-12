import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { clientIdentity, type ClientIdentity } from '@gcr/client-contract';
import { LocalStoreError } from './local-errors.js';

/** Canonical JSON for producer-side hashes; decoders do not recompute these hashes. */
export function canonicalJson(value: unknown, maxBytes = 16 * 1024 * 1024): string {
  const active = new Set<object>();
  let bytes = 0;
  const add = (text: string): string => {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes)
      throw new LocalStoreError('record-too-large', 'Local record exceeds its size limit.');
    return text;
  };
  const visit = (entry: unknown, depth: number): string => {
    if (depth > 64) throw new LocalStoreError('corrupt-storage', 'JSON nesting exceeds its limit.');
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'string')
      return add(JSON.stringify(entry));
    if (typeof entry === 'number' && Number.isFinite(entry)) return add(JSON.stringify(entry));
    if (!entry || typeof entry !== 'object' || active.has(entry))
      throw new LocalStoreError('corrupt-storage', 'Expected acyclic JSON data.');
    active.add(entry);
    try {
      if (Array.isArray(entry)) {
        add('[');
        add(']');
        const result = Array.from(entry, (item) => visit(item, depth + 1));
        if (result.length > 1) add(','.repeat(result.length - 1));
        return `[${result.join(',')}]`;
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(entry)))
        throw new LocalStoreError('corrupt-storage', 'Expected a plain JSON object.');
      add('{');
      add('}');
      const entries = Object.keys(entry)
        .sort()
        .map((key) => {
          add(JSON.stringify(key));
          add(':');
          return `${JSON.stringify(key)}:${visit((entry as Record<string, unknown>)[key], depth + 1)}`;
        });
      if (entries.length > 1) add(','.repeat(entries.length - 1));
      return `{${entries.join(',')}}`;
    } finally {
      active.delete(entry);
    }
  };
  return visit(value, 0);
}
export const contentHash = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

export function defaultLocalDataDirectory(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin')
    return path.join(homedir(), 'Library', 'Application Support', 'CommitDefender');
  if (platform === 'linux') {
    const configured = process.env.XDG_DATA_HOME;
    return path.join(
      configured && path.isAbsolute(configured)
        ? configured
        : path.join(homedir(), '.local', 'share'),
      'CommitDefender',
    );
  }
  throw new LocalStoreError(
    'unsupported-platform',
    'Local storage requires a supported OS credential store.',
  );
}

/** Local checkout identity does not depend on a basename, mutable remote URL or central login. */
export function discoverLocalIdentity(cwd: string, profileId: string): ClientIdentity {
  const git = (args: string[]): string =>
    execFileSync('git', ['-C', cwd, '--no-optional-locks', 'rev-parse', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim();
  try {
    const root = realpathSync(git(['--path-format=absolute', '--show-toplevel']));
    const common = realpathSync(git(['--path-format=absolute', '--git-common-dir']));
    const directory = realpathSync(git(['--path-format=absolute', '--git-dir']));
    return clientIdentity({
      mode: 'standalone',
      profileId,
      repositoryKey: contentHash({ version: 1, commonDirectory: common }),
      worktreeKey: contentHash({
        version: 1,
        commonDirectory: common,
        gitDirectory: directory,
        root,
      }),
    });
  } catch {
    throw new LocalStoreError('storage-unavailable', 'Cannot identify the local Git worktree.');
  }
}
