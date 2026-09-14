import {
  choice,
  fail,
  id,
  integer,
  literal,
  object,
  refined,
  sha256,
  text,
  timestamp,
  union,
} from './codec.js';
import { centralAudience, sourceLocation } from './identity.js';

/** Public, explicitly selected data only. A report, chat, source body or knowledge
 * entry is deliberately not accepted by this wire contract. */
const reviewReference = object({
  runId: id,
  mode: choice(['standalone', 'centralized']),
  sourceHash: sha256,
  contextHash: sha256,
  snapshot: union(object({ id, hash: sha256 }), literal(null)),
});
const common = {
  schemaVersion: literal(1),
  id,
  audience: centralAudience,
  clientId: choice(['commit-defender', 'gcr-cli']),
  approvedAt: timestamp,
  visibility: literal('repository-reviewers'),
  review: reviewReference,
};
export const reviewSubmission = refined(
  union(
    object({
      ...common,
      kind: literal('result'),
      result: object({
        status: choice([
          'completed',
          'partial',
          'failed',
          'cancelled',
          'needs-context',
          'unavailable',
          'superseded',
        ]),
        fileCount: integer(0, 100000),
        findingCount: integer(0, 100000),
      }),
    }),
    object({
      ...common,
      kind: literal('feedback'),
      feedback: object({
        kind: choice(['correction', 'exception', 'judgment']),
        message: text(4000, 1),
        findingId: union(id, literal(null)),
        rule: union(object({ id, revision: integer(1), hash: sha256 }), literal(null)),
        source: union(sourceLocation, literal(null)),
      }),
    }),
  ),
  (value, at) => {
    if ((value.review.mode === 'centralized') !== (value.review.snapshot !== null))
      fail(at, 'snapshot does not match review mode');
    if (value.kind === 'feedback') {
      if (!value.feedback.message.trim()) fail(at, 'feedback message is empty');
      if (value.review.mode === 'standalone' && value.feedback.rule)
        fail(at, 'standalone review cannot claim a central rule');
      const source = value.feedback.source;
      if (source && (source.startLine < 1 || source.endLine < source.startLine))
        fail(at, 'invalid source range');
    }
  },
);
export type ReviewSubmission = ReturnType<typeof reviewSubmission>;
export const reviewSubmissionReceipt = object({
  schemaVersion: literal(1),
  id,
  requestId: id,
  payloadHash: sha256,
  audience: centralAudience,
  clientId: choice(['commit-defender', 'gcr-cli']),
  kind: choice(['result', 'feedback']),
  status: literal('submitted'),
  evidence: literal('client-reported'),
  receivedAt: timestamp,
  expiresAt: timestamp,
});
export type ReviewSubmissionReceipt = ReturnType<typeof reviewSubmissionReceipt>;
export const REVIEW_SUBMISSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Canonical bytes for confirmation and idempotency; object keys use code-unit order. */
export function reviewSubmissionJson(raw: unknown): string {
  const encode = (value: unknown): string => {
    if (value !== null && typeof value === 'object') {
      if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  };
  return encode(reviewSubmission(raw));
}
