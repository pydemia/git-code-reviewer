import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  centralConnectionReference,
  remoteReviewHandle,
  type RemoteReviewHandle,
  type RemoteReviewRequest,
  type RemoteReviewStatus,
} from '@gcr/client-contract';
import type { CentralConnections } from './central-connection.js';
import { LocalRecordStore, type LocalRecordOptions } from './local-records.js';
import { contentHash, defaultLocalDataDirectory } from './local-identity.js';
import {
  assertFreshRemoteReviewApproval,
  prepareRemoteReviewHandle,
  verifyRemoteReviewStatus,
  verifyRemoteReviewResult,
  validateRemoteReviewRequest,
  RemoteReviewDeliveryError,
} from './remote-review.js';

type Connection = Pick<
  CentralConnections,
  | 'submitRemoteReview'
  | 'remoteReviewStatus'
  | 'remoteReviewResult'
  | 'cancelRemoteReview'
  | 'status'
>;
type Entry = {
  formatVersion: 1;
  handle: RemoteReviewHandle;
  approvedAt: string;
  cancellationRequested: boolean;
  status: RemoteReviewStatus | null;
};

export class RemoteReviewClientError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RemoteReviewClientError';
  }
}

/** A durable submission fence, not a local model executor. Reopening and polling never send source.
 * Only metadata is retained here; source/knowledge text and report bodies are not stored. */
export class RemoteReviewClient {
  private constructor(
    private readonly records: LocalRecordStore,
    readonly connectionId: string,
    private readonly connections: Connection,
  ) {}
  static async open(
    options: LocalRecordOptions & { connectionId: string; connections: Connection },
  ) {
    centralConnectionReference(options.connectionId);
    if (options.scope.kind !== 'repository')
      throw new RemoteReviewClientError('repository-required');
    const records = await LocalRecordStore.open({
      ...options,
      dataDirectory: path.join(
        options.dataDirectory ?? defaultLocalDataDirectory(),
        'remote-review-receipts',
        options.connectionId,
      ),
    });
    return new RemoteReviewClient(records, options.connectionId, options.connections);
  }
  close() {
    this.records.close();
  }
  private async selected(h: RemoteReviewHandle) {
    const state = await this.connections.status(this.connectionId),
      scope = this.records.scope;
    if (
      state.status !== 'connected' ||
      state.id !== this.connectionId ||
      state.clientId !== h.clientId ||
      contentHash(state.audience) !== contentHash(h.audience) ||
      scope.kind !== 'repository' ||
      scope.profileId !== h.client.profileId ||
      scope.repositoryKey !== h.client.repositoryKey ||
      scope.worktreeKey !== h.client.worktreeKey
    )
      throw new RemoteReviewClientError('remote-selection-changed');
  }
  private async entry(id: string) {
    const row = await this.records.read('submissions', id);
    if (!row || row.deleted) throw new RemoteReviewClientError('remote-request-missing');
    const value = row.value as Entry,
      h = remoteReviewHandle(value?.handle);
    if (
      value.formatVersion !== 1 ||
      h.requestId !== id ||
      typeof value.cancellationRequested !== 'boolean' ||
      !Number.isFinite(Date.parse(value.approvedAt)) ||
      (value.status !== null && !verifyRemoteReviewStatus(h, value.status))
    )
      throw new RemoteReviewClientError('invalid-remote-record');
    await this.selected(h);
    return { revision: row.revision, value: { ...value, handle: h } };
  }
  async get(id: string) {
    return (await this.entry(id)).value;
  }
  async list() {
    const result: Entry[] = [];
    for (const id of await this.records.listIds('submissions')) result.push(await this.get(id));
    return result;
  }
  /** Existing IDs are lookup-only, even if the previous process died before sending. */
  async submit(input: RemoteReviewRequest, signal?: AbortSignal) {
    input = validateRemoteReviewRequest(input, input.payload);
    const handle = prepareRemoteReviewHandle(input);
    await this.selected(handle);
    const previous = await this.records.read('submissions', handle.requestId);
    if (previous) {
      const entry = await this.get(handle.requestId);
      if (contentHash(entry.handle) !== contentHash(handle))
        throw new RemoteReviewClientError('remote-request-conflict');
      return this.refresh(handle.requestId, signal);
    }
    assertFreshRemoteReviewApproval(input);
    const value: Entry = {
      formatVersion: 1,
      handle,
      approvedAt: input.approval.approvedAt,
      cancellationRequested: false,
      status: null,
    };
    // CAS failure must propagate before the network call; another process owns this submission.
    await this.records.write('submissions', handle.requestId, value, 0);
    return this.send(input, signal);
  }
  /** Explicit recovery can resend only the original approved request, with the same idempotency key.
   * A 404, failed transport or cancelled local wait never authorizes this automatically. */
  async retrySubmission(input: RemoteReviewRequest, signal?: AbortSignal) {
    input = validateRemoteReviewRequest(input, input.payload);
    const handle = prepareRemoteReviewHandle(input),
      entry = await this.get(handle.requestId);
    if (
      contentHash(entry.handle) !== contentHash(handle) ||
      entry.approvedAt !== input.approval.approvedAt
    )
      throw new RemoteReviewClientError('remote-request-conflict');
    if (entry.cancellationRequested)
      throw new RemoteReviewClientError('remote-cancellation-requested');
    if (entry.status) return this.refresh(handle.requestId, signal);
    return this.send(input, signal);
  }
  private async send(input: RemoteReviewRequest, signal?: AbortSignal) {
    const entry = await this.get(input.payload.requestId);
    if (entry.cancellationRequested)
      throw new RemoteReviewClientError('remote-cancellation-requested');
    const status = await this.connections.submitRemoteReview(this.connectionId, input, signal);
    return this.saveStatus(entry.handle, status);
  }
  private async saveStatus(handle: RemoteReviewHandle, status: RemoteReviewStatus) {
    const row = await this.entry(handle.requestId);
    const verified = verifyRemoteReviewStatus(handle, status, row.value.status ?? undefined);
    const old = row.value.status;
    // Do not regress a known terminal result or cancellation due to an older concurrent response.
    if (
      old &&
      !['queued', 'running', 'cancel-requested'].includes(old.state) &&
      !(
        old.state === 'completed' &&
        verified.state === 'expired' &&
        verified.reason === 'result-expired'
      )
    )
      return row.value;
    if (old?.state === 'cancel-requested' && ['queued', 'running'].includes(verified.state))
      return row.value;
    if (old?.state === 'running' && verified.state === 'queued') return row.value;
    const value = { ...row.value, status: verified };
    await this.records.write('submissions', handle.requestId, value, row.revision);
    return value;
  }
  async refresh(id: string, signal?: AbortSignal) {
    const entry = await this.get(id);
    const status = await this.connections.remoteReviewStatus(
      this.connectionId,
      entry.handle,
      signal,
    );
    return this.saveStatus(entry.handle, status);
  }
  /** Bounded read-only polling. Stopping the wait never asserts server cancellation. */
  async wait(
    id: string,
    options: { signal?: AbortSignal; timeoutMs?: number; intervalMs?: number } = {},
  ) {
    const timeoutMs = options.timeoutMs ?? 600000,
      intervalMs = options.intervalMs ?? 1000;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 600000 ||
      !Number.isSafeInteger(intervalMs) ||
      intervalMs < 10 ||
      intervalMs > 60000
    )
      throw new RemoteReviewClientError('invalid-wait-budget');
    const controller = new AbortController(),
      abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(abort, timeoutMs);
    try {
      while (!controller.signal.aborted) {
        try {
          const entry = await this.refresh(id, controller.signal);
          if (
            entry.status &&
            !['queued', 'running', 'cancel-requested'].includes(entry.status.state)
          )
            return entry;
        } catch (error) {
          if (
            !(error instanceof RemoteReviewDeliveryError) ||
            error.authorityFailure ||
            !(
              error.code === 'delivery-unconfirmed' ||
              (error.code === 'http-error' &&
                [409, 429, 500, 502, 503, 504].includes(error.statusCode ?? 0))
            )
          )
            throw error;
        }
        await delay(intervalMs, undefined, { signal: controller.signal });
      }
      throw new RemoteReviewDeliveryError('delivery-unconfirmed');
    } catch (error) {
      if (controller.signal.aborted) throw new RemoteReviewDeliveryError('delivery-unconfirmed');
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }
  async result(id: string, signal?: AbortSignal) {
    const entry = await this.get(id);
    const result = verifyRemoteReviewResult(
      entry.handle,
      await this.connections.remoteReviewResult(this.connectionId, entry.handle, signal),
      entry.status ?? undefined,
    );
    const saved = await this.saveStatus(entry.handle, result.status);
    if (saved.status?.state !== 'completed')
      throw new RemoteReviewClientError('remote-result-no-longer-available');
    return result;
  }
  async cancel(id: string, signal?: AbortSignal) {
    const row = await this.entry(id);
    if (!row.value.cancellationRequested)
      await this.records.write(
        'submissions',
        id,
        { ...row.value, cancellationRequested: true },
        row.revision,
      );
    const status = await this.connections.cancelRemoteReview(
      this.connectionId,
      row.value.handle,
      signal,
    );
    return this.saveStatus(row.value.handle, status);
  }
}
