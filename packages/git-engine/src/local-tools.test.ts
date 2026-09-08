import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, cp, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runLocalSourceTool } from './local-tools.js';
import { safeSourcePath } from './workspace.js';
import { executeSourceTool } from '../../../apps/runtime/src/services/source-workspace.js';
import { loadConfig } from '../../../apps/runtime/src/config.js';

const execute = promisify(execFile);
describe('real local Git source tools', () => {
  let root: string;
  let sha: string;
  let headSha: string;
  let mergeBaseSha: string;
  const body = 'export function unchangedRetry() {\n  return 3;\n}\n';
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'gcr-source-test-'));
    const repo = path.join(root, 'initial');
    await mkdir(repo);
    for (const args of [
      ['init', '-q'],
      ['config', 'user.name', 'Fixture'],
      ['config', 'user.email', 'fixture@example.invalid'],
    ])
      await execute('git', args, { cwd: repo });
    await writeFile(path.join(repo, 'unchanged.ts'), body);
    await writeFile(path.join(repo, 'revision.ts'), 'merge-base\n');
    await writeFile(path.join(repo, 'renamed file.ts'), 'fixture\n');
    await execute('git', ['add', '.'], { cwd: repo });
    await execute('git', ['commit', '-qm', 'initial'], { cwd: repo });
    mergeBaseSha = (await execute('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    await writeFile(path.join(repo, 'revision.ts'), 'base-tip\n');
    await execute('git', ['commit', '-qam', 'base'], { cwd: repo });
    sha = (await execute('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    await execute('git', ['checkout', '-qb', 'review', mergeBaseSha], { cwd: repo });
    await writeFile(path.join(repo, 'revision.ts'), 'head\n');
    await writeFile(path.join(repo, 'head-only.ts'), 'new implementation\n');
    await execute('git', ['add', '.'], { cwd: repo });
    await execute('git', ['commit', '-qam', 'head'], { cwd: repo });
    headSha = (await execute('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    await execute('git', ['clone', '--bare', repo, path.join(root, 'repository.git')]);
    for (const revision of ['head', 'base', 'mergeBase']) {
      await cp(repo, path.join(root, 'views', revision), { recursive: true });
      await writeFile(
        path.join(root, 'views', revision, 'revision.ts'),
        revision === 'head' ? 'head\n' : revision === 'base' ? 'base-tip\n' : 'merge-base\n',
      );
    }
    await writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({ head: headSha, base: sha, mergeBase: mergeBaseSha }),
    );
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it('reads unchanged local source with exact Git blob identity', async () => {
    const result = (await runLocalSourceTool(root, {
      name: 'read_file',
      revision: 'base',
      path: 'unchanged.ts',
    })) as { sha: string; content: string; blob: string };
    expect(result.sha).toBe(sha);
    expect(result.content).toBe(body);
    expect(result.blob).toBe(
      createHash('sha1')
        .update(`blob ${Buffer.byteLength(body)}\0${body}`)
        .digest('hex'),
    );
  });
  it.skipIf(process.platform !== 'darwin')(
    'reads actual source inside the macOS sandbox',
    async () => {
      const config = loadConfig({
        DATABASE_URL: 'postgresql://localhost/not-used',
        NODE_ENV: 'test',
      });
      expect(
        await executeSourceTool(
          config,
          { workspaceId: 'test', workspace: root },
          { name: 'read_file', revision: 'base', path: 'unchanged.ts' },
        ),
      ).toMatchObject({ sha, content: body });
    },
  );
  it('searches actual unchanged file contents', async () => {
    expect(
      await runLocalSourceTool(root, { name: 'search_code', query: 'unchangedRetry' }),
    ).toMatchObject({ matches: [{ path: 'unchanged.ts', line: 1 }] });
  });
  it('distinguishes base tip, merge-base and head even after branch movement', async () => {
    await execute('git', [
      '--git-dir',
      path.join(root, 'repository.git'),
      'update-ref',
      'refs/heads/review',
      sha,
    ]);
    for (const [revision, content, expectedSha] of [
      ['base', 'base-tip\n', sha],
      ['mergeBase', 'merge-base\n', mergeBaseSha],
      ['head', 'head\n', headSha],
    ])
      expect(
        await runLocalSourceTool(root, { name: 'read_file', revision, path: 'revision.ts' }),
      ).toMatchObject({ sha: expectedSha, content });
  });
  it('reports an added file as absent in base rather than a source access failure', async () => {
    expect(
      await runLocalSourceTool(root, { name: 'read_file', revision: 'base', path: 'head-only.ts' }),
    ).toEqual({
      revision: 'base',
      sha,
      path: 'head-only.ts',
      exists: false,
      reason: 'path_not_present_in_revision',
    });
    expect(
      await runLocalSourceTool(root, { name: 'read_file', revision: 'head', path: 'head-only.ts' }),
    ).toMatchObject({ sha: headSha, content: 'new implementation\n' });
  });
  it('supports spaces without interpreting paths as options', async () => {
    expect(
      await runLocalSourceTool(root, { name: 'read_file', path: 'renamed file.ts' }),
    ).toMatchObject({ content: 'fixture\n' });
  });
  it.each([
    '../secret',
    '/etc/passwd',
    'a/../../secret',
    '.git/config',
    'a/.git/config',
    'a\\b',
    'a\u0000b',
  ])('rejects path escape %s', async (value) => {
    expect(() => safeSourcePath(value)).toThrow();
    await expect(runLocalSourceTool(root, { name: 'read_file', path: value })).rejects.toThrow();
  });
  it('rejects arbitrary commands and mutable revisions', async () => {
    await expect(runLocalSourceTool(root, { name: 'bash', query: 'pwd' })).rejects.toThrow(
      'tool_not_allowed',
    );
    await expect(
      runLocalSourceTool(root, { name: 'list_files', revision: 'main' }),
    ).rejects.toThrow('invalid_revision');
  });
  it('detects modified local content rather than citing it as a Git blob', async () => {
    await writeFile(path.join(root, 'views/head/unchanged.ts'), 'tampered');
    await expect(
      runLocalSourceTool(root, { name: 'read_file', path: 'unchanged.ts' }),
    ).rejects.toThrow('source_blob_mismatch');
  });
  it('does not follow a symlink to another workspace', async () => {
    const target = path.join(root, 'views/head/renamed file.ts');
    await rm(target);
    await symlink('/etc/passwd', target);
    await expect(
      runLocalSourceTool(root, { name: 'read_file', path: 'renamed file.ts' }),
    ).rejects.toThrow('source_path_escape');
  });
});
