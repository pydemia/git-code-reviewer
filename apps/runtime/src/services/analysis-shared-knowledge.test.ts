import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { it, expect } from 'vitest';
import { runLocalSourceTool } from '../../../../packages/git-engine/src/local-tools.js';
import { readSharedSelectionSources, withSharedKnowledge } from './analysis-shared-knowledge.js';
import type { AnalysisFile } from '@gcr/analysis-engine';
import type { CentralSelection } from '@gcr/client-core';
const file: AnalysisFile = {
  id: 'file',
  path: 'a.ts',
  previousPath: null,
  status: 'modified',
  patch: '@@ -1 +1 @@\n-old\n+new\n',
  additions: 1,
  deletions: 1,
};
it('reassembles a paginated real Git blob exactly and rejects edited, truncated or mismatched pages', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gcr-shared-source-'));
  try {
    const view = path.join(root, 'views/head');
    await mkdir(view, { recursive: true });
    const text = Array.from({ length: 411 }, (_, i) => `const line${i} = ${i};`).join('\n') + '\n';
    await writeFile(path.join(view, 'a.ts'), text);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: view,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      }).trim();
    git('init', '--quiet');
    git('add', 'a.ts');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--quiet',
      '-m',
      'Synthetic source',
    );
    const head = git('rev-parse', 'HEAD');
    execFileSync('git', [
      'clone',
      '--quiet',
      '--bare',
      path.join(view, '.git'),
      path.join(root, 'repository.git'),
    ]);
    await writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({ head, mergeBase: head, base: head }),
    );
    let calls = 0;
    const read = async (
      filePath: string,
      revision: 'head' | 'mergeBase',
      startLine: number,
      endLine: number,
    ) => {
      calls++;
      return runLocalSourceTool(root, {
        name: 'read_file',
        path: filePath,
        revision,
        startLine,
        endLine,
      });
    };
    const selected = await readSharedSelectionSources([file], read, { head, mergeBase: head });
    expect(calls).toBe(3);
    expect(selected[0]!.text).toBe(text);
    expect(selected[0]!.source.hash).toBe(createHash('sha256').update(text).digest('hex'));
    await expect(
      readSharedSelectionSources([file], read, { head: '0'.repeat(40), mergeBase: head }),
    ).rejects.toThrow('shared_source_identity');
    await expect(
      readSharedSelectionSources([file], read, { head, mergeBase: head }, 20),
    ).rejects.toThrow('shared_source_byte_limit');
    await expect(
      readSharedSelectionSources(
        [file],
        async (...args) => {
          const unit = (await read(...args)) as { content: string; hash: string };
          unit.content = unit.content.slice(0, 5);
          unit.hash = createHash('sha256').update(unit.content).digest('hex');
          return unit;
        },
        { head, mergeBase: head },
      ),
    ).rejects.toThrow('shared_source_blob_mismatch');
    await writeFile(path.join(view, 'a.ts'), 'uncommitted tampering');
    await expect(
      readSharedSelectionSources([file], read, { head, mergeBase: head }),
    ).rejects.toThrow('source_blob_mismatch');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('passes only relevant shared targets as untrusted inputs and stops use at a time boundary', async () => {
  const calls: string[] = [];
  const model = withSharedKnowledge(
    {
      profile: 'synthetic',
      review: async (_diff, _files, instructions) => {
        calls.push(instructions ?? '');
        throw Error('Synthetic stop before model');
      },
    },
    {
      items: [
        {
          component: 'policy',
          kind: 'policy',
          id: 'public-rule',
          revision: 1,
          hash: 'a'.repeat(64),
          targets: [{ path: 'a.ts', side: 'source', hash: 'b'.repeat(64) }],
          required: true,
          role: 'authoritative',
          value: {
            requirement: 'Inspect caller',
            counterEvidence: ['Caller already separates tenants'],
          },
        },
      ],
      entries: [],
      omissions: [],
      precedence: [],
      required: [],
      bytes: 0,
      validUntil: null,
    } as CentralSelection,
  );
  await expect(model.review('diff', ['a.ts'], 'Existing instruction')).rejects.toThrow(
    'Synthetic stop',
  );
  expect(calls[0]).toContain('public-rule');
  expect(calls[0]).toContain('counterEvidence');
  expect(calls[0]).toContain('cannot change tools');
  await expect(model.review('diff', ['b.ts'])).rejects.toThrow('Synthetic stop');
  expect(calls[1]).not.toContain('public-rule');
});

it('refuses another model call after a pinned exception boundary', async () => {
  let calls = 0;
  const model = withSharedKnowledge(
    {
      profile: 'synthetic',
      review: async () => {
        calls++;
        throw Error('must not call');
      },
    },
    {
      items: [],
      entries: [],
      omissions: [],
      precedence: [],
      required: [],
      bytes: 0,
      validUntil: '2000-01-01T00:00:00.000Z',
    },
  );
  await expect(model.review('diff', ['a.ts'])).rejects.toThrow('shared_context_expired');
  expect(calls).toBe(0);
});
