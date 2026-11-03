import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  canonicalRepositoryRemote,
  repositoryBinding,
  localRepositoryRemotes,
  assertRepositoryBinding,
} from './repository-binding.js';
const identity = {
  schemaVersion: 1,
  serverId: 'server',
  tenantId: 'tenant',
  repositoryId: 'repo',
  instanceId: 'instance',
  webBaseUrl: 'https://github.example',
  owner: 'team',
  name: 'reviewer',
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('local Git remote binding', () => {
  it.each([
    'https://user:PRIVATE_TOKEN@GitHub.Example/Team/Reviewer.git?token=PRIVATE_QUERY#private',
    'git@github.example:team/reviewer.git',
    'ssh://git@github.example:22/team/reviewer.git',
  ])('matches transport forms without retaining credentials: %s', (input) => {
    const canonical = canonicalRepositoryRemote(input);
    expect(canonical).toBe('github.example/team/reviewer');
    expect(
      JSON.stringify(repositoryBinding(identity, [{ name: 'origin', canonical: canonical! }])),
    ).not.toContain('PRIVATE');
  });
  it.each([
    'https://github.example/team/../reviewer',
    'https://github.example/team/%2Fother',
    'https://github.example//team/reviewer',
    'file:///team/reviewer',
    '/tmp/team/reviewer',
    'ext::dangerous command',
    'https://github.example/team/%00reviewer',
  ])('does not infer unsupported or ambiguous identity: %s', (input) => {
    expect(canonicalRepositoryRemote(input)).toBeNull();
  });
  it('separates forks, hosts, nonstandard ports and installation prefixes', () => {
    for (const url of [
      'https://another.example/team/reviewer',
      'https://github.example/fork/reviewer',
      'https://github.example:8443/team/reviewer',
      'https://github.example/ghe/team/reviewer',
    ])
      expect(() =>
        repositoryBinding(identity, [
          { name: 'origin', canonical: canonicalRepositoryRemote(url)! },
        ]),
      ).toThrowError(/do not match/);
    expect(() =>
      repositoryBinding({ ...identity, webBaseUrl: 'https://github.example/ghe' }, [
        { name: 'origin', canonical: 'github.example/ghe/team/reviewer' },
      ]),
    ).not.toThrow();
  });
  it('reads effective URLs and rejects later remote changes without using a network helper', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gcr-remote-binding-'));
    roots.push(root);
    const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    git(['init', '-q']);
    expect(localRepositoryRemotes(root)).toEqual([]);
    git(['config', 'url.https://github.example/.insteadOf', 'work:']);
    git(['remote', 'add', 'origin', 'work:team/reviewer.git']);
    git(['remote', 'add', 'upstream', 'git@another.example:team/reviewer.git']);
    const remotes = localRepositoryRemotes(root);
    expect(remotes[0]).toEqual({ name: 'origin', canonical: 'github.example/team/reviewer' });
    const binding = repositoryBinding(identity, remotes);
    expect(() => assertRepositoryBinding(binding, root)).not.toThrow();
    git([
      'remote',
      'set-url',
      'origin',
      'https://rotated:PRIVATE@github.example/team/reviewer.git',
    ]);
    expect(() => assertRepositoryBinding(binding, root)).not.toThrow();
    git(['remote', 'set-url', 'origin', 'git@github.example:fork/reviewer.git']);
    expect(() => assertRepositoryBinding(binding, root)).toThrowError(/do not match/);
    expect(() => assertRepositoryBinding(binding)).toThrowError(/do not match/);
  });
});
