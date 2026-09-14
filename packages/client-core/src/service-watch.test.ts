import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { ServiceJobs, type ServiceReviewOptions } from './service-jobs.js';
import { ServiceWatcher, type WatchTrigger } from './service-watch.js';
import { captureLocalSource, restoreLocalSource } from './source-snapshot.js';
import { observeAutomaticFile } from './automatic-source.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gcr-watch-')),
    repo = path.join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      {
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      },
    );
  const write = (file: string, text: string) => writeFileSync(path.join(repo, file), text);
  git('init', '-b', 'main');
  write('a.ts', 'export const a=1;\n');
  write('b.ts', 'export const b=1;\n');
  git('add', '.');
  git('commit', '-m', 'base');
  const secrets = new Map<string, Buffer>();
  const storage = {
    scope: { kind: 'profile' as const, profileId: 'watch-test' },
    dataDirectory: path.join(root, 'data'),
    keys: {
      read: async (id: string) => {
        const key = secrets.get(id);
        return key ? Buffer.from(key) : undefined;
      },
      write: async (id: string, value: Uint8Array) => {
        secrets.set(id, Buffer.from(value));
      },
      remove: async (id: string) => {
        secrets.delete(id);
      },
    },
  };
  let jobs = await ServiceJobs.open(storage),
    owner = await jobs.acquireOwner(),
    now = Date.now();
  const options: ServiceReviewOptions = {
    mode: 'standalone',
    model: 'gpt-6-astra',
    reasoningEffort: 'xhigh',
    allowPaths: ['**'],
    excludePatterns: ['excluded.ts'],
    durationMs: 120000,
    sourceBytes: 1048576,
    toolCalls: 100,
  };
  const reg = await jobs.register(repo, ['stage', 'save', 'commit'], options);
  const make = () =>
    new ServiceWatcher({
      jobs,
      serial: (work) => work(),
      cancel: (id) => jobs.cancel(id),
      wake() {},
      now: () => now,
    });
  let watcher = make();
  cleanups.push(async () => {
    await watcher.close();
    try {
      await jobs.releaseOwner(owner);
    } finally {
      jobs.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  return {
    repo,
    root,
    git,
    write,
    reg,
    options,
    get jobs() {
      return jobs;
    },
    get watcher() {
      return watcher;
    },
    get owner() {
      return owner;
    },
    advance: (ms = 3000) => {
      now += ms;
    },
    start: (triggers: WatchTrigger[] = ['stage']) =>
      watcher.configure(reg, { triggers, externalChanges: true }),
    restart: async () => {
      await watcher.close();
      await jobs.releaseOwner(owner);
      jobs.close();
      jobs = await ServiceJobs.open(storage);
      owner = await jobs.acquireOwner();
      await jobs.recover(owner);
      watcher = make();
    },
  };
}
it('requires explicit grants and external Save permission, then baselines existing edits', async () => {
  const f = await fixture();
  expect(await f.jobs.watches()).toEqual([]);
  await expect(f.watcher.configure(f.reg, { triggers: ['save'] })).rejects.toMatchObject({
    code: 'service-denied',
  });
  await expect(f.watcher.configure(f.reg, { triggers: ['push'] })).rejects.toMatchObject({
    code: 'service-invalid',
  });
  const denied = await f.jobs.register(f.repo, ['commit'], f.options);
  await expect(f.watcher.configure(denied, { triggers: ['stage'] })).rejects.toMatchObject({
    code: 'service-denied',
  });
  const reg = await f.jobs.register(f.repo, ['stage'], f.options);
  f.write('a.ts', 'export const before=2;\n');
  f.git('add', 'a.ts');
  await f.watcher.configure(reg, { triggers: ['stage'] });
  f.advance();
  await f.watcher.poll();
  expect(await f.jobs.list()).toEqual([]);
}, 20000);
it('debounces Stage, survives pending restart, and captures the index independently of working bytes', async () => {
  const f = await fixture();
  await f.start();
  f.write('a.ts', 'export const staged=2;\n');
  f.git('add', 'a.ts');
  f.write('a.ts', 'export const working=3;\n');
  await f.watcher.poll();
  expect(await f.jobs.list()).toEqual([]);
  await f.start(); // Repeating the same explicit start must retain the pending observation.
  await f.restart();
  f.advance();
  await f.watcher.poll();
  const [job] = await f.jobs.list();
  expect(job).toMatchObject({ trigger: 'stage', state: 'queued', watch: true });
  const next = await f.jobs.next(f.owner);
  const snapshot = restoreLocalSource(next!.source);
  try {
    expect(snapshot.readFile('a.ts')).toMatchObject({
      status: 'available',
      text: 'export const staged=2;\n',
    });
  } finally {
    snapshot.close();
  }
  await f.jobs.finish(job!.id, f.owner, { exitCode: 0, status: 'completed' });
  f.write('a.ts', 'export const staged=2;\n');
  f.git('update-index', '--refresh');
  f.advance();
  await f.watcher.poll();
  expect(await f.jobs.list()).toHaveLength(1);
}, 30000);
it('merges external writes, includes permitted new files, and retains the Save interval across restart', async () => {
  const f = await fixture();
  await f.start(['save']);
  f.write('new.ts', 'export const fresh=1;\n');
  f.write('.env', 'PRIVATE');
  f.write('excluded.ts', 'PRIVATE');
  await f.watcher.poll();
  f.write('a.ts', 'export const a=2;\n');
  await f.watcher.poll();
  f.advance();
  await f.watcher.poll();
  const next = await f.jobs.next(f.owner);
  expect(next!.source.selected.map((c) => c.path).sort()).toEqual(['a.ts', 'new.ts']);
  expect(next!.source.files.some((file) => file.text.includes('PRIVATE'))).toBe(false);
  await f.jobs.finish(next!.job.id, f.owner, { exitCode: 0, status: 'completed' });
  f.write('b.ts', 'export const b=2;\n');
  await f.watcher.poll();
  await f.restart();
  f.advance();
  await f.watcher.poll();
  expect(await f.jobs.list()).toHaveLength(1);
  f.advance(600000);
  await f.watcher.poll();
  expect(await f.jobs.list()).toHaveLength(2);
}, 30000);
it('whole-file unstage and returning to base withdraw pending work without a review', async () => {
  const f = await fixture();
  await f.start(['stage', 'save']);
  f.write('a.ts', 'export const a=2;\n');
  f.git('add', 'a.ts');
  await f.watcher.poll();
  f.git('restore', '--staged', 'a.ts');
  f.write('a.ts', 'export const a=1;\n');
  await f.watcher.poll();
  f.advance(600000);
  await f.watcher.poll();
  expect(await f.jobs.list()).toEqual([]);
}, 30000);
it('replays the identical durable intent after a lost acknowledgement and never retries an interrupted model', async () => {
  const f = await fixture();
  await f.start();
  f.write('a.ts', 'export const a=2;\n');
  f.git('add', 'a.ts');
  await f.watcher.poll();
  f.advance();
  const original = f.jobs.writeWatch.bind(f.jobs);
  let failed = false;
  const failure = vi.spyOn(f.jobs, 'writeWatch').mockImplementation(async (state) => {
    if (state.receiptId && !state.intent && !failed) {
      failed = true;
      throw Error('lost acknowledgement');
    }
    return original(state);
  });
  await f.watcher.poll();
  failure.mockRestore();
  expect(await f.jobs.list()).toHaveLength(1);
  expect((await f.jobs.watch(f.reg.key, 'stage'))?.intent).toBeDefined();
  await f.restart();
  await f.watcher.poll();
  expect(await f.jobs.list()).toHaveLength(1);
  expect((await f.jobs.watch(f.reg.key, 'stage'))?.intent).toBeUndefined();
  await f.jobs.next(f.owner);
  await f.restart();
  f.advance(600000);
  await f.watcher.poll();
  expect(await f.jobs.list()).toEqual([expect.objectContaining({ state: 'interrupted' })]);
}, 30000);
it('cancels superseded inputs and creates a new receipt when A returns after B', async () => {
  const f = await fixture();
  await f.start();
  for (const version of [2, 3, 2]) {
    f.write('a.ts', `export const a=${version};\n`);
    f.git('add', 'a.ts');
    await f.watcher.poll();
    f.advance();
    await f.watcher.poll();
  }
  const jobs = await f.jobs.list();
  expect(jobs).toHaveLength(3);
  expect(jobs.filter((j) => j.state === 'cancelled')).toHaveLength(2);
  const queued = jobs.find((j) => j.state === 'queued')!;
  expect(jobs.some((j) => j.id !== queued.id && j.sourceHash === queued.sourceHash)).toBe(true);
}, 30000);
it('persists stop before cancellation and prevents queued watch jobs escaping while unrelated hooks remain runnable', async () => {
  const f = await fixture();
  await f.start();
  f.write('a.ts', 'export const a=2;\n');
  f.git('add', 'a.ts');
  await f.watcher.poll();
  f.advance();
  await f.watcher.poll();
  const snapshot = captureLocalSource({
    cwd: f.repo,
    kind: 'index',
    excludePatterns: f.options.excludePatterns,
  });
  const hook = await f.jobs.submit({
    id: randomUUID(),
    repository: f.reg.key,
    registrationRevision: f.reg.revision,
    trigger: 'commit',
    source: snapshot.freeze(),
  });
  snapshot.close();
  const cancel = vi.spyOn(f.jobs, 'cancel').mockRejectedValueOnce(Error('crash after revocation'));
  await expect(f.watcher.disable(f.reg.key)).rejects.toThrow();
  cancel.mockRestore();
  await f.restart();
  const next = await f.jobs.next(f.owner);
  expect(next!.job.id).toBe(hook.id);
  await f.jobs.finish(hook.id, f.owner, { exitCode: 0, status: 'completed' });
  await f.watcher.poll();
  expect((await f.jobs.list()).find((j) => j.watch)?.state).toBe('cancelled');
  expect((await f.watcher.status(f.reg.key))[0]?.enabled).toBe(false);
}, 30000);
it('invalidates watches on registration revision changes and requires a fresh baseline to restart', async () => {
  const f = await fixture();
  await f.start();
  f.write('a.ts', 'export const a=2;\n');
  f.git('add', 'a.ts');
  await f.watcher.poll();
  const reg = await f.jobs.register(f.repo, ['stage'], f.options);
  f.advance();
  await f.watcher.poll();
  expect((await f.watcher.status(f.reg.key))[0]?.enabled).toBe(false);
  await f.watcher.configure(reg, { triggers: ['stage'] });
  f.advance();
  await f.watcher.poll();
  expect(await f.jobs.list()).toEqual([]);
}, 20000);

it('does not reinterpret rejected Auto Save as an external write even when polling precedes the editor event', async () => {
  const f = await fixture(),
    id = randomUUID();
  await f.watcher.configure(f.reg, {
    triggers: ['save'],
    externalChanges: true,
    editor: { id, pid: process.pid, autoSave: false },
  });
  f.write('a.ts', 'export const auto=2;\n');
  await f.watcher.poll();
  const hash = (await observeAutomaticFile(f.repo, 'a.ts'))!.hash;
  expect(
    await f.watcher.editorSave(f.reg, { sessionId: id, file: 'a.ts', hash, reason: 'auto' }),
  ).toEqual({ status: 'suppressed' });
  expect(
    await f.watcher.editorSave(f.reg, { sessionId: id, file: 'a.ts', hash, reason: 'external' }),
  ).toEqual({ status: 'unchanged' });
  f.advance(600000);
  await f.watcher.poll();
  await f.restart();
  await f.watcher.poll();
  expect(await f.jobs.list()).toEqual([]);
  await expect(
    f.watcher.editorSave(f.reg, { sessionId: randomUUID(), file: 'a.ts', hash, reason: 'manual' }),
  ).rejects.toMatchObject({ code: 'service-denied' });
}, 30000);

it('accepts a manual Save, cancels it on typing, and rejects an obsolete file hash', async () => {
  const f = await fixture(),
    id = randomUUID();
  await f.watcher.configure(f.reg, {
    triggers: ['save'],
    externalChanges: false,
    editor: { id, pid: process.pid, autoSave: false },
  });
  f.write('a.ts', 'export const manual=2;\n');
  const hash = (await observeAutomaticFile(f.repo, 'a.ts'))!.hash;
  expect(
    await f.watcher.editorSave(f.reg, { sessionId: id, file: 'a.ts', hash, reason: 'manual' }),
  ).toEqual({ status: 'pending' });
  await f.watcher.poll();
  f.advance();
  await f.watcher.poll();
  expect(await f.jobs.list()).toEqual([expect.objectContaining({ state: 'queued' })]);
  await f.watcher.editorSave(f.reg, { sessionId: id, file: 'a.ts', reason: 'dirty' });
  expect(await f.jobs.next(f.owner)).toBeUndefined();
  f.write('a.ts', 'export const later=3;\n');
  expect(
    await f.watcher.editorSave(f.reg, { sessionId: id, file: 'a.ts', hash, reason: 'manual' }),
  ).toEqual({ status: 'superseded' });
  await f.watcher.poll();
  f.advance(600000);
  await f.watcher.poll();
  expect(await f.jobs.list()).toEqual([expect.objectContaining({ state: 'cancelled' })]);
}, 30000);

it('keeps two editor sessions guarded until the last clean detach, then reviews subsequent external writes', async () => {
  const f = await fixture(),
    first = randomUUID(),
    second = randomUUID();
  for (const id of [first, second])
    await f.watcher.configure(f.reg, {
      triggers: ['save'],
      externalChanges: true,
      editor: { id, pid: process.pid, autoSave: false },
    });
  await f.watcher.detachEditor(f.reg, first);
  f.write('a.ts', 'export const unclassified=2;\n');
  await f.watcher.poll();
  f.advance();
  await f.watcher.poll();
  expect(await f.jobs.list()).toEqual([]);
  expect((await f.watcher.status(f.reg.key))[0]?.editorSessions).toBe(1);
  await f.watcher.detachEditor(f.reg, second);
  expect((await f.watcher.status(f.reg.key))[0]?.editorTransition?.kind).toBe('clean-detach');
  f.write('b.ts', 'export const external=2;\n');
  await f.watcher.poll();
  f.advance();
  await f.watcher.poll();
  const next = await f.jobs.next(f.owner);
  expect(next!.source.selected.map((file) => file.path)).toEqual(['b.ts']);
  await f.jobs.finish(next!.job.id, f.owner, { exitCode: 0, status: 'completed' });
}, 30000);

it('preserves permitted manual work after detach but does not enable external writes without permission', async () => {
  const f = await fixture(),
    id = randomUUID();
  await f.watcher.configure(f.reg, {
    triggers: ['save'],
    externalChanges: false,
    editor: { id, pid: process.pid, autoSave: true },
  });
  f.write('a.ts', 'export const auto=2;\n');
  const hash = (await observeAutomaticFile(f.repo, 'a.ts'))!.hash;
  await f.watcher.editorSave(f.reg, { sessionId: id, file: 'a.ts', hash, reason: 'auto' });
  await f.watcher.detachEditor(f.reg, id);
  f.advance();
  await f.watcher.poll();
  const next = await f.jobs.next(f.owner);
  expect(next!.source.selected.map((file) => file.path)).toEqual(['a.ts']);
  await f.jobs.finish(next!.job.id, f.owner, { exitCode: 0, status: 'completed' });
  f.write('b.ts', 'export const external=2;\n');
  await f.watcher.poll();
  f.advance(600000);
  await f.watcher.poll();
  expect(await f.jobs.list()).toHaveLength(1);
}, 30000);

it('marks the final unclassified writes of a dead editor instead of treating them as external Save', async () => {
  const f = await fixture(),
    id = randomUUID();
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  });
  await f.watcher.configure(f.reg, {
    triggers: ['save'],
    externalChanges: true,
    editor: { id, pid: child.pid!, autoSave: false },
  });
  f.write('a.ts', 'export const unknown=2;\n');
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  await f.watcher.poll();
  f.advance();
  await f.watcher.poll();
  expect(await f.jobs.list()).toEqual([]);
  expect((await f.watcher.status(f.reg.key))[0]).toMatchObject({
    editorSessions: 0,
    unclassifiedFiles: ['a.ts'],
    editorTransition: { at: expect.any(Number), kind: 'process-exit' },
  });
  await f.restart();
  f.write('b.ts', 'export const external=2;\n');
  await f.watcher.poll();
  f.advance();
  await f.watcher.poll();
  const next = await f.jobs.next(f.owner);
  expect(next!.source.selected.map((file) => file.path)).toEqual(['b.ts']);
  await f.jobs.finish(next!.job.id, f.owner, { exitCode: 0, status: 'completed' });
}, 30000);
