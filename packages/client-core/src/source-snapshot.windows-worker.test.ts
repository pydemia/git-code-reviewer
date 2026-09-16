import { Worker } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'win32')(
  'captures staged source inside a Windows worker with Path casing',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'w01-worker-'));
    let worker: Worker | undefined;
    try {
      const git = (...args: string[]) =>
        execFileSync(
          'git',
          [
            '-C',
            root,
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.invalid',
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'commit.gpgsign=false',
            ...args,
          ],
          { stdio: 'pipe', windowsHide: true },
        );
      git('init', '-b', 'main');
      await writeFile(path.join(root, 'sum.ts'), 'export const total = 5;\r\n');
      git('add', '.');
      git('commit', '-m', 'fixture');
      await writeFile(path.join(root, 'sum.ts'), 'export const total = -5;\r\n');
      git('add', '.');
      const env = Object.fromEntries(
        Object.entries(process.env).map(([key, value]) => [
          key.toLowerCase() === 'path'
            ? 'Path'
            : key.toLowerCase() === 'systemroot'
              ? 'sYsTeMrOoT'
              : key,
          value,
        ]),
      );
      worker = new Worker(
        `const {parentPort,workerData}=require('node:worker_threads');
      import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)}).then(({captureLocalSource})=>{
        const source=captureLocalSource({cwd:workerData,kind:'index',paths:['sum.ts']});
        try { parentPort.postMessage({selected:source.selected,pathUppercasePresent:!!process.env.PATH}); }
        finally { source.close(); }
      });`,
        { eval: true, workerData: root, env },
      );
      const observed = await new Promise<{ selected: unknown[]; pathUppercasePresent: boolean }>(
        (resolve, reject) => {
          worker!.once('message', resolve);
          worker!.once('error', reject);
        },
      );
      expect(observed.pathUppercasePresent).toBe(false);
      expect(observed.selected).toHaveLength(1);
    } finally {
      await worker?.terminate();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
