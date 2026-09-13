import {
  choice,
  fail,
  literal,
  object,
  optional,
  refined,
  sha256,
  timestamp,
  union,
} from './codec.js';
export const offlineBehavior = choice([
  'cache-then-standalone',
  'cache-only',
  'standalone',
  'pause',
]);
export type OfflineBehavior = ReturnType<typeof offlineBehavior>;
export const fallbackReason = choice([
  'unavailable',
  'timeout',
  'authentication-required',
  'revoked',
  'disabled',
  'identity-unavailable',
  'incompatible',
  'invalid-manifest',
  'invalid-bundle',
  'cache-unavailable',
]);
export type FallbackReason = ReturnType<typeof fallbackReason>;
/** Execution provenance is part of the identity hash, never a change to saved mode. */
export const reviewExecution = refined(
  object({
    configuredMode: choice(['standalone', 'centralized']),
    effectiveMode: choice(['standalone', 'centralized']),
    knowledgeSource: choice(['local', 'central-online', 'central-cache']),
    fallbackReason: union(fallbackReason, literal(null)),
    connectionId: optional(sha256),
    lastSynchronizedAt: optional(union(timestamp, literal(null))),
  }),
  (value, at) => {
    if (value.configuredMode === 'standalone') {
      if (
        value.effectiveMode !== 'standalone' ||
        value.knowledgeSource !== 'local' ||
        value.fallbackReason !== null ||
        value.connectionId !== undefined
      )
        fail(at, 'standalone configuration contains a central execution');
    } else if (!value.connectionId) fail(at, 'central execution requires its confirmed connection');
    if (value.effectiveMode === 'standalone') {
      if (
        value.knowledgeSource !== 'local' ||
        value.lastSynchronizedAt !== undefined ||
        (value.configuredMode === 'centralized' && value.fallbackReason === null)
      )
        fail(at, 'local fallback provenance is inconsistent');
    } else if (
      value.knowledgeSource === 'local' ||
      (value.knowledgeSource === 'central-online' && value.fallbackReason !== null)
    )
      fail(at, 'central execution provenance is inconsistent');
  },
);
export type ReviewExecution = ReturnType<typeof reviewExecution>;
