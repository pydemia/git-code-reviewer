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
    await writeFile(path.join(repo, 'renamed file.ts'), 'fixture\n');
    await execute('git', ['add', '.'], { cwd: repo });
    await execute('git', ['commit', '-qm', 'initial'], { cwd: repo });
    sha = (await execute('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    await execute('git', ['clone', '--bare', repo, path.join(root, 'repository.git')]);
    for (const revision of ['head', 'base', 'mergeBase'])
      await cp(repo, path.join(root, 'views', revision), { recursive: true });
    await writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({ head: sha, base: sha, mergeBase: sha }),
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
