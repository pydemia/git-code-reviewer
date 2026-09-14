import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { captureLocalSource } from './source-snapshot.js';
import { callLocalService, localServiceAddress, startLocalService } from './local-service.js';
import {
  ServiceJobs,
  type ServiceJob,
  type ServiceRegistration,
  type ServiceReviewOptions,
} from './service-jobs.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 15000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Service did not settle');
    await new Promise((r) => setTimeout(r, 30));
  }
}
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gcr-service-test-')),
    repo = path.join(root, 'repo'),
    data = path.join(root, 'data'),
    keys = path.join(root, 'keys'),
    calls = path.join(root, 'calls.jsonl');
  mkdirSync(repo);
  mkdirSync(keys, { mode: 0o700 });
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
    ).trim();
  git('init', '-b', 'main');
  writeFileSync(path.join(repo, 'a.ts'), 'export const base=1;\n');
  git('add', '.');
  git('commit', '-m', 'base');
  writeFileSync(path.join(repo, 'a.ts'), 'export const queued=2;\n');
  git('add', '.');
  const source = captureLocalSource({ cwd: repo, kind: 'index' });
  const frozen = source.freeze();
  source.close();
  const profileId = 'service-fixture';
  const location = { profileId, dataDirectory: data };
  const script = path.join(root, 'server.mjs');
  writeFileSync(
    script,
    `import {readFile,writeFile,unlink,appendFile} from 'node:fs/promises';
import path from 'node:path';
import {startLocalService,restoreLocalSource} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
const keys={read:async id=>{try{return await readFile(path.join(${JSON.stringify(keys)},id));}catch(e){if(e.code==='ENOENT')return;throw e;}},write:async(id,bytes)=>writeFile(path.join(${JSON.stringify(keys)},id),bytes,{mode:0o600}),remove:async id=>unlink(path.join(${JSON.stringify(keys)},id))};
const service=await startLocalService({...${JSON.stringify(location)},keys,run:async({job,source,signal})=>{const snapshot=restoreLocalSource(source);try{await appendFile(${JSON.stringify(calls)},JSON.stringify({id:job.id,read:snapshot.readFile('a.ts')})+'\\n');}finally{snapshot.close();}if(process.env.GCR_TEST_BLOCK==='1'&&!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return{exitCode:signal.aborted?2:0,status:signal.aborted?'cancelled':'completed'};}});
process.on('SIGTERM',()=>{void service.close();});process.stdout.write('ready\\n');await service.closed;
`,
  );
  const children: ChildProcess[] = [];
  cleanups.push(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit');
        child.kill('SIGKILL');
        await exit;
      }
    rmSync(root, { recursive: true, force: true });
  });
  const start = async (block = false) => {
    const child = spawn(process.execPath, [script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GCR_TEST_BLOCK: block ? '1' : '0' },
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error('Service startup timed out')), 15000);
      child.stdout!.on('data', (chunk) => {
        output += chunk;
        if (output.includes('ready\n')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(Error(`Service exited before ready: ${code}`));
      });
      child.once('error', reject);
    });
    return child;
  };
  const options: ServiceReviewOptions = {
    mode: 'standalone',
    model: 'gpt-6-astra',
    reasoningEffort: 'xhigh',
    excludePatterns: [],
    allowPaths: ['**'],
    durationMs: 120000,
    sourceBytes: 1048576,
    toolCalls: 100,
  };
  const call = (request: unknown) => callLocalService(location, request);
  const register = async (triggers = ['commit']) =>
    (await call({ action: 'register', root: repo, triggers, options })) as ServiceRegistration;
  const submit = (reg: ServiceRegistration, id = randomUUID(), trigger = 'commit') =>
    call({
      action: 'submit',
      input: {
        id,
        repository: reg.key,
        registrationRevision: reg.revision,
        trigger,
        source: frozen,
      },
    }) as Promise<ServiceJob>;
  return { root, repo, data, calls, location, frozen, start, call, register, submit, git };
}
it('requires explicit registration and trigger permission, persists an idempotent receipt, and runs after disconnect', async () => {
  const f = fixture();
  const child = await f.start(true);
  const address = await localServiceAddress(f.location);
  expect(statSync(address).mode & 0o777).toBe(0o600);
  expect(statSync(path.dirname(address)).mode & 0o777).toBe(0o700);
  const reg = await f.register();
  await expect(f.submit(reg, randomUUID(), 'push')).rejects.toMatchObject({
    code: 'service-denied',
  });
  const id = randomUUID();
  const first = await f.submit(reg, id);
  expect(first.state).toBe('queued');
  await until(
    async () => ((await f.call({ action: 'job', id })) as ServiceJob).state === 'running',
  );
  const retry = await f.submit(reg, id);
  expect(retry.id).toBe(first.id);
  expect(readFileSync(f.calls, 'utf8').trim().split('\n')).toHaveLength(1);
  // Neither ciphertext nor metadata should expose the captured source body.
  const walk = (dir: string): string =>
    execFileSync('rg', ['--text', '--files', dir], { encoding: 'utf8', stdio: 'pipe' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((file) => readFileSync(file, 'utf8'))
      .join('');
  expect(walk(f.data)).not.toContain('export const queued=2;');
  await f.call({ action: 'cancel', id });
  await until(
    async () => ((await f.call({ action: 'job', id })) as ServiceJob).state === 'finished',
  );
  const exit = once(child, 'exit');
  await f.call({ action: 'stop' });
  await exit;
}, 30000);
it('recovers queued source after SIGKILL but never reruns a receipt that had started', async () => {
  const f = fixture();
  const first = await f.start(true),
    reg = await f.register();
  const one = await f.submit(reg);
  await until(
    async () => ((await f.call({ action: 'job', id: one.id })) as ServiceJob).state === 'running',
  );
  const two = await f.submit(reg);
  const died = once(first, 'exit');
  first.kill('SIGKILL');
  await died;
  writeFileSync(path.join(f.repo, 'a.ts'), 'DIFFERENT LIVE SOURCE\n');
  writeFileSync(path.join(f.repo, '.git/index'), 'UNUSABLE ORIGINAL INDEX');
  const second = await f.start();
  await until(
    async () => ((await f.call({ action: 'job', id: two.id })) as ServiceJob).state === 'finished',
  );
  expect(((await f.call({ action: 'job', id: one.id })) as ServiceJob).state).toBe('interrupted');
  const calls = readFileSync(f.calls, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(calls.map((row) => row.id)).toEqual([one.id, two.id]);
  expect(calls[1].read.text).toBe('export const queued=2;\n');
  const exit = once(second, 'exit');
  await f.call({ action: 'stop' });
  await exit;
}, 40000);
it('revoking a registration aborts running work and cancels its queued generation', async () => {
  const f = fixture();
  const child = await f.start(true),
    reg = await f.register();
  const one = await f.submit(reg);
  await until(
    async () => ((await f.call({ action: 'job', id: one.id })) as ServiceJob).state === 'running',
  );
  const two = await f.submit(reg);
  await f.register([]);
  await until(
    async () => ((await f.call({ action: 'job', id: two.id })) as ServiceJob).state === 'cancelled',
  );
  expect(((await f.call({ action: 'job', id: one.id })) as ServiceJob).result?.status).toBe(
    'cancelled',
  );
  await expect(f.submit(reg)).rejects.toMatchObject({ code: 'service-denied' });
  const exit = once(child, 'exit');
  await f.call({ action: 'stop' });
  await exit;
}, 30000);
it('refuses a second live owner without disrupting the original socket', async () => {
  const f = fixture();
  const child = await f.start();
  await expect(f.start()).rejects.toThrow('Service exited before ready');
  expect(await f.call({ action: 'status' })).toMatchObject({ status: 'running', pid: child.pid });
  const reg = await f.register();
  const job = await f.submit(reg);
  await until(
    async () => ((await f.call({ action: 'job', id: job.id })) as ServiceJob).state === 'finished',
  );
  const exit = once(child, 'exit');
  await f.call({ action: 'stop' });
  await exit;
}, 30000);
it('preserves a regular file at the socket path and releases the failed startup owner', async () => {
  const f = fixture();
  const address = await localServiceAddress(f.location);
  writeFileSync(address, 'unrelated file', { mode: 0o600 });
  cleanups.push(async () => {
    rmSync(address, { force: true });
  });
  await expect(f.start()).rejects.toThrow('Service exited before ready');
  expect(readFileSync(address, 'utf8')).toBe('unrelated file');
  rmSync(address);
  const child = await f.start();
  const exit = once(child, 'exit');
  await f.call({ action: 'stop' });
  await exit;
}, 30000);
it('settles shutdown and disconnects partial clients even when releasing ownership fails', async () => {
  const f = fixture();
  const values = new Map<string, Buffer>();
  const service = await startLocalService({
    ...f.location,
    keys: {
      read: async (id) => (values.has(id) ? Buffer.from(values.get(id)!) : undefined),
      write: async (id, value) => {
        values.set(id, Buffer.from(value));
      },
      remove: async (id) => {
        values.delete(id);
      },
    },
    run: async () => ({ exitCode: 0, status: 'completed' }),
  });
  cleanups.push(async () => {
    await service.close();
  });
  const peer = net.createConnection(service.address);
  peer.on('error', () => undefined);
  await once(peer, 'connect');
  peer.write('{"action":');
  const ended = once(peer, 'close');
  const failure = vi
    .spyOn(ServiceJobs.prototype, 'releaseOwner')
    .mockRejectedValueOnce(new Error('fixture storage failure'));
  try {
    await service.close();
    expect(await service.closed).toEqual({ problem: 'service-unavailable' });
    await ended;
  } finally {
    failure.mockRestore();
    peer.destroy();
  }
}, 15000);
