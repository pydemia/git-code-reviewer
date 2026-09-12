// Adapted from Commit Defender sourcePolicy.ts (Apache-2.0), with a dependency-free
// deny-only pattern grammar. Git ignore decisions are frozen by source capture.
import path from 'node:path';
import { sourcePath, type sourceExclusionReason } from '@gcr/client-contract';

export type SourceExclusionReason = ReturnType<typeof sourceExclusionReason>;
const generated = new Set([
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'vendor',
  '.tox',
  'artifacts',
  'test-results',
  'playwright-report',
  '.vscode-test',
  '.impeccable',
]);
const privateDirectories = new Set([
  '.git',
  '.gcr',
  '.commit-defender',
  '.ssh',
  '.aws',
  '.azure',
  '.kube',
  '.claude',
  '.gemini',
  '.vscode',
]);
const binary = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.svg',
  '.webp',
  '.tiff',
  '.heic',
  '.avif',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.mp3',
  '.wav',
  '.aac',
  '.flac',
  '.ogg',
  '.m4a',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.jar',
  '.war',
  '.vsix',
  '.whl',
  '.tgz',
  '.pyc',
  '.pyo',
  '.pyd',
  '.class',
  '.so',
  '.dll',
  '.dylib',
  '.exe',
  '.bin',
  '.o',
  '.a',
  '.wasm',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.parquet',
  '.arrow',
  '.avro',
  '.pkl',
  '.pickle',
  '.npy',
  '.npz',
  '.lock',
]);

export class SourceCaptureError extends Error {
  constructor(
    readonly code:
      | 'source-unavailable'
      | 'snapshot-changed'
      | 'capture-limit'
      | 'invalid-source-request'
      | 'snapshot-closed',
  ) {
    super(code);
    this.name = 'SourceCaptureError';
  }
}

/** Deny patterns support *, ?, ** path components and trailing directory /. No negation. */
export function sourcePathPolicy(
  patterns: readonly string[] = [],
): (file: string) => SourceExclusionReason | undefined {
  if (!Array.isArray(patterns) || patterns.length > 128)
    throw new SourceCaptureError('invalid-source-request');
  const matchers = Array.from(patterns, (raw) => {
    if (
      typeof raw !== 'string' ||
      !raw ||
      raw.length > 512 ||
      [...raw].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || '![]\\'.includes(c))
    )
      throw new SourceCaptureError('invalid-source-request');
    const pattern = raw.replace(/^\//, '').replace(/\/$/, '');
    if (!pattern || pattern.split('/').some((part) => !part || part === '.' || part === '..'))
      throw new SourceCaptureError('invalid-source-request');
    const parts = pattern.split('/').map((part) => {
      if (part === '**') return part;
      if (part.includes('**')) throw new SourceCaptureError('invalid-source-request');
      // Greedy wildcard matching avoids regex backtracking on repository filenames.
      return (name: string): boolean => {
        let patternIndex = 0,
          nameIndex = 0,
          star = -1,
          retry = 0;
        while (nameIndex < name.length) {
          if (part[patternIndex] === '?' || part[patternIndex] === name[nameIndex]) {
            patternIndex++;
            nameIndex++;
          } else if (part[patternIndex] === '*') {
            star = patternIndex++;
            retry = nameIndex;
          } else if (star >= 0) {
            patternIndex = star + 1;
            nameIndex = ++retry;
          } else return false;
        }
        while (part[patternIndex] === '*') patternIndex++;
        return patternIndex === part.length;
      };
    });
    const anchored = raw.startsWith('/') || parts.length > 1;
    return (file: string): boolean => {
      const names = file.split('/');
      // Dynamic programming bounds wildcard work even for adversarial patterns.
      let positions = new Set(anchored ? [0] : names.map((_, index) => index));
      for (const part of parts) {
        const next = new Set<number>();
        for (const start of positions) {
          if (part === '**')
            for (let index = start; index <= names.length; index++) next.add(index);
          else if (start < names.length && part(names[start]!)) next.add(start + 1);
        }
        positions = next;
      }
      return positions.size > 0; // A matching directory also excludes descendants.
    };
  });
  return (file) => {
    try {
      sourcePath(file);
    } catch {
      return 'invalid-path';
    }
    const parts = file.toLowerCase().split('/');
    const name = parts.at(-1)!;
    if (
      parts.some((part) => privateDirectories.has(part) || part.startsWith('.codex')) ||
      /^(?:\.env(?:\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|auth\.json(?:\..*)?|credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/.test(
        name,
      ) ||
      /\.(?:env|pem|key|p12|pfx|keystore|code-workspace)$/.test(name)
    )
      return 'private-data';
    if (parts.some((part) => generated.has(part))) return 'generated';
    if (binary.has(path.posix.extname(name))) return 'binary';
    if (matchers.some((match) => match(file))) return 'user-excluded';
    return undefined;
  };
}
