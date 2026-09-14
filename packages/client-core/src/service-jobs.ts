import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  reviewTrigger,
  reviewRequestRecord,
  type ReviewRequestRecord,
  type ReviewTrigger,
} from '@gcr/client-contract';
import { reviewRequestKey } from './review-requests.js';
import { LocalRecordStore, type LocalRecordOptions } from './local-records.js';
import { LocalStoreError } from './local-errors.js';
import { contentHash, defaultLocalDataDirectory, discoverLocalIdentity } from './local-identity.js';
import { restoreLocalSource, type FrozenLocalSource } from './source-snapshot.js';
import { sourcePathPolicy } from './source-policy.js';

export class LocalServiceError extends Error {
  constructor(
    readonly code:
      | 'service-unavailable'
      | 'service-busy'
      | 'service-invalid'
      | 'service-denied'
      | 'service-capacity'
      | 'service-interrupted',
  ) {
    super(code);
    this.name = 'LocalServiceError';
  }
}
export interface ServiceReviewOptions {
  mode: 'standalone' | 'centralized';
  connectionId?: string;
  executorPath?: string;
  model: 'gpt-6-astra';
  reasoningEffort: 'xhigh';
  excludePatterns: string[];
  allowPaths: string[];
  durationMs: number;
  sourceBytes: number;
  toolCalls: number;
  maximumReviewsPerHour?: number;
}
export interface ServiceRegistration {
  version: 1;
  key: string;
  root: string;
  repositoryKey: string;
  worktreeKey: string;
  revision: number;
  triggers: ReviewTrigger[];
  options: ServiceReviewOptions;
}
export interface ServiceJob {
  version: 1;
  id: string;
  repository: string;
  registrationRevision: number;
  trigger: ReviewTrigger;
  sourceHash: string;
  payloadHash: string;
  createdAt: number;
  state: 'queued' | 'running' | 'finished' | 'cancelled' | 'interrupted';
  owner: string | null;
  notBefore?: number;
  result?: {
    exitCode: 0 | 1 | 2;
    status: string;
    runId?: string;
    retryAt?: number;
    completionUnconfirmed?: boolean;
  };
  cleanupPending?: boolean;
  execution?: { key: string; generation: number };
}
interface Owner {
  version: 1;
  pid: number | null;
  token: string | null;
}
const validId = (id: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
const invalid = () => new LocalServiceError('service-invalid');
function reviewOptions(input: ServiceReviewOptions): ServiceReviewOptions {
  const value = structuredClone(input);
  value.maximumReviewsPerHour ??= 6;
  if (
    !value ||
    !['standalone', 'centralized'].includes(value.mode) ||
    value.model !== 'gpt-6-astra' ||
    value.reasoningEffort !== 'xhigh' ||
    (value.mode === 'standalone' && value.connectionId !== undefined) ||
    (value.mode === 'centralized' &&
      (typeof value.connectionId !== 'string' ||
        !value.connectionId ||
        value.connectionId.length > 128)) ||
    (value.executorPath !== undefined &&
      (typeof value.executorPath !== 'string' || !path.isAbsolute(value.executorPath)))
  )
    throw invalid();
  for (const [field, max] of [
    ['durationMs', 600000],
    ['sourceBytes', 33554432],
    ['toolCalls', 1000],
    ['maximumReviewsPerHour', 100],
  ] as const)
    if (!Number.isInteger(value[field]) || value[field]! < 1 || value[field]! > max)
      throw invalid();
  for (const values of [value.excludePatterns, value.allowPaths])
    if (
      !Array.isArray(values) ||
      values.length > 256 ||
      values.some((v) => typeof v !== 'string' || !v || v.length > 1024)
    )
      throw invalid();
  sourcePathPolicy(value.excludePatterns);
  if (!value.allowPaths.length) throw invalid();
  return value;
}
/** Profile-owned encrypted registrations, source payloads and service receipts.
 * The model's full source/context/executor deduplication remains in ReviewRequests. */
export class ServiceJobs {
  private constructor(
    private readonly records: LocalRecordStore,
    readonly profileId: string,
  ) {}
  static async open(options: LocalRecordOptions) {
    if (options.scope.kind !== 'profile') throw invalid();
    return new ServiceJobs(
      await LocalRecordStore.open({
        ...options,
        dataDirectory: path.join(
          options.dataDirectory ?? defaultLocalDataDirectory(),
          'local-service',
        ),
      }),
      options.scope.profileId,
    );
  }
  close() {
    this.records.close();
  }
  async acquireOwner(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const row = await this.records.read('settings', 'owner');
      const owner = row && !row.deleted ? (row.value as Owner) : undefined;
      if (owner?.pid) {
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.version !== 1)
          throw invalid();
        try {
          process.kill(owner.pid, 0);
          throw new LocalServiceError('service-busy');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
            throw new LocalServiceError('service-busy');
        }
      }
      const token = randomUUID();
      try {
        await this.records.write(
          'settings',
          'owner',
          { version: 1, pid: process.pid, token },
          row?.revision ?? 0,
        );
        return token;
      } catch (error) {
        if (!(error instanceof LocalStoreError) || error.code !== 'revision-conflict') throw error;
      }
    }
    throw new LocalServiceError('service-busy');
  }
  async assertOwner(token: string) {
    const row = await this.records.read('settings', 'owner');
    const owner = row && !row.deleted ? (row.value as Owner) : undefined;
    if (owner?.token !== token || owner.pid !== process.pid)
      throw new LocalServiceError('service-interrupted');
  }
  async releaseOwner(token: string) {
    await this.assertOwner(token);
    const row = await this.records.read('settings', 'owner');
    await this.records.write(
      'settings',
      'owner',
      { version: 1, pid: null, token: null },
      row!.revision,
    );
  }
  async register(
    root: string,
    triggers: ReviewTrigger[],
    options: ServiceReviewOptions,
  ): Promise<ServiceRegistration> {
    root = await realpath(root);
    const identity = discoverLocalIdentity(root, this.profileId);
    const key = contentHash({
      repositoryKey: identity.repositoryKey,
      worktreeKey: identity.worktreeKey,
    });
    const allowed = [...new Set(triggers.map((t) => reviewTrigger(t)))].sort();
    const row = await this.records.read('settings', `repo_${key}`);
    const registration: ServiceRegistration = {
      version: 1,
      key,
      root,
      repositoryKey: identity.repositoryKey,
      worktreeKey: identity.worktreeKey,
      revision: (row?.revision ?? 0) + 1,
      triggers: allowed,
      options: reviewOptions(options),
    };
    await this.records.write('settings', `repo_${key}`, registration, row?.revision ?? 0);
    return registration;
  }
  async registration(key: string): Promise<ServiceRegistration | undefined> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw invalid();
    const row = await this.records.read('settings', `repo_${key}`);
    if (!row || row.deleted) return;
    const value = row.value as ServiceRegistration;
    if (
      value.version !== 1 ||
      value.key !== key ||
      value.revision !== row.revision ||
      !path.isAbsolute(value.root) ||
      contentHash({ repositoryKey: value.repositoryKey, worktreeKey: value.worktreeKey }) !== key ||
      !Array.isArray(value.triggers)
    )
      throw invalid();
    value.triggers.forEach((t) => reviewTrigger(t));
    reviewOptions(value.options);
    return value;
  }
  async registrations() {
    const result: ServiceRegistration[] = [];
    for (const id of await this.records.listIds('settings'))
      if (id.startsWith('repo_')) {
        const row = await this.registration(id.slice(5));
        if (row) result.push(row);
      }
    return result;
  }
  async job(id: string): Promise<ServiceJob | undefined> {
    if (!validId(id)) throw invalid();
    const row = await this.records.read('settings', `job_${id}`);
    if (!row || row.deleted) return;
    const value = row.value as ServiceJob;
    if (
      value.version !== 1 ||
      value.id !== id ||
      !['queued', 'running', 'finished', 'cancelled', 'interrupted'].includes(value.state) ||
      !Number.isSafeInteger(value.createdAt) ||
      !Number.isInteger(value.registrationRevision) ||
      !Number.isInteger(row.revision) ||
      !/^[a-f0-9]{64}$/.test(value.repository) ||
      !/^[a-f0-9]{64}$/.test(value.sourceHash) ||
      !/^[a-f0-9]{64}$/.test(value.payloadHash)
    )
      throw invalid();
    reviewTrigger(value.trigger);
    if (
      value.execution &&
      (!/^[a-f0-9]{64}$/.test(value.execution.key) ||
        !Number.isSafeInteger(value.execution.generation) ||
        value.execution.generation < 1)
    )
      throw invalid();
    return value;
  }
  async list() {
    const jobs: ServiceJob[] = [];
    for (const id of await this.records.listIds('settings'))
      if (id.startsWith('job_')) {
        const job = await this.job(id.slice(4));
        if (job) jobs.push(job);
      }
    return jobs.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  async submit(input: {
    id: string;
    repository: string;
    registrationRevision: number;
    trigger: ReviewTrigger;
    source: FrozenLocalSource;
  }) {
    if (!validId(input.id)) throw invalid();
    reviewTrigger(input.trigger);
    const registration = await this.registration(input.repository);
    if (
      !registration ||
      registration.revision !== input.registrationRevision ||
      !registration.triggers.includes(input.trigger)
    )
      throw new LocalServiceError('service-denied');
    const snapshot = restoreLocalSource(input.source);
    try {
      if (
        snapshot.repository.repositoryKey !== registration.repositoryKey ||
        snapshot.repository.worktreeKey !== registration.worktreeKey ||
        contentHash(input.source.excludePatterns) !==
          contentHash(registration.options.excludePatterns)
      )
        throw new LocalServiceError('service-denied');
      if (input.trigger === 'commit' || input.trigger === 'stage') {
        if (snapshot.identity.kind !== 'index') throw invalid();
      }
      if (
        (input.trigger === 'push' && snapshot.identity.kind !== 'commit-tree') ||
        (input.trigger === 'save' && snapshot.identity.kind !== 'working-tree')
      )
        throw invalid();
      const payloadHash = contentHash(input.source),
        old = await this.job(input.id);
      if (old) {
        if (
          old.repository !== input.repository ||
          old.registrationRevision !== input.registrationRevision ||
          old.trigger !== input.trigger ||
          old.payloadHash !== payloadHash
        )
          throw invalid();
        return old;
      }
      if (
        (await this.list()).filter(
          (j) => j.state === 'queued' || j.state === 'running' || j.state === 'interrupted',
        ).length >= 64
      )
        throw new LocalServiceError('service-capacity');
      const payloadId = `payload_${input.id}`,
        existing = await this.records.read('chats', payloadId);
      if (existing) {
        if (existing.deleted || contentHash(existing.value) !== payloadHash) throw invalid();
      } else await this.records.write('chats', payloadId, input.source, 0);
      const job: ServiceJob = {
        version: 1,
        id: input.id,
        repository: input.repository,
        registrationRevision: registration.revision,
        trigger: input.trigger,
        sourceHash: snapshot.identity.hash,
        payloadHash,
        createdAt: Date.now(),
        state: 'queued',
        owner: null,
      };
      await this.records.write('settings', `job_${job.id}`, job, 0);
      return job;
    } finally {
      snapshot.close();
    }
  }
  private async update(job: ServiceJob, expected: ServiceJob) {
    const row = await this.records.read('settings', `job_${job.id}`);
    if (!row || row.deleted) throw invalid();
    if (contentHash(row.value) !== contentHash(expected))
      throw new LocalServiceError('service-busy');
    await this.records.write('settings', `job_${job.id}`, job, row.revision);
    return job;
  }
  async recover(token: string) {
    await this.assertOwner(token);
    for (const job of await this.list())
      if (job.state === 'running')
        await this.update({ ...job, state: 'interrupted', owner: null }, job);
  }
  async bindRequest(id: string, token: string, input: ReviewRequestRecord) {
    await this.assertOwner(token);
    const job = await this.job(id),
      request = reviewRequestRecord(input);
    if (!job || job.state !== 'running' || job.owner !== token)
      throw new LocalServiceError('service-interrupted');
    const registration = await this.registration(job.repository),
      client = request.identity.client;
    if (
      !registration ||
      registration.revision !== job.registrationRevision ||
      !registration.triggers.includes(job.trigger) ||
      client.profileId !== this.profileId ||
      client.repositoryKey !== registration.repositoryKey ||
      client.worktreeKey !== registration.worktreeKey ||
      request.identity.source.hash !== job.sourceHash ||
      reviewRequestKey(request.identity) !== request.key ||
      !request.reasons.includes(job.trigger) ||
      (registration.options.mode === 'centralized'
        ? client.execution?.configuredMode !== 'centralized' ||
          client.execution.connectionId !== registration.options.connectionId
        : client.mode !== 'standalone' || client.execution?.configuredMode === 'centralized') ||
      request.generation < 1 ||
      !['claimed', 'running', 'finished'].includes(request.state)
    )
      throw new LocalServiceError('service-denied');
    const execution = { key: request.key, generation: request.generation };
    if (job.execution && contentHash(job.execution) !== contentHash(execution)) throw invalid();
    return this.update({ ...job, execution }, job);
  }
  async reconcile(
    id: string,
    token: string,
    inspect: (input: {
      job: ServiceJob;
      registration: ServiceRegistration;
    }) => Promise<NonNullable<ServiceJob['result']> | undefined>,
  ) {
    await this.assertOwner(token);
    const job = await this.job(id);
    if (!job) throw invalid();
    if (job.state !== 'interrupted' || !job.execution) return job;
    const registration = await this.registration(job.repository);
    if (
      !registration ||
      registration.revision !== job.registrationRevision ||
      !registration.triggers.includes(job.trigger)
    )
      throw new LocalServiceError('service-denied');
    const result = await inspect({ job, registration });
    if (!result) return job;
    if (
      ![0, 1, 2].includes(result.exitCode) ||
      !result.runId ||
      !validId(result.runId) ||
      ![
        'completed',
        'partial',
        'failed',
        'cancelled',
        'needs-context',
        'unavailable',
        'superseded',
      ].includes(result.status)
    )
      throw invalid();
    await this.assertOwner(token);
    const current = await this.registration(job.repository);
    if (current?.revision !== registration.revision) throw new LocalServiceError('service-denied');
    const done = await this.update({ ...job, state: 'finished', owner: null, result }, job);
    await this.purgePayload(done);
    return done;
  }
  async next(token: string) {
    await this.assertOwner(token);
    for (const job of await this.list()) {
      if (job.state !== 'queued') continue;
      const registration = await this.registration(job.repository);
      if (
        !registration ||
        registration.revision !== job.registrationRevision ||
        !registration.triggers.includes(job.trigger)
      ) {
        await this.cancel(job.id);
        continue;
      }
      if (job.notBefore && job.notBefore > Date.now()) continue;
      const row = await this.records.read('chats', `payload_${job.id}`);
      if (!row || row.deleted || contentHash(row.value) !== job.payloadHash) throw invalid();
      const source = restoreLocalSource(row.value);
      source.close();
      await this.update({ ...job, state: 'running', owner: token }, job);
      return {
        job: { ...job, state: 'running' as const, owner: token },
        registration,
        source: row.value as FrozenLocalSource,
      };
    }
  }
  private async purgePayload(job: ServiceJob) {
    try {
      const id = `payload_${job.id}`,
        row = await this.records.read('chats', id);
      if (row && !row.deleted) {
        const removed = await this.records.remove('chats', id, row.revision);
        if (removed.cleanupPending) await this.update({ ...job, cleanupPending: true }, job);
      }
    } catch {
      await this.update({ ...job, cleanupPending: true }, job);
    }
  }
  async finish(id: string, token: string, result: NonNullable<ServiceJob['result']>) {
    await this.assertOwner(token);
    const job = await this.job(id);
    if (!job || job.state !== 'running' || job.owner !== token)
      throw new LocalServiceError('service-interrupted');
    if (
      ![0, 1, 2].includes(result.exitCode) ||
      typeof result.status !== 'string' ||
      result.status.length > 128 ||
      (result.runId !== undefined && !validId(result.runId))
    )
      throw invalid();
    if (
      result.status === 'deferred' &&
      result.exitCode === 2 &&
      Number.isSafeInteger(result.retryAt) &&
      result.retryAt! > Date.now()
    ) {
      const queued = { ...job, state: 'queued' as const, owner: null, notBefore: result.retryAt! };
      delete queued.execution;
      return this.update(queued, job);
    }
    if (result.completionUnconfirmed)
      return this.update({ ...job, state: 'interrupted', owner: null, result }, job);
    const done = await this.update({ ...job, state: 'finished', owner: null, result }, job);
    await this.purgePayload(done);
    return done;
  }
  async cancel(id: string) {
    const job = await this.job(id);
    if (!job) throw invalid();
    if (job.state === 'running') throw new LocalServiceError('service-busy');
    if (job.state !== 'queued' && job.state !== 'interrupted') return job;
    const done = await this.update({ ...job, state: 'cancelled', owner: null }, job);
    await this.purgePayload(done);
    return done;
  }
}
