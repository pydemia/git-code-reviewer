import {
  choice,
  fail,
  id,
  integer,
  list,
  literal,
  object,
  refined,
  sha256,
  sourcePath,
  text,
  timestamp,
  union,
  unique,
} from './codec.js';
import { centralAudience, clientIdentity, snapshotIdentity, sourceFile } from './identity.js';
import { clientReviewReport } from './review.js';

export const REMOTE_REVIEW_MAX_BYTES = 8 * 1024 * 1024;
export const remoteReviewDocument = object({
  id,
  kind: choice(['instructions', 'memory', 'skill']),
  text: text(262144, 1),
  hash: sha256,
});

/** Uploaded context is client-supplied material, never a published central policy. */
export const remoteReviewPayload = refined(
  object({
    schemaVersion: literal(1),
    requestId: id,
    audience: centralAudience,
    clientId: choice(['commit-defender', 'gcr-cli']),
    client: clientIdentity,
    executor: literal('central'),
    model: object({
      accountId: id,
      name: text(256, 1),
      reasoningEffort: choice(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']),
    }),
    source: object({
      provenance: literal('client-captured'),
      snapshot: snapshotIdentity,
      files: list(object({ metadata: sourceFile, text: text(2 * 1024 * 1024) }), 512, 1),
      selected: list(object({ path: sourcePath, side: choice(['base', 'source']) }), 512, 1),
    }),
    context: object({
      provenance: literal('client-supplied'),
      documents: list(remoteReviewDocument, 128),
    }),
    budget: object({
      modelCalls: integer(1, 10),
      durationMs: integer(1000, 600000),
      sourceBytes: integer(1, 33554432),
      toolCalls: integer(1, 1000),
      outputTokensPerCall: integer(1, 32768),
    }),
    retention: object({
      sourceSeconds: integer(60, 86400),
      resultSeconds: integer(60, 2592000),
    }),
  }),
  (value, at) => {
    const key = (file: { path: string; side: string }) => `${file.side}:${file.path}`;
    unique(
      value.source.files.map((file) => key(file.metadata)),
      `${at}.source.files`,
    );
    unique(value.source.selected.map(key), `${at}.source.selected`);
    unique(
      value.context.documents.map((document) => document.id),
      `${at}.context.documents`,
    );
    const files = new Set(value.source.files.map((file) => key(file.metadata)));
    if (value.source.selected.some((file) => !files.has(key(file))))
      fail(at, 'selected source is not uploaded');
    const client = value.client;
    if (
      client.mode === 'centralized' &&
      (['serverId', 'tenantId', 'userId', 'repositoryId'] as const).some(
        (key) => value.audience[key] !== client.audience[key],
      )
    )
      fail(at, 'central knowledge and model audiences differ');
    if (value.retention.sourceSeconds * 1000 < value.budget.durationMs)
      fail(at, 'source retention is shorter than the execution budget');
    if (value.retention.resultSeconds < value.retention.sourceSeconds)
      fail(at, 'result retention is shorter than source retention');
  },
);
export type RemoteReviewPayload = ReturnType<typeof remoteReviewPayload>;

/** Approval binds every byte, the audience, account, budgets and retention, including request ID. */
export const remoteReviewRequest = object({
  payload: remoteReviewPayload,
  approval: object({ payloadHash: sha256, approvedAt: timestamp }),
});
export type RemoteReviewRequest = ReturnType<typeof remoteReviewRequest>;

const receipt = {
  schemaVersion: literal(1),
  requestId: id,
  audience: centralAudience,
  clientId: choice(['commit-defender', 'gcr-cli']),
  payloadHash: sha256,
  receivedAt: timestamp,
  sourceExpiresAt: timestamp,
  resultExpiresAt: timestamp,
};
/** Missing receipts and transport failures are unknown, not permission to submit a new job. */
export const remoteReviewStatus = refined(
  union(
    object({ ...receipt, state: choice(['queued', 'running', 'cancel-requested']) }),
    object({ ...receipt, state: literal('completed'), reportHash: sha256 }),
    object({
      ...receipt,
      state: literal('failed'),
      reason: choice([
        'authorization-revoked',
        'account-unavailable',
        'budget-exhausted',
        'model-failed',
        'invalid-output',
      ]),
    }),
    object({ ...receipt, state: literal('cancelled'), reason: literal('cancelled') }),
    object({ ...receipt, state: literal('uncertain'), reason: literal('execution-lost') }),
    object({
      ...receipt,
      state: literal('expired'),
      reason: choice(['source-expired', 'result-expired']),
    }),
  ),
  (value, at) => {
    if (value.sourceExpiresAt <= value.receivedAt || value.resultExpiresAt <= value.receivedAt)
      fail(at, 'retention deadline precedes receipt');
  },
);
export type RemoteReviewStatus = ReturnType<typeof remoteReviewStatus>;
export const remoteReviewCancel = object({
  schemaVersion: literal(1),
  requestId: id,
  payloadHash: sha256,
});
export const remoteReviewResult = refined(
  object({
    status: remoteReviewStatus,
    report: clientReviewReport,
  }),
  (value, at) => {
    if (value.status.state !== 'completed') fail(at, 'non-completed job has a report');
  },
);
