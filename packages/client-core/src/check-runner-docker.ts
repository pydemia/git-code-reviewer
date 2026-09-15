import { spawn } from 'node:child_process';
import { access, chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  approvedCheckRunner,
  checkRunnerObservation,
  type ApprovedCheckRunner,
  type CheckRunnerObservation,
} from '@gcr/client-contract';
import { canonicalJson, contentHash } from './local-identity.js';
import { restoreLocalSource, type FrozenLocalSource } from './source-snapshot.js';
import { CheckRunnerError } from './check-runner-store.js';

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  stopped: 'timeout' | 'cancelled' | 'output' | null;
};
export type DockerCommand = (
  args: string[],
  options: { timeoutMs: number; maxBytes: number; signal?: AbortSignal },
) => Promise<CommandResult>;
const fail = (code: string) =>
  new CheckRunnerError(code, 'The approved check could not run with the required local isolation.');
const safeEnvironment = () =>
  Object.fromEntries(
    ['HOME', 'USER', 'TMPDIR', 'SystemRoot'].flatMap((k) =>
      process.env[k] === undefined ? [] : [[k, process.env[k]!]],
    ),
  );

/** Only fixed absolute Docker installations are considered; never resolve a workspace PATH entry. */
export async function localDockerCommand(): Promise<DockerCommand> {
  if (!['darwin', 'linux'].includes(process.platform)) throw fail('runner-platform-unavailable');
  let executable: string | undefined;
  for (const candidate of [
    '/usr/local/bin/docker',
    '/opt/homebrew/bin/docker',
    '/usr/bin/docker',
  ]) {
    try {
      await access(candidate, constants.X_OK);
      executable = await realpath(candidate);
      break;
    } catch {
      /* Try the next fixed installation. */
    }
  }
  if (!executable) throw fail('runner-docker-unavailable');
  const binary = executable;
  return (args, options) =>
    new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        resolve({ code: null, stdout: '', stderr: '', stopped: 'cancelled' });
        return;
      }
      const child = spawn(binary, args, {
        cwd: tmpdir(),
        env: { ...safeEnvironment(), PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [],
        err: Buffer[] = [];
      let bytes = 0,
        stopped: CommandResult['stopped'] = null;
      const stop = (reason: NonNullable<CommandResult['stopped']>) => {
        if (!stopped) {
          stopped = reason;
          child.kill('SIGKILL');
        }
      };
      const abort = () => stop('cancelled');
      options.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => stop('timeout'), options.timeoutMs);
      const capture = (target: Buffer[]) => (value: Buffer) => {
        bytes += value.length;
        if (bytes > options.maxBytes) {
          stop('output');
          return;
        }
        target.push(value);
      };
      child.stdout.on('data', capture(out));
      child.stderr.on('data', capture(err));
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      child.once('error', () => {
        cleanup();
        reject(fail('runner-docker-unavailable'));
      });
      child.once('close', (code) => {
        cleanup();
        resolve({
          code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          stopped,
        });
      });
    });
}
function canonicalImage(value: string) {
  const [repository, digest] = value.split('@');
  if (!repository || !digest) return value;
  const parts = repository.split('/');
  if (parts.length === 1) return `docker.io/library/${repository}@${digest}`;
  if (['docker.io', 'index.docker.io', 'registry-1.docker.io'].includes(parts[0]!)) {
    const rest = parts.slice(1);
    return `docker.io/${rest.length === 1 ? 'library/' : ''}${rest.join('/')}@${digest}`;
  }
  return /[.:]/.test(parts[0]!) || parts[0] === 'localhost'
    ? value
    : `docker.io/${repository}@${digest}`;
}
const bounded = { timeoutMs: 10000, maxBytes: 2 * 1024 * 1024 };
async function json(command: DockerCommand, args: string[]) {
  const result = await command(args, bounded);
  if (result.code !== 0 || result.stopped) throw fail('runner-runtime-unavailable');
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw fail('runner-runtime-invalid');
  }
}
const probeScript = `set -eu
test -x /usr/bin/timeout
test ! -e /var/run/docker.sock
test ! -e /run/secrets
if touch /source/.gcr-write-probe 2>/dev/null; then exit 91; fi
cat /proc/self/status
printf '\\nGCR_CGROUP\\n'
cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max /sys/fs/cgroup/cpu.max
printf 'GCR_END\\n'`;
const runnerScript = `set -eu
mkdir -p /tmp/home
if [ "$1" = scratch-copy ]; then cp -R /source/. /work/; chmod -R u+w /work; cd /work; else cd /source; fi
shift
exec "$@"`;

function verifyContainer(
  value: unknown,
  expected: {
    id: string;
    image: string;
    source: string;
    profile: ApprovedCheckRunner['profile'];
    commandArgs: string[];
  },
) {
  const c = (
    value as Array<{
      Image: string;
      Config: {
        Labels: Record<string, string>;
        User: string;
        WorkingDir: string;
        Entrypoint: string[];
        Cmd: string[];
        Healthcheck?: { Test: string[] };
      };
      Mounts: Array<{ Type: string; Destination: string; Source: string; RW: boolean }>;
      HostConfig: {
        Privileged: boolean;
        ReadonlyRootfs: boolean;
        NetworkMode: string;
        PidMode: string;
        IpcMode: string;
        CgroupnsMode: string;
        Memory: number;
        MemorySwap: number;
        CpuPeriod: number;
        CpuQuota: number;
        PidsLimit: number;
        CapDrop: string[];
        CapAdd: string[] | null;
        SecurityOpt: string[];
        LogConfig: { Type: string };
        RestartPolicy: { Name: string };
        Devices: unknown[] | null;
        DeviceRequests: unknown[] | null;
        Tmpfs: Record<string, string>;
      };
    }>
  )?.[0]; // Docker's response is checked field by field below.
  const h = c?.HostConfig,
    config = c?.Config,
    limits = expected.profile.resources;
  if (
    !c ||
    config?.Labels?.['io.gcr.check-run'] !== expected.id ||
    c.Image !== expected.image ||
    config.User !== '65534:65534' ||
    config.WorkingDir !== '/source' ||
    canonicalJson(config.Entrypoint) !== canonicalJson(['/usr/bin/env']) ||
    canonicalJson(config.Cmd) !== canonicalJson(expected.commandArgs) ||
    config.Healthcheck?.Test?.[0] !== 'NONE' ||
    h?.Privileged !== false ||
    h.ReadonlyRootfs !== true ||
    h.NetworkMode !== 'none' ||
    h.PidMode !== '' ||
    h.IpcMode !== 'none' ||
    h.CgroupnsMode !== 'private' ||
    h.Memory !== limits.memoryMiB * 1048576 ||
    h.MemorySwap !== h.Memory ||
    h.CpuPeriod !== 100000 ||
    h.CpuQuota !== limits.cpuMillis * 100 ||
    h.PidsLimit !== limits.pids ||
    !Array.isArray(h.CapDrop) ||
    !h.CapDrop.includes('ALL') ||
    (h.CapAdd?.length ?? 0) !== 0 ||
    !Array.isArray(h.SecurityOpt) ||
    !h.SecurityOpt.some((s: string) => /^no-new-privileges([=:]true)?$/.test(s)) ||
    h.SecurityOpt.some((s: string) => s.includes('unconfined')) ||
    h.LogConfig?.Type !== 'none' ||
    h.RestartPolicy?.Name !== 'no' ||
    (h.Devices?.length ?? 0) !== 0 ||
    (h.DeviceRequests?.length ?? 0) !== 0 ||
    !Array.isArray(c.Mounts) ||
    c.Mounts.length !== 1 ||
    c.Mounts[0]!.Type !== 'bind' ||
    c.Mounts[0]!.Destination !== '/source' ||
    c.Mounts[0]!.Source !== expected.source ||
    c.Mounts[0]!.RW !== false ||
    Object.keys(h.Tmpfs ?? {})
      .sort()
      .join(',') !== '/tmp,/work' ||
    h.Tmpfs['/tmp'] !== `rw,noexec,nosuid,nodev,size=${limits.scratchMiB}m,mode=1777` ||
    h.Tmpfs['/work'] !== `rw,nosuid,nodev,size=${limits.scratchMiB}m,uid=65534,gid=65534,mode=0700`
  )
    throw fail('runner-isolation-unavailable');
}
function verifyProbe(output: string, profile: ApprovedCheckRunner['profile']) {
  if (
    !/^Uid:\s+65534\s+65534\s+65534\s+65534\s*$/m.test(output) ||
    !/^CapEff:\s+0+\s*$/m.test(output) ||
    !/^NoNewPrivs:\s+1\s*$/m.test(output) ||
    !/^Seccomp:\s+2\s*$/m.test(output)
  )
    throw fail('runner-isolation-unavailable');
  const expected = `GCR_CGROUP\n${profile.resources.memoryMiB * 1048576}\n${profile.resources.pids}\n${profile.resources.cpuMillis * 100} 100000\nGCR_END`;
  if (!output.includes(expected)) throw fail('runner-resource-isolation-unavailable');
}

/** Manual approved checks only. No model, central transport, image pull, host shell or fallback. */
export async function runApprovedCheck(input: {
  approval: ApprovedCheckRunner;
  source: FrozenLocalSource;
  contextHash: string;
  side: 'base' | 'source';
  signal?: AbortSignal;
  /** Trusted host test port. Never configurable through a profile, prompt or CLI input. */
  command?: DockerCommand;
  revalidateApproval?: () => Promise<void>;
}): Promise<CheckRunnerObservation> {
  const approval = approvedCheckRunner(input.approval),
    snapshot = restoreLocalSource(input.source);
  if (
    contentHash(approval.profile) !== approval.profileHash ||
    !/^[a-f0-9]{64}$/.test(input.contextHash) ||
    !['base', 'source'].includes(input.side)
  ) {
    snapshot.close();
    throw fail('runner-input-invalid');
  }
  const frozen = snapshot.freeze();
  if (
    frozen.repository.repositoryKey !== approval.repositoryKey ||
    frozen.repository.worktreeKey !== approval.worktreeKey
  ) {
    snapshot.close();
    throw fail('runner-source-scope-mismatch');
  }
  snapshot.close();
  const files = frozen.files.filter((f) => f.source.side === input.side);
  const id = randomUUID(),
    profile = approval.profile;
  const value: CheckRunnerObservation = {
    repositoryKey: approval.repositoryKey,
    worktreeKey: approval.worktreeKey,
    clientProfileId: approval.clientProfileId,
    version: 1,
    id,
    profile,
    profileHash: approval.profileHash,
    sourceHash: frozen.identity.hash,
    contextHash: input.contextHash,
    filesHash: contentHash(
      files.map((f) => ({ path: f.source.path, hash: f.source.hash, mode: f.mode })),
    ),
    side: input.side,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: 'unavailable',
    reason: 'runner-runtime-unavailable',
    exitCode: null,
    stdout: '',
    stderr: '',
    outputTruncated: false,
    environment: null,
    environmentHash: null,
    missingSources: frozen.limitations.map((f) => ({
      path: f.path,
      side: f.side,
      reason: f.reason,
    })),
    cleanup: 'not-needed',
    remainingContainer: null,
    remainingDirectory: null,
    assessment: 'execution-observation',
  };
  let directory: string | undefined,
    command: DockerCommand | undefined,
    prefix: string[] = [],
    container: string | undefined;
  try {
    if (input.signal?.aborted) {
      value.status = 'cancelled';
      value.reason = 'cancelled';
      return value;
    }
    command = input.command ?? (await localDockerCommand());
    // Resolve only a local Unix daemon, then discard Docker proxy/registry configuration for all execution calls.
    const context = await command(['context', 'show'], bounded);
    if (context.code !== 0 || context.stopped || !/^[-a-zA-Z0-9_.]+\s*$/.test(context.stdout))
      throw fail('runner-runtime-unavailable');
    const endpoint = await json(command, [
      'context',
      'inspect',
      context.stdout.trim(),
      '--format',
      '{{json .Endpoints.docker.Host}}',
    ]);
    if (
      typeof endpoint !== 'string' ||
      !endpoint.startsWith('unix:///') ||
      /[\r\n\0]/.test(endpoint)
    )
      throw fail('runner-remote-daemon-denied');
    if (!input.command) {
      const socket = await lstat(await realpath(endpoint.slice(7)));
      if (!socket.isSocket()) throw fail('runner-runtime-unavailable');
    }
    directory = await realpath(await mkdtemp(path.join(tmpdir(), 'gcr-check-')));
    await chmod(directory, 0o700);
    if (/[",\r\n]/.test(directory)) throw fail('runner-workspace-unavailable');
    const config = path.join(directory, 'docker-config');
    await mkdir(config, { mode: 0o700 });
    await writeFile(path.join(config, 'config.json'), '{}', { mode: 0o600 });
    prefix = ['--config', config, '--host', endpoint];
    const info = await json(command, [...prefix, 'info', '--format', '{{json .}}']);
    if (
      info.OSType !== 'linux' ||
      info.CgroupVersion !== '2' ||
      !Array.isArray(info.SecurityOptions) ||
      !info.SecurityOptions.some(
        (s: unknown) => typeof s === 'string' && s === 'name=seccomp,profile=builtin',
      ) ||
      info.SecurityOptions.some((s: unknown) => typeof s === 'string' && s.includes('unconfined'))
    )
      throw fail('runner-isolation-unavailable');
    const image = (await json(command, [...prefix, 'image', 'inspect', profile.image]))?.[0];
    if (
      !image ||
      image.Os !== 'linux' ||
      !/^sha256:[a-f0-9]{64}$/.test(image.Id) ||
      !image.RepoDigests?.some(
        (digest: unknown) =>
          typeof digest === 'string' && canonicalImage(digest) === canonicalImage(profile.image),
      ) ||
      Object.keys(image.Config?.Volumes ?? {}).length
    )
      throw fail('runner-image-unavailable');
    const architecture =
      ({ aarch64: 'arm64', x86_64: 'amd64' } as Record<string, string>)[info.Architecture] ??
      info.Architecture;
    if (image.Architecture !== architecture) throw fail('runner-emulation-denied');
    const source = path.join(directory, 'source');
    await mkdir(source, { mode: 0o755 });
    for (const file of files) {
      const target = path.join(source, file.source.path);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await writeFile(target, file.text, {
        flag: 'wx',
        mode: file.mode === '100755' ? 0o555 : 0o444,
      });
    }
    await chmod(source, 0o555);
    const run = async (probe: boolean) => {
      const name = `gcr-check-${randomUUID()}`;
      container = name;
      value.cleanup = 'pending';
      value.remainingContainer = name;
      const r = profile.resources;
      const args = [
        ...prefix,
        'create',
        '--pull=never',
        '--name',
        name,
        '--label',
        `io.gcr.check-run=${id}`,
        '--workdir',
        '/source',
        '--user',
        '65534:65534',
        '--network',
        'none',
        '--ipc',
        'none',
        '--cgroupns',
        'private',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges=true',
        '--memory',
        String(r.memoryMiB * 1048576),
        '--memory-swap',
        String(r.memoryMiB * 1048576),
        '--cpu-period',
        '100000',
        '--cpu-quota',
        String(r.cpuMillis * 100),
        '--pids-limit',
        String(r.pids),
        '--ulimit',
        'core=0:0',
        '--ulimit',
        'nofile=256:256',
        '--restart',
        'no',
        '--log-driver',
        'none',
        '--no-healthcheck',
        '--stop-timeout',
        '1',
        '--mount',
        `type=bind,source=${source},target=/source,readonly`,
        '--tmpfs',
        `/tmp:rw,noexec,nosuid,nodev,size=${r.scratchMiB}m,mode=1777`,
        '--tmpfs',
        `/work:rw,nosuid,nodev,size=${r.scratchMiB}m,uid=65534,gid=65534,mode=0700`,
        '--entrypoint',
        '/usr/bin/env',
        image.Id,
        '-i',
        'PATH=/usr/local/bin:/usr/bin:/bin',
        'HOME=/tmp/home',
        'TMPDIR=/tmp',
        '/usr/bin/timeout',
        '-s',
        'KILL',
        String(Math.ceil((probe ? 10000 : r.timeoutMs) / 1000)),
        '/bin/sh',
        '-c',
        probe ? probeScript : runnerScript,
        'gcr-check',
        ...(probe ? [] : [profile.workingDirectory, profile.command, ...profile.args]),
      ];
      const created = await command!(args, bounded);
      if (created.code !== 0 || created.stopped) throw fail('runner-create-failed');
      verifyContainer(await json(command!, [...prefix, 'inspect', name]), {
        id,
        image: image.Id,
        commandArgs: args.slice(args.indexOf(image.Id) + 1),
        source,
        profile,
      });
      await input.revalidateApproval?.();
      const output = await command!([...prefix, 'start', '--attach', name], {
        timeoutMs: (probe ? 10000 : r.timeoutMs) + 2000,
        maxBytes: probe ? 32000 : r.outputBytes,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const state = (await json(command!, [...prefix, 'inspect', name]))?.[0]?.State;
      if (
        output.stopped === null &&
        (!state ||
          state.Status !== 'exited' ||
          state.Running ||
          state.Dead ||
          state.OOMKilled ||
          state.Error)
      )
        throw fail('runner-execution-incomplete');
      if (
        output.stopped === null &&
        (!Number.isInteger(state.ExitCode) || state.ExitCode < 0 || state.ExitCode > 255)
      )
        throw fail('runner-runtime-invalid');
      const removed = await command!([...prefix, 'rm', '--force', '--volumes', name], bounded);
      if (removed.code !== 0 || removed.stopped) throw fail('runner-cleanup-pending');
      container = undefined;
      value.cleanup = 'complete';
      value.remainingContainer = null;
      return { ...output, code: output.stopped ? null : state.ExitCode };
    };
    const probe = await run(true);
    if (probe.code !== 0 || probe.stopped) throw fail('runner-isolation-unavailable');
    verifyProbe(probe.stdout, profile);
    value.environment = {
      imageId: image.Id,
      engineVersion: info.ServerVersion,
      kernelVersion: info.KernelVersion,
      architecture: info.Architecture,
      securityOptions: info.SecurityOptions,
      isolation: 'docker-linux',
      network: 'none',
      rootFilesystem: 'read-only',
      user: '65534:65534',
      capabilities: 'none',
      noNewPrivileges: true,
      seccomp: 'filter',
      cgroups: 'v2',
    };
    value.environmentHash = contentHash({
      environment: value.environment,
      resources: profile.resources,
      workingDirectory: profile.workingDirectory,
    });
    const result = await run(false);
    value.exitCode = result.code;
    value.outputTruncated = result.stopped !== null;
    if (result.stopped === 'output') {
      value.status = 'output-limit';
      value.reason = 'Output exceeded the approved limit; partial output was discarded.';
    } else {
      value.stdout = result.stdout;
      value.stderr = result.stderr;
      value.status =
        result.stopped === 'cancelled'
          ? 'cancelled'
          : result.stopped === 'timeout'
            ? 'timed-out'
            : result.code === 137 || result.code === 124
              ? 'error'
              : 'completed';
      value.reason =
        value.status === 'completed'
          ? 'Observed exit status and output; no automatic defect confirmation.'
          : value.status;
    }
  } catch (error) {
    value.status = input.signal?.aborted ? 'cancelled' : 'unavailable';
    value.reason = error instanceof CheckRunnerError ? error.code : 'runner-runtime-unavailable';
  } finally {
    if (container && command) {
      try {
        const current = (await json(command, [...prefix, 'inspect', container]))?.[0];
        if (current?.Config?.Labels?.['io.gcr.check-run'] === id) {
          const result = await command(
            [...prefix, 'rm', '--force', '--volumes', container],
            bounded,
          );
          if (result.code === 0 && !result.stopped) {
            value.cleanup = 'complete';
            value.remainingContainer = null;
          }
        }
      } catch {
        const listed = await command(
          [...prefix, 'ps', '--all', '--filter', `name=^/${container}$`, '--format', '{{.Names}}'],
          bounded,
        ).catch(() => null);
        if (listed?.code === 0 && !listed.stopped && !listed.stdout.trim()) {
          value.cleanup = 'complete';
          value.remainingContainer = null;
        }
      }
    }
    if (directory && value.cleanup !== 'pending') {
      await chmod(path.join(directory, 'source'), 0o700).catch(() => undefined);
      await rm(directory, { recursive: true, force: true }).catch(() => {
        value.cleanup = 'pending';
      });
    }
    value.remainingDirectory = value.cleanup === 'pending' ? (directory ?? null) : null;
    value.finishedAt = new Date().toISOString();
  }
  return checkRunnerObservation(value);
}
