import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export type SourceFiles = Readonly<Record<string, string>>;
export interface ReviewFixture {
  id: string;
  language: 'python' | 'typescript' | 'python-typescript';
  variant: 'defect' | 'fixed' | 'normal' | 'counterevidence';
  expected: 'finding' | 'no-finding';
  requiredEvidence: readonly string[];
  rationale: string;
  before: SourceFiles;
  after: SourceFiles;
}

const cacheGood = `def load(ids, cache, fetch):
    found = {key: cache[key] for key in ids if key in cache}
    missing = [key for key in ids if key not in found]
    if missing:
        found.update(fetch(missing))
    return found
`;
const cacheBad = `def load(ids, cache, fetch):
    found = {key: cache[key] for key in ids if key in cache}
    if found:
        return found
    return fetch(ids)
`;
const cacheCaller = `from cache import load

def batch():
    return load(["a", "b"], {"a": 10}, lambda ids: {key: 20 for key in ids})
`;
const cacheBase = { 'cache.py': cacheGood, 'caller.py': cacheCaller };
const auth = `export interface Context { role: string }
export function requireAdmin(context: Context, next: () => boolean): boolean {
  if (context.role !== 'admin') throw new Error('forbidden');
  return next();
}
`;
const guarded = `import { requireAdmin, type Context } from './auth.js';
export function handler(context: Context): boolean {
  return requireAdmin(context, () => true);
}
`;
const unguarded = `import type { Context } from './auth.js';
export function handler(_context: Context): boolean { return true; }
`;
const directRouter = `import { handler } from './handler.js';
import type { Context } from './auth.js';
export function invoke(context: Context): boolean { return handler(context); }
`;
const authBase = { 'auth.ts': auth, 'handler.ts': guarded, 'router.ts': directRouter };
const serverV1 = `ROUTES = {"/api/v1/items": [{"id": "a"}]}
def dispatch(path):
    return (200, ROUTES[path]) if path in ROUTES else (404, None)
`;
const serverV2 = serverV1.replaceAll('/api/v1/', '/api/v2/');
const clientV1 = `export const endpoint = '/api/v1/items';
export function request(fetcher: (url: string) => unknown) { return fetcher(endpoint); }
`;
const clientV2 = clientV1.replaceAll('/api/v1/', '/api/v2/');
const deployment = '{"entrypoint":"client.ts","legacyClientEnabled":false}\n';
const apiBase = { 'server.py': serverV1, 'client.ts': clientV1, 'deployment.json': deployment };

export const reviewFixtures: readonly ReviewFixture[] = [
  ...(['defect', 'fixed', 'normal', 'counterevidence'] as const).map((variant): ReviewFixture => {
    let after: SourceFiles = cacheBase;
    if (variant === 'defect') after = { ...cacheBase, 'cache.py': cacheBad };
    if (variant === 'normal')
      after = { ...cacheBase, 'cache.py': cacheGood.replaceAll('found', 'result') };
    if (variant === 'counterevidence')
      after = {
        'cache.py': cacheBad,
        'contract.py': `def require_complete(ids, cache):\n    if set(ids) != set(cache):\n        raise ValueError("complete cache required")\n`,
        'caller.py': `from cache import load\nfrom contract import require_complete\n\ndef batch():\n    ids, cache = ["a", "b"], {"a": 10, "b": 20}\n    require_complete(ids, cache)\n    return load(ids, cache, lambda _: {})\n`,
      };
    return {
      id: `python-partial-cache-${variant}`,
      language: 'python',
      variant,
      expected: variant === 'defect' ? 'finding' : 'no-finding',
      requiredEvidence:
        variant === 'counterevidence'
          ? ['cache.py', 'caller.py', 'contract.py']
          : ['cache.py', 'caller.py'],
      rationale:
        variant === 'counterevidence'
          ? 'The only caller enforces a complete cache; do not report a missing-ID defect without contradicting that precondition.'
          : 'The caller requests a and b with only a cached; the reviewed implementation must retrieve b.',
      before: variant === 'fixed' ? { ...cacheBase, 'cache.py': cacheBad } : cacheBase,
      after,
    };
  }),
  ...(['defect', 'fixed', 'normal', 'counterevidence'] as const).map((variant): ReviewFixture => {
    let after: SourceFiles = authBase;
    if (variant === 'defect') after = { ...authBase, 'handler.ts': unguarded };
    if (variant === 'normal')
      after = {
        ...authBase,
        'handler.ts': guarded.replace('() => true', 'function remove() { return true; }'),
      };
    if (variant === 'counterevidence')
      after = {
        ...authBase,
        'handler.ts': unguarded,
        'router.ts': `import { handler } from './handler.js';\nimport { requireAdmin, type Context } from './auth.js';\nexport function invoke(context: Context): boolean {\n  return requireAdmin(context, () => handler(context));\n}\n`,
      };
    return {
      id: `typescript-delete-authorization-${variant}`,
      language: 'typescript',
      variant,
      expected: variant === 'defect' ? 'finding' : 'no-finding',
      requiredEvidence: ['auth.ts', 'handler.ts', 'router.ts'],
      rationale:
        'Check the effective router and handler chain for reader rejection; a guard moved to the router is counterevidence, not a public delete endpoint.',
      before: variant === 'fixed' ? { ...authBase, 'handler.ts': unguarded } : authBase,
      after,
    };
  }),
  ...(['defect', 'fixed', 'normal', 'counterevidence'] as const).map((variant): ReviewFixture => {
    let after: SourceFiles = { ...apiBase, 'server.py': serverV2, 'client.ts': clientV2 };
    if (variant === 'defect') after = { ...apiBase, 'server.py': serverV2 };
    if (variant === 'normal')
      after = {
        ...after,
        'server.py': serverV2.replace(
          'def dispatch',
          'ROUTES["/api/v1/items"] = ROUTES["/api/v2/items"]\ndef dispatch',
        ),
      };
    if (variant === 'counterevidence')
      after = {
        ...after,
        'retired-client.ts': clientV1,
        'migration.md':
          'The deployed entrypoint is client.ts. The retired client is retained as historical source and is disabled in deployment.json. The v1 sunset and v2 consumer transition are coordinated.\n',
      };
    return {
      id: `cross-language-api-transition-${variant}`,
      language: 'python-typescript',
      variant,
      expected: variant === 'defect' ? 'finding' : 'no-finding',
      requiredEvidence:
        variant === 'counterevidence'
          ? ['server.py', 'client.ts', 'deployment.json', 'retired-client.ts', 'migration.md']
          : ['server.py', 'client.ts', 'deployment.json'],
      rationale:
        'Follow the active TypeScript request to the Python route. A historical consumer is not proof of a current caller; verify the deployment and migration contract.',
      before: variant === 'fixed' ? { ...apiBase, 'server.py': serverV2 } : apiBase,
      after,
    };
  }),
];

const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: 'GCR Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'GCR Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};
// Never inherit the caller's alternate index or repository selection into a synthetic repository.
for (const key of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]) {
  delete (gitEnvironment as Record<string, string | undefined>)[key];
}
export function fixtureGit(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    {
      cwd,
      env: gitEnvironment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trimEnd();
}
async function writeSources(repo: string, files: SourceFiles): Promise<void> {
  for (const [name, contents] of Object.entries(files)) {
    if (
      !/^[a-zA-Z0-9_./-]+$/.test(name) ||
      name.split('/').some((part) => ['..', '.git', ''].includes(part))
    )
      throw new Error(`Invalid fixture path: ${name}`);
    await mkdir(dirname(join(repo, name)), { recursive: true });
    await writeFile(join(repo, name), contents);
  }
}
export async function createReviewFixture(id: string) {
  const definition = reviewFixtures.find((fixture) => fixture.id === id);
  if (!definition) throw new Error(`Unknown review fixture: ${id}`);
  const root = await mkdtemp(join(tmpdir(), 'gcr-review-fixture-'));
  const repo = join(root, 'repo');
  await mkdir(repo);
  fixtureGit(repo, 'init', '-b', 'main');
  await writeSources(repo, definition.before);
  fixtureGit(repo, 'add', '--all');
  fixtureGit(repo, 'commit', '-m', 'fixture baseline');
  const base = fixtureGit(repo, 'rev-parse', 'HEAD');
  const baseTree = fixtureGit(repo, 'rev-parse', 'HEAD^{tree}');
  for (const name of Object.keys(definition.before)) await rm(join(repo, name));
  await writeSources(repo, definition.after);
  fixtureGit(repo, 'add', '--all');
  const indexTree = fixtureGit(repo, 'write-tree');
  return {
    root,
    repo,
    definition,
    base,
    baseTree,
    indexTree,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export const gitScenarios = ['partial-stage', 'delete', 'rename', 'worktree', 'multi-ref'] as const;
export async function createGitScenario(scenario: (typeof gitScenarios)[number]) {
  const fixture = await createReviewFixture('typescript-delete-authorization-defect');
  const { repo, root } = fixture;
  const details: Record<string, string> = {};
  if (scenario === 'partial-stage') {
    await writeFile(
      join(repo, 'handler.ts'),
      guarded + '// TODO: this marker exists only in the working tree.\n',
    );
  } else if (scenario === 'delete') {
    fixtureGit(repo, 'rm', 'auth.ts');
  } else if (scenario === 'rename') {
    fixtureGit(repo, 'mv', 'auth.ts', 'authorization.ts');
  } else if (scenario === 'worktree') {
    details.linked = join(root, 'linked');
    fixtureGit(repo, 'worktree', 'add', '-b', 'linked', details.linked, fixture.base);
    await writeFile(join(details.linked, 'handler.ts'), guarded + '// independent linked tree\n');
    fixtureGit(details.linked, 'add', 'handler.ts');
  } else {
    fixtureGit(repo, 'commit', '-m', 'first pushed ref');
    details.first = fixtureGit(repo, 'rev-parse', 'HEAD');
    fixtureGit(repo, 'branch', 'feature-a');
    fixtureGit(repo, 'switch', '-c', 'feature-b');
    await writeFile(join(repo, 'handler.ts'), guarded);
    fixtureGit(repo, 'add', 'handler.ts');
    fixtureGit(repo, 'commit', '-m', 'second pushed ref');
    details.second = fixtureGit(repo, 'rev-parse', 'HEAD');
    details.pushInput = `refs/heads/feature-a ${details.first} refs/heads/feature-a ${fixture.base}\nrefs/heads/feature-b ${details.second} refs/heads/feature-b ${'0'.repeat(40)}\n(delete) ${'0'.repeat(40)} refs/heads/retired ${fixture.base}\n`;
  }
  return { ...fixture, details };
}
