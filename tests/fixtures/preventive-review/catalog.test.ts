import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  createGitScenario,
  createReviewFixture,
  fixtureGit,
  reviewFixtures,
  type SourceFiles,
} from './catalog.js';

async function compileTypescript(root: string, files: SourceFiles) {
  const dir = join(root, 'runtime');
  await mkdir(dir);
  await writeFile(join(dir, 'package.json'), '{"type":"module"}\n');
  for (const [name, source] of Object.entries(files)) {
    if (!name.endsWith('.ts')) continue;
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    });
    await writeFile(join(dir, name.replace(/\.ts$/, '.js')), compiled.outputText);
  }
  return dir;
}

describe('synthetic review evaluation corpus', () => {
  it('pins source trees and expected judgments independently of any model output', async () => {
    const actual = [];
    for (const definition of reviewFixtures) {
      const fixture = await createReviewFixture(definition.id);
      try {
        for (const file of definition.requiredEvidence)
          expect(definition.after[file]).toBeDefined();
        expect(fixtureGit(fixture.repo, 'diff', '--cached', '--name-only')).not.toBe('');
        actual.push({
          id: definition.id,
          expected: definition.expected,
          baseTree: fixture.baseTree,
          indexTree: fixture.indexTree,
          definitionSha256: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
        });
      } finally {
        await fixture.cleanup();
      }
    }
    const file = new URL('./manifest.json', import.meta.url);
    if (process.env.GCR_UPDATE_FIXTURE_MANIFEST === '1')
      await writeFile(file, JSON.stringify(actual, null, 2) + '\n');
    expect(actual).toEqual(JSON.parse(await readFile(file, 'utf8')));
  }, 30_000);

  for (const definition of reviewFixtures) {
    it(`${definition.id}: observed behavior agrees with the fixture label`, async () => {
      const fixture = await createReviewFixture(definition.id);
      try {
        if (definition.language === 'python') {
          const result = JSON.parse(
            execFileSync(
              'python3',
              ['-c', 'import json; from caller import batch; print(json.dumps(batch()))'],
              { cwd: fixture.repo, encoding: 'utf8' },
            ),
          );
          expect(result).toEqual(definition.expected === 'finding' ? { a: 10 } : { a: 10, b: 20 });
        } else if (definition.language === 'typescript') {
          const runtime = await compileTypescript(fixture.root, definition.after);
          const { invoke } = await import(
            /* @vite-ignore */ pathToFileURL(join(runtime, 'router.js')).href
          );
          expect(invoke({ role: 'admin' })).toBe(true);
          if (definition.expected === 'finding') expect(invoke({ role: 'reader' })).toBe(true);
          else expect(() => invoke({ role: 'reader' })).toThrow('forbidden');
        } else {
          const runtime = await compileTypescript(fixture.root, definition.after);
          const { request } = await import(
            /* @vite-ignore */ pathToFileURL(join(runtime, 'client.js')).href
          );
          const endpoint = request((url: string) => url);
          const result = JSON.parse(
            execFileSync(
              'python3',
              [
                '-c',
                'import json, sys; from server import dispatch; print(json.dumps(dispatch(sys.argv[1])))',
                endpoint,
              ],
              { cwd: fixture.repo, encoding: 'utf8' },
            ),
          );
          expect(result[0]).toBe(definition.expected === 'finding' ? 404 : 200);
          if (definition.variant === 'counterevidence') {
            const deploy = JSON.parse(definition.after['deployment.json']!);
            expect(deploy.entrypoint).toBe('client.ts');
            expect(deploy.legacyClientEnabled).toBe(false);
          }
        }
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

describe('Git inputs needed by snapshot and trigger implementations', () => {
  it('keeps the staged defect when the working tree fixes it and adds a TODO', async () => {
    const fixture = await createGitScenario('partial-stage');
    try {
      expect(fixtureGit(fixture.repo, 'show', ':handler.ts')).not.toContain('requireAdmin');
      expect(await readFile(join(fixture.repo, 'handler.ts'), 'utf8')).toContain('TODO');
      expect(fixtureGit(fixture.repo, 'write-tree')).toBe(fixture.indexTree);
    } finally {
      await fixture.cleanup();
    }
  });
  it.each(['delete', 'rename'] as const)(
    'preserves the %s event and the unchanged consumer',
    async (scenario) => {
      const fixture = await createGitScenario(scenario);
      try {
        const diff = fixtureGit(fixture.repo, 'diff', '--cached', '--name-status', '-M');
        expect(diff).toContain(
          scenario === 'delete' ? 'D\tauth.ts' : 'R100\tauth.ts\tauthorization.ts',
        );
        expect(fixtureGit(fixture.repo, 'show', ':router.ts')).toContain('./auth.js');
      } finally {
        await fixture.cleanup();
      }
    },
  );
  it('uses separate indexes in worktrees with a shared Git directory', async () => {
    const fixture = await createGitScenario('worktree');
    try {
      const linked = fixture.details.linked!;
      expect(
        fixtureGit(fixture.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
      ).toBe(fixtureGit(linked, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
      expect(fixtureGit(linked, 'write-tree')).not.toBe(fixtureGit(fixture.repo, 'write-tree'));
    } finally {
      await fixture.cleanup();
    }
  });
  it('describes two pushed refs and a deleted ref without assuming the checkout is the push', async () => {
    const fixture = await createGitScenario('multi-ref');
    try {
      expect(fixture.details.first).not.toBe(fixture.details.second);
      expect(fixtureGit(fixture.repo, 'rev-parse', 'feature-a')).toBe(fixture.details.first);
      expect(fixtureGit(fixture.repo, 'rev-parse', 'feature-b')).toBe(fixture.details.second);
      expect(fixture.details.pushInput!.trim().split('\n')).toHaveLength(3);
      expect(fixture.details.pushInput).toContain(`(delete) ${'0'.repeat(40)}`);
    } finally {
      await fixture.cleanup();
    }
  });
});
