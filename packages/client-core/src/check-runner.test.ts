import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkRunnerProfile, type ApprovedCheckRunner } from '@gcr/client-contract';
import { contentHash } from './local-identity.js';
import { captureLocalSource, type FrozenLocalSource } from './source-snapshot.js';
import { runApprovedCheck } from './check-runner-docker.js';
import { CheckRunnerStore } from './check-runner-store.js';
import { LocalRecordStore } from './local-records.js';
import { fakeDocker, runnerProfile } from '../test/check-runner-fixture.js';

describe.sequential('approved local isolated checks', () => {
  let dir: string, source: FrozenLocalSource, approval: ApprovedCheckRunner;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gcr-runner-test-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      }).trim();
    git('init', '--quiet');
    await writeFile(path.join(dir, 'subject.txt'), 'base number\n');
    git('add', 'subject.txt');
    git(
      '-c',
      'user.name=Owned',
      '-c',
      'user.email=owned@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--quiet',
      '-m',
      'owned',
    );
    await writeFile(path.join(dir, 'subject.txt'), 'staged string\n');
    await writeFile(path.join(dir, '.env'), 'HOST_SECRET');
    await symlink('/etc/passwd', path.join(dir, 'escape'));
    git('add', 'subject.txt', '.env', 'escape');
    const captured = captureLocalSource({ cwd: dir, kind: 'index' });
    source = captured.freeze();
    captured.close();
    await writeFile(path.join(dir, 'subject.txt'), 'unstaged change never executed\n');
    approval = {
      ...source.repository,
      clientProfileId: 'owned',
      version: 1,
      profile: runnerProfile,
      profileHash: contentHash(runnerProfile),
      approvedAt: new Date().toISOString(),
      authority: 'local-user',
      enabled: true,
    };
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it.each(['network', 'image', 'mounts', 'env', 'resources'])(
    'does not derive %s permissions from supplied data',
    (field) => {
      const p = structuredClone(runnerProfile) as Record<string, unknown>;
      if (field === 'network') p.network = 'host';
      if (field === 'image') p.image = 'alpine:latest';
      if (field === 'mounts') p.mounts = ['/'];
      if (field === 'env') p.env = { TOKEN: 'secret' };
      if (field === 'resources') p.resources = { ...runnerProfile.resources, pids: 100000 };
      expect(() => checkRunnerProfile(p)).toThrow();
    },
  );
  it('copies the staged snapshot only and preserves failures without confirming findings', async () => {
    const f = fakeDocker();
    const result = await runApprovedCheck({
      approval,
      source,
      contextHash: '1'.repeat(64),
      side: 'source',
      command: f.command,
    });
    expect(result.status, result.reason).toBe('completed');
    expect(result.stdout).toBe('staged string\n');
    expect(result.exitCode).toBe(1);
    expect(result.assessment).toBe('execution-observation');
    expect(result.missingSources.map((s) => s.path)).toEqual(
      expect.arrayContaining(['.env', 'escape']),
    );
    expect(result.cleanup).toBe('complete');
    expect(f.containers.size).toBe(0);
    const create = f.calls.filter((a) => a[4] === 'create');
    expect(create).toHaveLength(2);
    for (const args of create) {
      expect(args).toContain('--pull=never');
      expect(args).not.toContain('--env-file');
      expect(args).not.toContain('--privileged');
      expect(args).not.toContain('--volume');
    }
    const firstCreate = create[0]!;
    const location =
      firstCreate[firstCreate.indexOf('--mount') + 1]!.split('source=')[1]!.split(',')[0]!;
    await expect(stat(location)).rejects.toThrow();
    expect(await readFile(path.join(dir, 'subject.txt'), 'utf8')).toBe(
      'unstaged change never executed\n',
    );
  });
  it('runs the captured base with the same approved command, without interpreting exit 0 as repair', async () => {
    const f = fakeDocker();
    f.state.exitCode = 0;
    const result = await runApprovedCheck({
      approval,
      source,
      contextHash: '1'.repeat(64),
      side: 'base',
      command: f.command,
    });
    expect(result.stdout).toBe('base number\n');
    expect(result.status).toBe('completed');
    expect(result.assessment).toBe('execution-observation');
  });
  it.each(['remote', 'image-error', 'volume', 'emulation', 'probe'])(
    'refuses %s runtime without executing the approved command',
    async (condition) => {
      const f = fakeDocker();
      if (condition === 'remote') f.state.endpoint = 'ssh://other-host';
      if (condition === 'image-error') f.state.imageFailure = true;
      if (condition === 'volume') f.state.extraVolume = true;
      if (condition === 'emulation') f.state.emulated = true;
      if (condition === 'probe') f.state.probeInvalid = true;
      const result = await runApprovedCheck({
        approval,
        source,
        contextHash: '1'.repeat(64),
        side: 'source',
        command: f.command,
      });
      expect(result.status).toBe('unavailable');
      expect(result.environment).toBeNull();
      expect(f.calls.filter((a) => a[4] === 'start')).toHaveLength(condition === 'probe' ? 1 : 0);
      expect(result.cleanup).not.toBe('pending');
    },
  );
  it.each(['network', 'memory', 'capabilities', 'source-write', 'extra-mount', 'scratch-limit'])(
    'checks actual container %s settings before start',
    async (change) => {
      const f = fakeDocker();
      f.state.tamper = (c) => {
        if (change === 'network') c.HostConfig.NetworkMode = 'host';
        if (change === 'memory') c.HostConfig.Memory = 0;
        if (change === 'capabilities') c.HostConfig.CapAdd = ['SYS_ADMIN'];
        if (change === 'source-write') c.Mounts[0].RW = true;
        if (change === 'extra-mount')
          c.Mounts.push({ Type: 'bind', Source: '/home', Destination: '/home', RW: false });
        if (change === 'scratch-limit') c.HostConfig.Tmpfs['/tmp'] = 'rw,size=100g';
      };
      const result = await runApprovedCheck({
        approval,
        source,
        contextHash: '1'.repeat(64),
        side: 'source',
        command: f.command,
      });
      expect(result.reason).toBe('runner-isolation-unavailable');
      expect(f.calls.some((a) => a[4] === 'start')).toBe(false);
      expect(result.cleanup).toBe('complete');
    },
  );
  it.each(['timeout', 'cancelled', 'output'] as const)(
    'removes the container after %s and records incomplete output honestly',
    async (stopped) => {
      const f = fakeDocker();
      f.state.stopped = stopped;
      const result = await runApprovedCheck({
        approval,
        source,
        contextHash: '1'.repeat(64),
        side: 'source',
        command: f.command,
      });
      expect(result.status).toBe(
        { timeout: 'timed-out', cancelled: 'cancelled', output: 'output-limit' }[stopped],
      );
      expect(result.outputTruncated).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.cleanup).toBe('complete');
      expect(f.containers.size).toBe(0);
      if (stopped === 'output') expect(result.stdout).toBe('');
    },
  );
  it('does not mistake a created but never started container for a successful check', async () => {
    const f = fakeDocker();
    f.state.createdNeverStarted = true;
    const result = await runApprovedCheck({
      approval,
      source,
      contextHash: '1'.repeat(64),
      side: 'source',
      command: f.command,
    });
    expect(result.status).toBe('unavailable');
    expect(result.exitCode).toBeNull();
  });
  it('revalidates approval before each start and refuses a revoked runner', async () => {
    const f = fakeDocker();
    let checks = 0;
    const result = await runApprovedCheck({
      approval,
      source,
      contextHash: '1'.repeat(64),
      side: 'source',
      command: f.command,
      revalidateApproval: async () => {
        if (++checks === 2) throw Error('revoked');
      },
    });
    expect(result.status).toBe('unavailable');
    expect(f.calls.filter((a) => a[4] === 'start')).toHaveLength(1);
    expect(result.cleanup).toBe('complete');
  });
  it('keeps locally approved profiles and results encrypted and supports revoke/reapprove', async () => {
    const keys = new Map<string, Uint8Array>();
    const records = await LocalRecordStore.open({
      scope: { kind: 'repository', profileId: 'owned', ...source.repository },
      dataDirectory: path.join(dir, 'private-data'),
      keys: {
        read: async (id) => keys.get(id),
        write: async (id, value) => {
          keys.set(id, value);
        },
        remove: async (id) => {
          keys.delete(id);
        },
      },
    });
    try {
      const store = new CheckRunnerStore(records);
      await expect(store.get('owned-check')).rejects.toThrow('Approve');
      const saved = await store.approve(runnerProfile);
      expect((await store.list())[0]).toEqual(saved);
      await store.revoke('owned-check');
      await expect(store.get('owned-check')).rejects.toThrow('Approve');
      expect(await store.list()).toEqual([]);
      await store.approve(runnerProfile);
      const f = fakeDocker();
      const result = await runApprovedCheck({
        approval: await store.get('owned-check'),
        source,
        contextHash: '1'.repeat(64),
        side: 'source',
        command: f.command,
      });
      await store.save(result);
      expect(await store.result(result.id)).toEqual(result);
      async function scan(folder: string): Promise<void> {
        for (const name of await readdir(folder)) {
          const file = path.join(folder, name);
          if ((await stat(file)).isDirectory()) await scan(file);
          else expect((await readFile(file)).includes(Buffer.from('staged string'))).toBe(false);
        }
      }
      await scan(path.join(dir, 'private-data'));
    } finally {
      records.close();
    }
  });
});
