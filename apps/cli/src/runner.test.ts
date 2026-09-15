import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCli } from './cli.js';
import {
  fakeDocker,
  runnerProfile,
} from '../../../packages/client-core/test/check-runner-fixture.js';
import type { LocalKeyStore } from '@gcr/client-core';

describe.sequential('manual local runner CLI', () => {
  let dir: string, repo: string, data: string, preparedId: string;
  const secrets = new Map<string, Uint8Array>();
  const keys: LocalKeyStore = {
    read: async (id) => (secrets.has(id) ? Uint8Array.from(secrets.get(id)!) : undefined),
    write: async (id, value) => {
      secrets.set(id, Uint8Array.from(value));
    },
    remove: async (id) => {
      secrets.delete(id);
    },
  };
  const f = fakeDocker();
  let modelCalls = 0;
  const cli = (args: string[]) =>
    executeCli([...args, '--cwd', repo, '--data-dir', data], {
      keys,
      checkRunnerCommand: f.command,
      prepareExecutor: async () => {
        modelCalls++;
        throw Error('A runner must never call a model');
      },
    });
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gcr-runner-cli-'));
    repo = path.join(dir, 'repo');
    data = path.join(dir, 'data');
    execFileSync('git', ['init', '--quiet', repo]);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: repo,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      });
    await writeFile(path.join(repo, 'subject.txt'), 'base number\n');
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
      'base',
    );
    await writeFile(path.join(repo, 'subject.txt'), 'staged string\n');
    git('add', 'subject.txt');
    await writeFile(path.join(repo, 'runner-profile.json'), JSON.stringify(runnerProfile));
    const prepared = await cli(['prepare']);
    expect(prepared.exitCode, JSON.stringify(prepared)).toBe(0);
    preparedId = (prepared.value as { preparedId: string }).preparedId;
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it('requires an explicit local approval and rejects permissions hidden in profile input', async () => {
    const denied = await cli(['runner', 'run', runnerProfile.id, '--prepared', preparedId]);
    expect(denied.exitCode).toBe(2);
    expect(denied.value).toMatchObject({ error: { code: 'runner-not-approved' } });
    expect(f.calls).toHaveLength(0);
    await writeFile(
      path.join(repo, 'bad-profile.json'),
      JSON.stringify({ ...runnerProfile, network: 'host' }),
    );
    expect((await cli(['runner', 'approve', '--input', 'bad-profile.json'])).exitCode).toBe(2);
    expect((await cli(['runner', 'approve', '--input', 'runner-profile.json'])).exitCode).toBe(0);
    expect((await cli(['runner', 'profiles'])).value).toHaveLength(1);
  });
  it('runs captured source and reads the encrypted observation without repeating execution', async () => {
    await writeFile(path.join(repo, 'subject.txt'), 'later unstaged edit');
    const result = await cli(['runner', 'run', runnerProfile.id, '--prepared', preparedId]);
    expect(result.exitCode, JSON.stringify(result)).toBe(1);
    const observation = (
      result.value as { observations: Array<{ id: string; stdout: string; assessment: string }> }
    ).observations[0]!;
    expect(observation.stdout).toBe('staged string\n');
    expect(observation.assessment).toBe('execution-observation');
    const count = f.calls.length;
    const saved = await cli(['runner', 'result', observation.id]);
    expect(saved.value).toEqual(observation);
    expect(f.calls).toHaveLength(count);
    expect(modelCalls).toBe(0);
    expect(await readFile(path.join(repo, 'subject.txt'), 'utf8')).toBe('later unstaged edit');
  });
  it('revokes future starts and rejects implicit snapshots or central execution options', async () => {
    expect((await cli(['runner', 'run', runnerProfile.id])).exitCode).toBe(2);
    expect((await cli(['runner', 'profiles', '--input', 'runner-profile.json'])).exitCode).toBe(2);
    expect(
      (
        await cli([
          'runner',
          'run',
          runnerProfile.id,
          '--prepared',
          preparedId,
          '--mode',
          'centralized',
          '--connection',
          'owned',
        ])
      ).exitCode,
    ).toBe(2);
    expect((await cli(['runner', 'revoke', runnerProfile.id])).exitCode).toBe(0);
    const count = f.calls.length;
    expect(
      (await cli(['runner', 'run', runnerProfile.id, '--prepared', preparedId])).exitCode,
    ).toBe(2);
    expect(f.calls).toHaveLength(count);
  });
});
