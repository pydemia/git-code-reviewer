import {
  choice,
  id,
  integer,
  list,
  literal,
  object,
  refined,
  fail,
  sha256,
  union,
  unique,
} from './codec.js';
import { executionIdentity } from './identity.js';
export const reviewTrigger = choice([
  'manual',
  'work_completed',
  'save',
  'stage',
  'commit',
  'push',
]);
export type ReviewTrigger = ReturnType<typeof reviewTrigger>;
export const reviewRequestRecord = refined(
  object({
    formatVersion: literal(1),
    key: sha256,
    identity: executionIdentity,
    reasons: list(reviewTrigger, 6, 1),
    state: choice(['queued', 'claimed', 'running', 'finished', 'interrupted']),
    generation: integer(),
    createdAt: integer(),
    updatedAt: integer(),
    owner: union(object({ token: id, deadline: integer() }), literal(null)),
    resultId: union(id, literal(null)),
  }),
  (value, at) => {
    unique(value.reasons, at);
    if ((value.state === 'claimed' || value.state === 'running') !== (value.owner !== null))
      fail(at, 'request ownership does not match state');
    if ((value.state === 'finished') !== (value.resultId !== null))
      fail(at, 'request result does not match state');
    if (value.updatedAt < value.createdAt) fail(at, 'request time moved backwards');
  },
);
export type ReviewRequestRecord = ReturnType<typeof reviewRequestRecord>;
export const reviewStartLedger = object({
  formatVersion: literal(1),
  observedAt: integer(),
  reservations: list(
    object({ key: sha256, generation: integer(), at: integer(), reason: reviewTrigger }),
    1000,
  ),
});
