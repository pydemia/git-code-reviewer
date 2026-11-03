import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  centralConnectionReference,
  clientReviewReport,
  reviewSubmission,
  reviewSubmissionReceipt,
  REVIEW_SUBMISSION_RETENTION_MS,
  type CentralAudience,
  type ReviewSubmission,
  type ReviewSubmissionReceipt,
  type ReviewSubmissionStatus,
} from '@gcr/client-contract';
import type { CentralKnowledgeSnapshot } from './central-cache.js';
import { LocalRecordStore, type LocalRecordOptions } from './local-records.js';
import { contentHash, defaultLocalDataDirectory } from './local-identity.js';
import type { CentralConnections } from './central-connection.js';
import { ReviewSubmissionDeliveryError } from './knowledge-http.js';

type Connection = Pick<CentralConnections, 'historyIdentity' | 'status' | 'submitReview'>;
type Entry = {
  formatVersion: 1;
  connectionId: string;
  payload: ReviewSubmission;
  payloadHash: string;
  status: 'pending' | 'sending' | 'submitted' | 'rejected' | 'cancelled';
  attempts: number;
  lease: { owner: string; until: string } | null;
  receipt: ReviewSubmissionReceipt | null;
  lastError: string | null;
};
export class ReviewSubmissionQueueError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ReviewSubmissionQueueError';
  }
}
const fail = (code: string): never => {
  throw new ReviewSubmissionQueueError(code);
};
/** Compare a fresh status with an already verified cache read. This does not
 * publish, synchronize, approve feedback, or claim applicability to source. */
export function reviewSubmissionPolicyState(
  status: ReviewSubmissionStatus,
  snapshot: CentralKnowledgeSnapshot,
  now = Date.now(),
) {
  if (contentHash(status.receipt.audience) !== contentHash(snapshot.manifest.payload.audience))
    return fail('selection-changed');
  const d = status.decision;
  if (!d || d.action === 'dismiss') return 'no-adoption' as const;
  const rule = d.rule!;
  if (rule.state !== 'active') return 'not-active' as const;
  const feedback = d.feedback;
  if (feedback && !feedback.resolution) return 'pending-feedback' as const;
  if (feedback?.resolution?.action === 'reject') return 'feedback-rejected' as const;
  if (feedback?.kind === 'correction' && rule.revision <= feedback.revision)
    return 'acknowledged-only' as const;
  const exception = feedback?.exception;
  if (exception) {
    if (exception.revision !== rule.revision) return 'outdated-exception' as const;
    if (
      exception.revoked ||
      Date.parse(exception.startsAt) > now ||
      Date.parse(exception.expiresAt) <= now
    )
      return 'exception-inactive' as const;
  }
  const policy = snapshot.bundles.policy;
  const item =
    policy.component === 'policy'
      ? policy.criteria.find(
          (x) =>
            x.id === rule.id &&
            x.revision === rule.revision &&
            x.sourceContentHash === rule.contentHash,
        )
      : undefined;
  if (!item || (exception && !item.exceptions.some((x) => x.id === exception.id)))
    return 'awaiting-publication' as const;
  return exception ? ('exception-current' as const) : ('criterion-current' as const);
}
/** There is no timer or sync hook. Queueing requires confirmation of the exact
 * wire payload; sending/retrying is a separate explicit host action. */
export class ReviewSubmissionQueue {
  private constructor(
    private readonly records: LocalRecordStore,
    readonly connectionId: string,
    private readonly connections: Connection,
    private readonly now: () => Date,
  ) {}
  static async open(
    options: LocalRecordOptions & {
      connectionId: string;
      connections: Connection;
      now?: () => Date;
    },
  ) {
    centralConnectionReference(options.connectionId);
    if (options.scope.kind !== 'repository') fail('repository-required');
    const records = await LocalRecordStore.open({
      ...options,
      dataDirectory: path.join(
        options.dataDirectory ?? defaultLocalDataDirectory(),
        'review-submissions',
        options.connectionId,
      ),
    });
    const queue = new ReviewSubmissionQueue(
      records,
      options.connectionId,
      options.connections,
      options.now ?? (() => new Date()),
    );
    try {
      await queue.prune();
      return queue;
    } catch (error) {
      queue.close();
      throw error;
    }
  }
  close() {
    this.records.close();
  }
  private async selected(payload: ReviewSubmission) {
    const identity = await this.connections.historyIdentity(this.connectionId);
    const state = await this.connections.status(this.connectionId);
    if (
      identity.id !== this.connectionId ||
      state.status !== 'connected' ||
      state.clientId !== payload.clientId ||
      contentHash(identity.audience) !== contentHash(payload.audience)
    )
      fail('selection-changed');
  }
  private async entry(id: string, authorize = true) {
    const row = await this.records.read('submissions', id);
    if (!row || row.deleted) return fail('missing');
    const value = row.value as Entry;
    if (
      !value ||
      value.formatVersion !== 1 ||
      value.connectionId !== this.connectionId ||
      !['pending', 'sending', 'submitted', 'rejected', 'cancelled'].includes(value.status) ||
      !Number.isSafeInteger(value.attempts) ||
      value.attempts < 0
    )
      return fail('invalid-record');
    const payload = reviewSubmission(value.payload);
    if (payload.id !== id || value.payloadHash !== contentHash(payload))
      return fail('invalid-record');
    if (
      value.status === 'sending' &&
      (!value.lease || !Number.isFinite(Date.parse(value.lease.until)))
    )
      return fail('invalid-record');
    if (value.receipt) this.verifyReceipt(payload, value.receipt);
    if (authorize) await this.selected(payload);
    return { revision: row.revision, value };
  }
  private verifyReceipt(payload: ReviewSubmission, raw: unknown) {
    const value = reviewSubmissionReceipt(raw);
    if (
      value.requestId !== payload.id ||
      value.payloadHash !== contentHash(payload) ||
      value.kind !== payload.kind ||
      value.clientId !== payload.clientId ||
      contentHash(value.audience) !== contentHash(payload.audience)
    )
      fail('receipt-mismatch');
    return value;
  }
  async get(id: string) {
    return this.entry(id);
  }
  async list() {
    const values = [];
    for (const id of await this.records.listIds('submissions')) {
      const row = await this.records.read('submissions', id);
      if (row && !row.deleted) values.push(await this.entry(id));
    }
    return values;
  }
  async enqueue(raw: unknown, confirmedPayloadHash: string) {
    const payload = reviewSubmission(raw),
      hash = contentHash(payload);
    if (confirmedPayloadHash !== hash) fail('confirmation-required');
    const approved = Date.parse(payload.approvedAt),
      now = this.now().getTime();
    if (approved > now + 60000 || approved < now - REVIEW_SUBMISSION_RETENTION_MS)
      fail('approval-expired');
    await this.selected(payload);
    const previous = await this.records.read('submissions', payload.id);
    if (previous) {
      if (previous.deleted) fail('request-retired');
      const row = await this.entry(payload.id);
      if (row.value.payloadHash !== hash) fail('id-conflict');
      return row;
    }
    if ((await this.list()).length >= 1000) fail('queue-full');
    const value: Entry = {
      formatVersion: 1,
      connectionId: this.connectionId,
      payload,
      payloadHash: hash,
      status: 'pending',
      attempts: 0,
      lease: null,
      receipt: null,
      lastError: null,
    };
    await this.records.write('submissions', payload.id, value, 0);
    return this.entry(payload.id);
  }
  async send(id: string, signal?: AbortSignal, retryRejected = false) {
    const row = await this.entry(id),
      now = this.now();
    if (row.value.status === 'submitted') return row;
    if (row.value.status === 'cancelled') fail('cancelled');
    if (row.value.status === 'rejected' && !retryRejected) fail('explicit-retry-required');
    if (Date.parse(row.value.payload.approvedAt) + REVIEW_SUBMISSION_RETENTION_MS <= now.getTime())
      fail('approval-expired');
    if (row.value.status === 'sending' && Date.parse(row.value.lease!.until) > now.getTime())
      fail('busy');
    if (signal?.aborted) fail('cancelled');
    const value: Entry = {
      ...row.value,
      status: 'sending',
      attempts: row.value.attempts + 1,
      lease: { owner: randomUUID(), until: new Date(now.getTime() + 60000).toISOString() },
      lastError: null,
    };
    const claim = await this.records.write('submissions', id, value, row.revision);
    let result: Entry;
    try {
      const receipt = this.verifyReceipt(
        value.payload,
        await this.connections.submitReview(this.connectionId, value.payload, signal),
      );
      await this.selected(value.payload);
      result = { ...value, status: 'submitted', lease: null, receipt };
    } catch (error) {
      const status = error instanceof ReviewSubmissionDeliveryError ? error.statusCode : undefined;
      const rejected =
        status !== undefined && [400, 401, 403, 404, 409, 410, 413, 426].includes(status);
      result = {
        ...value,
        status: rejected ? 'rejected' : 'pending',
        lease: null,
        lastError: rejected ? `http-${status}` : 'delivery-unconfirmed',
      };
    }
    // If another process reclaimed an abandoned lease, this owner cannot overwrite it.
    await this.records.write('submissions', id, result, claim.revision);
    return this.entry(id);
  }
  async cancel(id: string) {
    const row = await this.entry(id);
    if (row.value.status === 'sending') fail('delivery-unconfirmed');
    if (row.value.status === 'submitted') fail('already-submitted');
    await this.records.write(
      'submissions',
      id,
      {
        ...row.value,
        status: 'cancelled',
        lease: null,
        lastError: row.value.attempts ? 'server-outcome-unconfirmed' : null,
      },
      row.revision,
    );
    return this.entry(id);
  }
  async prune() {
    let deleted = 0;
    for (const id of await this.records.listIds('submissions')) {
      const record = await this.records.read('submissions', id);
      if (!record || record.deleted) continue;
      const row = await this.entry(id, false);
      if (
        Date.parse(row.value.payload.approvedAt) + REVIEW_SUBMISSION_RETENTION_MS >
        this.now().getTime()
      )
        continue;
      if (row.value.lease && Date.parse(row.value.lease.until) > this.now().getTime()) continue;
      await this.records.remove('submissions', row.value.payload.id, row.revision);
      deleted++;
    }
    return { deleted };
  }
}

/** Project only public fields before showing the user the exact submission.
 * Deliberately excludes summaries, finding prose, chat and knowledge entries. */
export function prepareReviewSubmission(input: {
  report: unknown;
  id: string;
  audience: CentralAudience;
  clientId: 'commit-defender' | 'gcr-cli';
  approvedAt: string;
  selection:
    | { kind: 'result' }
    | {
        kind: 'feedback';
        feedbackKind: 'correction' | 'exception' | 'judgment';
        message: string;
        findingId?: string;
        includeSourceReference?: boolean;
      };
}) {
  const report = clientReviewReport(input.report),
    identity = report.identity;
  if (
    identity.client.mode === 'centralized' &&
    contentHash(identity.client.audience) !== contentHash(input.audience)
  )
    fail('selection-changed');
  const common = {
    schemaVersion: 1,
    id: input.id,
    audience: input.audience,
    clientId: input.clientId,
    approvedAt: input.approvedAt,
    visibility: 'repository-reviewers',
    review: {
      runId: report.runId,
      mode: identity.client.mode,
      sourceHash: identity.source.hash,
      contextHash: identity.context.hash,
      snapshot: identity.context.centralSnapshot
        ? { id: identity.context.centralSnapshot.id, hash: identity.context.centralSnapshot.hash }
        : null,
    },
  };
  const selection = input.selection;
  let raw: unknown;
  if (selection.kind === 'result')
    raw = {
      ...common,
      kind: 'result',
      result: {
        status: report.status,
        fileCount: report.files.length,
        findingCount: report.findings.length,
      },
    };
  else {
    const finding = selection.findingId
      ? report.findings.find((f) => f.id === selection.findingId)
      : undefined;
    if (selection.findingId && !finding) fail('finding-missing');
    const rule = finding?.policy.ruleId
      ? identity.context.entries.find(
          (e) =>
            e.origin === 'central' &&
            e.kind === 'policy' &&
            e.id === finding.policy.ruleId &&
            e.revision === finding.policy.ruleRevision,
        )
      : undefined;
    raw = {
      ...common,
      kind: 'feedback',
      feedback: {
        kind: selection.feedbackKind,
        message: selection.message,
        findingId: finding?.id ?? null,
        rule: rule ? { id: rule.id, revision: rule.revision, hash: rule.hash } : null,
        source: selection.includeSourceReference ? (finding?.anchor ?? null) : null,
      },
    };
  }
  const submission = reviewSubmission(raw);
  return { submission, payloadHash: contentHash(submission) };
}
