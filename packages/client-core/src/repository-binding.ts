import { execFileSync } from 'node:child_process';
import { centralRepositoryIdentity } from '@gcr/client-contract';
import { contentHash } from './local-identity.js';
import { KnowledgeSyncError } from './central-binding.js';

const mismatch = () =>
  new KnowledgeSyncError(
    'repository-mismatch',
    'Git remotes do not match the selected central repository. Check the repository and reconnect.',
  );

/** GitHub repository identity only. Credentials, queries and fragments never leave this parser. */
export function canonicalRepositoryRemote(raw: string): string | null {
  try {
    if (!raw || raw.length > 8192 || /[\s\\]/.test(raw)) return null;
    let value = raw;
    if (!value.includes('://')) {
      const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(value);
      if (!scp || scp[2]!.startsWith('/')) return null;
      value = `ssh://${scp[1]}/${scp[2]}`;
    }
    const rawPath = /^[a-z]+:\/\/[^/?#]+([^?#]*)/i.exec(value)?.[1];
    if (!rawPath) return null;
    const parts = rawPath.split('/').slice(1);
    if (parts.at(-1) === '') parts.pop();
    if (parts.some((x) => !x)) return null;
    const segments = parts.map(decodeURIComponent);
    if (
      segments.some(
        (x) =>
          x === '.' ||
          x === '..' ||
          /[\s/\\?#]/.test(x) ||
          Array.from(x).some((c) => c.charCodeAt(0) < 32),
      )
    )
      return null;
    const url = new URL(value);
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || segments.length < 2) return null;
    const port = url.protocol === 'ssh:' && url.port === '22' ? '' : url.port;
    const last = segments.at(-1)!.replace(/\.git$/i, '');
    if (!last) return null;
    segments[segments.length - 1] = last;
    return `${url.hostname.toLowerCase()}${port ? ':' + port : ''}/${segments.join('/').toLowerCase()}`;
  } catch {
    return null;
  }
}

/** Read effective fetch URLs, including insteadOf rewrites, without invoking a remote helper. */
export function localRepositoryRemotes(root: string): Array<{ name: string; canonical: string }> {
  const git = (args: string[]) => {
    try {
      return execFileSync('git', ['-C', root, '--no-optional-locks', ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      });
    } catch {
      throw mismatch();
    }
  };
  const names = git(['remote']).trim().split('\n').filter(Boolean);
  if (names.length > 100) throw mismatch();
  return names
    .flatMap((name) => {
      if (!/^[a-zA-Z0-9._/-]+$/.test(name) || name.startsWith('-')) throw mismatch();
      return git(['remote', 'get-url', '--all', '--', name])
        .trim()
        .split('\n')
        .map((url) => ({
          name,
          canonical: canonicalRepositoryRemote(url) ?? 'unsupported',
        }));
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.canonical.localeCompare(b.canonical));
}

export function repositoryBinding(
  identity: unknown,
  remotes: ReturnType<typeof localRepositoryRemotes>,
) {
  const checked = centralRepositoryIdentity(identity);
  const base = new URL(checked.webBaseUrl);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !['https:', 'http:'].includes(base.protocol) ||
    !/^[a-zA-Z0-9_.-]+$/.test(checked.owner) ||
    !/^[a-zA-Z0-9_.-]+$/.test(checked.name)
  )
    throw mismatch();
  const expected = canonicalRepositoryRemote(
    `${base.href.replace(/\/$/, '')}/${checked.owner}/${checked.name}`,
  );
  if (!expected || !remotes.some((remote) => remote.canonical === expected)) throw mismatch();
  return { identity: checked, remotesHash: contentHash(remotes) };
}

export function assertRepositoryBinding(
  binding: ReturnType<typeof repositoryBinding>,
  root?: string,
) {
  if (
    !root ||
    repositoryBinding(binding.identity, localRepositoryRemotes(root)).remotesHash !==
      binding.remotesHash
  )
    throw mismatch();
}
