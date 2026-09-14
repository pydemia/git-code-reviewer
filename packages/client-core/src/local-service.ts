import net from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { contentHash, defaultLocalDataDirectory, discoverLocalIdentity } from './local-identity.js';
import { privateRoot } from './private-files.js';
import {
  ServiceJobs,
  LocalServiceError,
  type ServiceJob,
  type ServiceRegistration,
} from './service-jobs.js';
import type { LocalKeyStore } from './local-credentials.js';
import type { FrozenLocalSource } from './source-snapshot.js';
import type { ReviewRequestRecord } from '@gcr/client-contract';
import { ServiceWatcher } from './service-watch.js';

const maximumFrame = 9 * 1024 * 1024;
export interface LocalServiceLocation {
  profileId: string;
  dataDirectory?: string;
}
export async function localServiceAddress(options: LocalServiceLocation) {
  if (process.platform === 'win32') throw new LocalServiceError('service-unavailable');
  const directory = await privateRoot(
    path.join(os.tmpdir(), `gcr-service-${process.getuid?.() ?? 'user'}`),
  );
  const data = await privateRoot(
    path.resolve(options.dataDirectory ?? defaultLocalDataDirectory()),
  );
  const key = contentHash({ profile: options.profileId, data });
  const socket = path.join(directory, key.slice(0, 24));
  if (Buffer.byteLength(socket) > 100) throw new LocalServiceError('service-unavailable');
  return socket;
}
function errorReply(error: unknown) {
  return { ok: false, error: error instanceof LocalServiceError ? error.code : 'service-invalid' };
}
export async function callLocalService(
  options: LocalServiceLocation,
  request: unknown,
  timeoutMs = 30000,
): Promise<unknown> {
  const address = await localServiceAddress(options);
  const body = Buffer.from(JSON.stringify(request) + '\n');
  if (body.length > maximumFrame) throw new LocalServiceError('service-capacity');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    let received = Buffer.alloc(0),
      settled = false;
    const fail = () => {
      if (!settled) {
        settled = true;
        reject(new LocalServiceError('service-unavailable'));
      }
      socket.destroy();
    };
    socket.setTimeout(timeoutMs, fail);
    socket.on('error', fail);
    socket.on('end', () => {
      if (!settled) fail();
    });
    socket.on('connect', () => socket.write(body));
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > maximumFrame) {
        fail();
        return;
      }
      const end = received.indexOf(10);
      if (end < 0) return;
      try {
        const reply = JSON.parse(
          new TextDecoder('utf8', { fatal: true }).decode(received.subarray(0, end)),
        );
        if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean')
          throw new Error('invalid-reply');
        settled = true;
        if (reply.ok === true) resolve(reply.value);
        else
          reject(
            new LocalServiceError(
              [
                'service-unavailable',
                'service-busy',
                'service-invalid',
                'service-denied',
                'service-capacity',
                'service-interrupted',
              ].includes(reply.error)
                ? reply.error
                : 'service-invalid',
            ),
          );
        socket.destroy();
      } catch {
        fail();
      }
    });
  });
}
export interface LocalServiceOptions extends LocalServiceLocation {
  keys?: LocalKeyStore;
  run(input: {
    job: ServiceJob;
    registration: ServiceRegistration;
    source: FrozenLocalSource;
    signal: AbortSignal;
    bindRequest(request: ReviewRequestRecord): Promise<void>;
  }): Promise<NonNullable<ServiceJob['result']>>;
  reconcile?(input: {
    job: ServiceJob;
    registration: ServiceRegistration;
  }): Promise<NonNullable<ServiceJob['result']> | undefined>;
}
/** Private Unix socket plus an encrypted CAS owner. The service outlives its submitting client. */
export async function startLocalService(options: LocalServiceOptions) {
  const address = await localServiceAddress(options);
  const jobs = await ServiceJobs.open({
    scope: { kind: 'profile', profileId: options.profileId },
    ...(options.dataDirectory ? { dataDirectory: options.dataDirectory } : {}),
    ...(options.keys ? { keys: options.keys } : {}),
  });
  let owner: string;
  try {
    owner = await jobs.acquireOwner();
  } catch (error) {
    jobs.close();
    throw error;
  }
  let stopping = false,
    draining: Promise<void> | undefined,
    active: { job: ServiceJob; controller: AbortController } | undefined;
  let mutation: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = mutation.then(work, work);
    mutation = result.catch(() => undefined);
    return result;
  };
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let serviceFailure: string | undefined;
  const wake = () => {
    if (stopping || draining) return;
    draining = (async () => {
      for (;;) {
        const next = await serial(() => (stopping ? Promise.resolve(undefined) : jobs.next(owner)));
        if (!next) return;
        const controller = new AbortController();
        active = { job: next.job, controller };
        let result: NonNullable<ServiceJob['result']>;
        try {
          result = await options.run({
            ...next,
            signal: controller.signal,
            bindRequest: async (request) => {
              await serial(() => jobs.bindRequest(next.job.id, owner, request));
            },
          });
        } catch {
          result = { exitCode: 2, status: controller.signal.aborted ? 'cancelled' : 'failed' };
        }
        await serial(() => jobs.finish(next.job.id, owner, result));
        active = undefined;
        if (stopping) return;
      }
    })()
      .catch(() => {
        serviceFailure = 'service-invalid';
        active = undefined;
      })
      .finally(() => {
        draining = undefined;
        if (!stopping) {
          wakeTimer = setTimeout(wake, 1000);
          wakeTimer.unref?.();
        }
      });
  };
  const clients = new Set<net.Socket>();
  const watcher = new ServiceWatcher({
    jobs,
    serial,
    wake: () => setImmediate(wake),
    cancel: async (id) => {
      if (active?.job.id === id) {
        active.controller.abort('watch-superseded');
        return;
      }
      return jobs.cancel(id);
    },
  });
  let closePromise: Promise<void> | undefined;
  let closedResolve!: (result: { problem: string | null }) => void;
  const closed = new Promise<{ problem: string | null }>((resolve) => {
    closedResolve = resolve;
  });
  const close = () =>
    (closePromise ??= (async () => {
      stopping = true;
      clearTimeout(wakeTimer);
      active?.controller.abort('service-stopping');
      // A partial frame must not keep a stopped service alive. A stop reply is
      // already queued before close is scheduled; end it before destroying peers.
      for (const socket of clients) socket.destroySoon();
      try {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await watcher.close();
        await draining;
        await mutation;
        await jobs.releaseOwner(owner);
      } catch {
        serviceFailure = 'service-unavailable';
      } finally {
        jobs.close();
        closedResolve({ problem: serviceFailure ?? null });
      }
    })());
  const dispatch = async (request: Record<string, unknown>) => {
    if (stopping) throw new LocalServiceError('service-unavailable');
    switch (request.action) {
      case 'status':
        return {
          status: serviceFailure ? 'degraded' : 'running',
          features: [
            'review-start-budget-v1',
            'headless-watch-v1',
            'editor-save-events-v1',
            ...(options.reconcile ? ['review-reconciliation-v1'] : []),
          ],
          pid: process.pid,
          profileId: options.profileId,
          active: active?.job.id ?? null,
          problem: serviceFailure ?? null,
          watchProblem: watcher.problem ?? null,
          jobs: (await jobs.list()).slice(-200),
        };
      case 'registrations':
        return jobs.registrations();
      case 'registration': {
        if (typeof request.root !== 'string') throw new LocalServiceError('service-invalid');
        const identity = discoverLocalIdentity(request.root, options.profileId);
        return (
          (await jobs.registration(
            contentHash({
              repositoryKey: identity.repositoryKey,
              worktreeKey: identity.worktreeKey,
            }),
          )) ?? null
        );
      }
      case 'register': {
        if (
          typeof request.root !== 'string' ||
          !Array.isArray(request.triggers) ||
          !request.options
        )
          throw new LocalServiceError('service-invalid');
        const registration = await jobs.register(
          request.root,
          request.triggers,
          request.options as ServiceRegistration['options'],
        );
        if (active?.job.repository === registration.key)
          active.controller.abort('registration-changed');
        await watcher.disable(registration.key);
        return registration;
      }
      case 'watch-start':
      case 'watch-stop':
      case 'watch-editor-save':
      case 'watch-editor-detach':
      case 'watch-status': {
        if (typeof request.root !== 'string') throw new LocalServiceError('service-invalid');
        const identity = discoverLocalIdentity(request.root, options.profileId);
        const key = contentHash({
          repositoryKey: identity.repositoryKey,
          worktreeKey: identity.worktreeKey,
        });
        const registration = await jobs.registration(key);
        if (!registration) throw new LocalServiceError('service-denied');
        if (request.action === 'watch-start')
          return watcher.configure(registration, {
            triggers: request.triggers,
            externalChanges: request.externalChanges,
            minimumSaveIntervalMs: request.minimumSaveIntervalMs,
            editor: request.editor,
          });
        if (request.action === 'watch-editor-save')
          return watcher.editorSave(registration, {
            sessionId: request.sessionId,
            file: request.file,
            hash: request.hash,
            reason: request.reason,
          });
        if (request.action === 'watch-editor-detach')
          return watcher.detachEditor(registration, request.sessionId);
        if (request.action === 'watch-stop') await watcher.disable(key);
        return watcher.status(key);
      }
      case 'submit': {
        const job = await jobs.submit(request.input as Parameters<ServiceJobs['submit']>[0]);
        setImmediate(wake);
        return job;
      }
      case 'job':
        return (await jobs.job(String(request.id))) ?? null;
      case 'reconcile':
        if (!options.reconcile) throw new LocalServiceError('service-unavailable');
        return jobs.reconcile(String(request.id), owner, options.reconcile);
      case 'cancel': {
        if (active && active.job.id === request.id) {
          active.controller.abort('user');
          return { status: 'cancelling', id: request.id };
        }
        return jobs.cancel(String(request.id));
      }
      case 'stop':
        setImmediate(() => {
          void close();
        });
        return { status: 'stopping' };
      default:
        throw new LocalServiceError('service-invalid');
    }
  };
  const server = net.createServer((socket) => {
    if (clients.size >= 8) {
      socket.end(JSON.stringify({ ok: false, error: 'service-busy' }) + '\n');
      return;
    }
    clients.add(socket);
    socket.once('close', () => clients.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(30000, () => socket.destroy());
    let input = Buffer.alloc(0),
      handled = false;
    socket.on('data', (chunk) => {
      if (handled) return;
      input = Buffer.concat([input, chunk]);
      if (input.length > maximumFrame) {
        socket.end(JSON.stringify({ ok: false, error: 'service-capacity' }) + '\n');
        handled = true;
        return;
      }
      const end = input.indexOf(10);
      if (end < 0) return;
      handled = true;
      socket.pause();
      let request: Record<string, unknown>;
      try {
        if (end !== input.length - 1) throw new Error('extra-frame');
        request = JSON.parse(
          new TextDecoder('utf8', { fatal: true }).decode(input.subarray(0, end)),
        );
        if (!request || Array.isArray(request) || typeof request !== 'object')
          throw new Error('invalid-frame');
      } catch {
        socket.end(JSON.stringify({ ok: false, error: 'service-invalid' }) + '\n');
        return;
      }
      void serial(() => dispatch(request)).then(
        (value) => socket.end(JSON.stringify({ ok: true, value }) + '\n'),
        (error) => socket.end(JSON.stringify(errorReply(error)) + '\n'),
      );
    });
  });
  try {
    await jobs.recover(owner);
    try {
      const stat = await lstat(address);
      if (!stat.isSocket() || stat.uid !== process.getuid?.())
        throw new LocalServiceError('service-invalid');
      await unlink(address);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    await chmod(address, 0o600);
    server.on('error', () => {
      serviceFailure = 'service-unavailable';
      void close();
    });
    wake();
    watcher.start();
    return { address, closed, close };
  } catch (error) {
    server.close();
    try {
      await jobs.releaseOwner(owner);
    } finally {
      jobs.close();
    }
    throw error;
  }
}
