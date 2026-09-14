import {
  boolean,
  choice,
  fail,
  id,
  integer,
  list,
  literal,
  object,
  optional,
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
import { localKnowledge } from './knowledge.js';
import { signedKnowledgeManifest } from './knowledge-manifest.js';

export const REMOTE_REVIEW_MAX_BYTES = 8 * 1024 * 1024;
const remoteEffort = choice(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
/** Authorized registry metadata; listing does not probe credentials or promise available quota. */
export const remoteReviewModels = object({
  schemaVersion: literal(1),
  audience: centralAudience,
  clientId: choice(['commit-defender', 'gcr-cli']),
  enabled: boolean,
  outputTokenLimit: literal(false),
  limits: object({
    modelCalls: integer(1, 10),
    durationMs: integer(1000, 600000),
    uploadBytes: integer(1, REMOTE_REVIEW_MAX_BYTES),
    userHourlyCalls: integer(1),
    repositoryHourlyCalls: integer(1),
  }),
  models: list(
    refined(
      object({
        accountId: id,
        accountName: text(256, 1),
        name: text(256, 1),
        displayName: text(256, 1),
        allowedEfforts: list(remoteEffort, 6, 1),
        defaultEffort: remoteEffort,
      }),
      (value, at) => {
        if (!value.allowedEfforts.includes(value.defaultEffort))
          fail(at, 'default effort unavailable');
      },
    ),
    1024,
  ),
});
export type RemoteReviewModels = ReturnType<typeof remoteReviewModels>;
export const remoteReviewDocument = object({
  id,
  kind: choice(['instructions', 'memory', 'skill']),
  text: text(262144, 1),
  hash: sha256,
});
export const remoteReviewResolvedContext = object({
  version: literal(1),
  client: clientIdentity,
  sourceHash: sha256,
  originalContextHash: sha256,
  builtin: object({ id, revision: integer(1), hash: sha256 }),
  knowledge: list(localKnowledge, 128),
  requiredSources: list(object({ path: sourcePath, side: choice(['source', 'base']) }), 512),
  validUntil: union(timestamp, literal(null)),
  central: optional(
    object({
      manifest: signedKnowledgeManifest,
      selection: object({
        now: timestamp,
        byteLimit: integer(0, 1048576),
        branch: union(sourcePath, literal(null)),
      }),
      selectionHash: sha256,
    }),
  ),
});
export type RemoteReviewResolvedContext = ReturnType<typeof remoteReviewResolvedContext>;
const remoteReviewChange = refined(
  object({
    path: sourcePath,
    side: choice(['base', 'source']),
    status: choice(['A', 'M', 'D', 'R', 'T']),
    oldPath: optional(sourcePath),
    base: choice(['uploaded', 'absent', 'unavailable']),
  }),
  (value, at) => {
    if ((value.status === 'D') !== (value.side === 'base')) fail(at, 'change side mismatch');
    if ((value.status === 'R') !== (value.oldPath !== undefined) || value.oldPath === value.path)
      fail(at, 'rename path mismatch');
    if (
      (value.status === 'A' && value.base !== 'absent') ||
      (value.status === 'D' && value.base !== 'uploaded') ||
      (value.status === 'R' && value.base === 'absent')
    )
      fail(at, 'change base mismatch');
  },
);

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
      // Legacy receipts remain decodable; execution requires this approved description.
      review: optional(object({ changes: list(remoteReviewChange, 200, 1), incomplete: boolean })),
    }),
    context: object({
      provenance: literal('client-supplied'),
      documents: list(remoteReviewDocument, 128),
      resolved: optional(remoteReviewResolvedContext),
    }),
    budget: object({
      modelCalls: integer(1, 10),
      durationMs: integer(1000, 600000),
      sourceBytes: integer(1, 33554432),
      toolCalls: integer(1, 1000),
      outputTokensPerCall: optional(integer(1, 32768)),
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
    const review = value.source.review;
    if (review) {
      unique(
        review.changes.map((change) => change.path),
        `${at}.source.review.changes`,
      );
      const selected = new Set(value.source.selected.map(key));
      if (
        review.changes.length !== selected.size ||
        review.changes.some((change) => !selected.has(key(change)))
      )
        fail(at, 'change selection mismatch');
      for (const change of review.changes) {
        if (files.has(`base:${change.oldPath ?? change.path}`) !== (change.base === 'uploaded'))
          fail(at, 'base upload mismatch');
        if (change.status === 'D' && files.has(`source:${change.path}`))
          fail(at, 'deleted source is uploaded');
      }
    }
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

/** Persist before submission. Contains verification metadata, never uploaded source or knowledge text. */
export const remoteReviewHandle = object({
  schemaVersion: literal(1),
  requestId: id,
  audience: centralAudience,
  clientId: choice(['commit-defender', 'gcr-cli']),
  payloadHash: sha256,
  client: clientIdentity,
  source: snapshotIdentity,
  sourceFiles: list(sourceFile, 512, 1),
  selected: list(object({ path: sourcePath, side: choice(['base', 'source']) }), 512, 1),
  contextHash: sha256,
  model: text(256, 1),
  executorConfigHash: sha256,
  sourceSeconds: integer(60, 86400),
  resultSeconds: integer(60, 2592000),
});
export type RemoteReviewHandle = ReturnType<typeof remoteReviewHandle>;

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
        'context-unavailable',
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
