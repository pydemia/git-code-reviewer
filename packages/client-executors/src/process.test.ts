import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runManagedProcess } from './process.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gcr-process-test-'));
  roots.push(root);
  return {
    command: process.execPath,
    args: [] as string[],
    cwd: root,
    env: { PATH: '/usr/bin:/bin' },
    stdin: '',
    timeoutMs: 5000,
  };
}
it('writes prompt over stdin, keeps argv literal and captures bounded streams', async () => {
  const input = await fixture();
  const result = await runManagedProcess({
    ...input,
    stdin: 'literal $() `text`',
    args: [
      '-e',
      "process.stdin.on('data', b=>process.stdout.write(b));process.stderr.write('diagnostic')",
    ],
  });
  expect(result).toEqual({ code: 0, stdout: 'literal $() `text`', stderr: 'diagnostic' });
});
it('does not start a cancelled request and reports a missing executable without raw errors', async () => {
  const input = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(runManagedProcess({ ...input, signal: controller.signal })).rejects.toMatchObject({
    code: 'cancelled',
    name: 'AbortError',
  });
  await expect(
    runManagedProcess({ ...input, command: path.join(input.cwd, 'missing-private-name') }),
  ).rejects.toMatchObject({ code: 'executable-unavailable', message: 'executable-unavailable' });
});
it('enforces a combined stdout/stderr byte limit', async () => {
  const input = await fixture();
  await expect(
    runManagedProcess({
      ...input,
      outputBytes: 100,
      args: [
        '-e',
        "process.stdout.write('x'.repeat(60));process.stderr.write('y'.repeat(60));setInterval(()=>{},1000)",
      ],
    }),
  ).rejects.toMatchObject({ code: 'output-limit' });
});

for (const trigger of ['timeout', 'cancelled', 'leader-exit'] as const) {
  it(`kills a SIGTERM-ignoring descendant on ${trigger}`, async () => {
    const input = await fixture();
    const pidFile = path.join(input.cwd, 'descendant.pid');
    const controller = new AbortController();
    const descendant =
      "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)";
    const leader = `const {spawn}=require('child_process');const fs=require('fs');process.on('SIGTERM',()=>{});const p=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','inherit']});p.stdout.once('data',()=>{fs.writeFileSync(${JSON.stringify(pidFile)},String(p.pid));${trigger === 'leader-exit' ? 'process.exit(0)' : ''}});setInterval(()=>{},1000);`;
    const run = runManagedProcess({
      ...input,
      signal: controller.signal,
      timeoutMs: trigger === 'timeout' ? 1500 : 5000,
      args: ['-e', leader],
    });
    // Attach a rejection handler before waiting for the real child readiness marker.
    const outcome = run.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let descendantPid: number | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        descendantPid = Number(await readFile(pidFile, 'utf8'));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(descendantPid).toBeGreaterThan(0);
    if (trigger === 'cancelled') controller.abort();
    const result = await outcome;
    if (trigger === 'leader-exit') expect(result).toMatchObject({ value: { code: 0 } });
    else expect(result).toMatchObject({ error: { code: trigger } });
    let exists = true;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(descendantPid!, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          exists = false;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(exists).toBe(false);
  });
}
