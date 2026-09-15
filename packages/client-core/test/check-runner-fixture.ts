/* eslint-disable @typescript-eslint/no-explicit-any -- Adversarial synthetic Docker responses intentionally mutate field types. */
import { readFile } from 'node:fs/promises';
import type { CheckRunnerProfile } from '@gcr/client-contract';
import type { DockerCommand } from '../src/check-runner-docker.js';
export const runnerProfile: CheckRunnerProfile = {
  version: 1,
  id: 'owned-check',
  name: 'Owned contract check',
  image: 'example.invalid/owned@sha256:' + 'a'.repeat(64),
  command: '/bin/sh',
  args: ['-c', 'cat subject.txt'],
  network: 'none',
  source: 'read-only',
  workingDirectory: 'scratch-copy',
  resources: {
    cpuMillis: 500,
    memoryMiB: 64,
    pids: 32,
    scratchMiB: 16,
    timeoutMs: 3000,
    outputBytes: 4096,
  },
  assertion: { name: 'Return contract', inputs: 'Captured subject.txt', expected: 'number' },
};
export function fakeDocker() {
  const calls: string[][] = [];
  const containers = new Map<
    string,
    { inspect: Record<string, any>; probe: boolean; source: string }
  >();
  const state = {
    endpoint: 'unix:///owned/daemon.sock',
    imageFailure: false,
    extraVolume: false,
    emulated: false,
    exitCode: 1,
    probeInvalid: false,
    createdNeverStarted: false,
    cleanupFails: false,
    stopped: null as 'timeout' | 'cancelled' | 'output' | null,
    tamper: undefined as ((value: Record<string, any>) => void) | undefined,
  };
  const result = (
    stdout = '',
    code: number | null = 0,
    stopped: null | 'timeout' | 'cancelled' | 'output' = null,
  ) => ({ stdout, stderr: '', code, stopped });
  const command: DockerCommand = async (args) => {
    calls.push([...args]);
    if (args[0] === 'context')
      return result(args[1] === 'show' ? 'owned\n' : JSON.stringify(state.endpoint));
    const op = args[4];
    if (op === 'info')
      return result(
        JSON.stringify({
          OSType: 'linux',
          CgroupVersion: '2',
          Architecture: 'aarch64',
          ServerVersion: '29.3.1',
          KernelVersion: 'owned-kernel',
          SecurityOptions: ['name=seccomp,profile=builtin'],
        }),
      );
    if (op === 'image')
      return state.imageFailure
        ? result('', 1)
        : result(
            JSON.stringify([
              {
                Id: 'sha256:' + 'b'.repeat(64),
                Os: 'linux',
                Architecture: state.emulated ? 'amd64' : 'arm64',
                RepoDigests: [runnerProfile.image],
                Config: { Volumes: state.extraVolume ? { '/home': {} } : {} },
              },
            ]),
          );
    if (op === 'create') {
      const option = (name: string) => args[args.indexOf(name) + 1]!;
      const source = option('--mount').split('source=')[1]!.split(',')[0]!;
      const tmp = Array.from(args.entries())
        .filter(([, v]) => v === '--tmpfs')
        .map(([i]) => args[i + 1]!);
      const inspect = {
        Image: 'sha256:' + 'b'.repeat(64),
        Config: {
          Labels: { 'io.gcr.check-run': option('--label').split('=')[1] },
          User: option('--user'),
          WorkingDir: option('--workdir'),
          Entrypoint: [option('--entrypoint')],
          Cmd: args.slice(args.indexOf('sha256:' + 'b'.repeat(64)) + 1),
          Healthcheck: { Test: ['NONE'] },
        },
        Mounts: [{ Type: 'bind', Destination: '/source', Source: source, RW: false }],
        HostConfig: {
          Privileged: false,
          ReadonlyRootfs: true,
          NetworkMode: option('--network'),
          PidMode: '',
          IpcMode: option('--ipc'),
          CgroupnsMode: option('--cgroupns'),
          Memory: Number(option('--memory')),
          MemorySwap: Number(option('--memory-swap')),
          CpuPeriod: Number(option('--cpu-period')),
          CpuQuota: Number(option('--cpu-quota')),
          PidsLimit: Number(option('--pids-limit')),
          CapDrop: ['ALL'],
          CapAdd: null,
          SecurityOpt: ['no-new-privileges=true'],
          LogConfig: { Type: 'none' },
          RestartPolicy: { Name: 'no' },
          Devices: [],
          DeviceRequests: [],
          Tmpfs: Object.fromEntries(
            tmp.map((x) => [x.slice(0, x.indexOf(':')), x.slice(x.indexOf(':') + 1)]),
          ),
        },
        State: {
          Status: 'created',
          Running: false,
          Dead: false,
          OOMKilled: false,
          Error: '',
          ExitCode: 0,
        },
      };
      state.tamper?.(inspect);
      containers.set(option('--name'), {
        inspect,
        probe: args.some((a) => a.includes('GCR_CGROUP')),
        source,
      });
      return result('c'.repeat(64));
    }
    if (op === 'inspect') {
      const c = containers.get(args[5]!);
      return c ? result(JSON.stringify([c.inspect])) : result('', 1);
    }
    if (op === 'start') {
      const c = containers.get(args.at(-1)!)!;
      if (!state.createdNeverStarted) c.inspect.State.Status = 'exited';
      c.inspect.State.ExitCode = c.probe ? 0 : state.exitCode;
      if (c.probe)
        return result(
          `Uid:\t65534\t65534\t65534\t65534\nCapEff:\t0000000000000000\nNoNewPrivs:\t1\nSeccomp:\t${state.probeInvalid ? 0 : 2}\nGCR_CGROUP\n67108864\n32\n50000 100000\nGCR_END\n`,
        );
      return result(
        await readFile(c.source + '/subject.txt', 'utf8'),
        state.stopped ? null : state.exitCode,
        state.stopped,
      );
    }
    if (op === 'rm') {
      if (state.cleanupFails) return result('', 1);
      containers.delete(args.at(-1)!);
      return result('removed');
    }
    if (op === 'ps') return result([...containers.keys()].join('\n'));
    throw Error('Unexpected Docker fixture command ' + op);
  };
  return { command, calls, state, containers };
}
