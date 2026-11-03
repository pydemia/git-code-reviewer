import {
  boolean,
  choice,
  fail,
  id,
  integer,
  list,
  literal,
  object,
  refined,
  sha256,
  text,
  timestamp,
  union,
  unique,
} from './codec.js';
import { executionIdentity, sourceLocation } from './identity.js';

/** Same question bounds and lifecycle vocabulary as the web chat-run contract,
 * without its database IDs, account selection, or server authorization. */
export const reviewChatQuestionInput = object({
  question: text(2000, 1),
  options: list(text(300, 1), 6),
});
export type ReviewChatQuestionInput = ReturnType<typeof reviewChatQuestionInput>;
export interface ReviewChatQuestionPort {
  askUser(callId: string, argumentsValue: unknown): Promise<string>;
}
export const reviewChatQuestion = object({
  id,
  callId: id,
  question: text(2000, 1),
  options: list(text(300, 1), 6),
  answer: union(text(4000, 1), literal(null)),
  expiresAt: timestamp,
});
export const reviewChatCitation = object({
  readId: id,
  location: sourceLocation,
  excerptHash: sha256,
});
export const reviewChatResponse = object({
  content: text(100_000, 1),
  citations: list(object({ readId: id, startLine: integer(1), endLine: integer(1) }), 100),
});
export type ReviewChatResponse = ReturnType<typeof reviewChatResponse>;
export const reviewChatResponseSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['content', 'citations'],
  properties: {
    content: { type: 'string', minLength: 1, maxLength: 100_000 },
    citations: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['readId', 'startLine', 'endLine'],
        properties: {
          readId: { type: 'string' },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
};
export const reviewChatLimits = object({
  modelCalls: integer(1, 10),
  durationMs: integer(1, 600_000),
  sourceBytes: integer(1, 33_554_432),
  toolCalls: integer(1, 1000),
});
export const reviewChatUsage = object({
  modelCalls: integer(),
  durationMs: integer(),
  sourceBytes: integer(),
  toolCalls: integer(),
});
export const reviewChatTurn = refined(
  object({
    id,
    content: text(4000, 1),
    status: choice([
      'queued',
      'running',
      'awaiting_input',
      'completed',
      'partial',
      'failed',
      'cancelled',
    ]),
    worker: union(id, literal(null)),
    createdAt: timestamp,
    updatedAt: timestamp,
    questions: list(reviewChatQuestion, 10),
    response: union(
      object({ content: text(100_000, 1), citations: list(reviewChatCitation, 100) }),
      literal(null),
    ),
    usage: reviewChatUsage,
    error: union(
      choice([
        'interrupted',
        'cancelled',
        'expired',
        'quota-exceeded',
        'timeout',
        'invalid-output',
        'policy-unavailable',
        'executor-error',
      ]),
      literal(null),
    ),
  }),
  (turn, at) => {
    unique(
      turn.questions.map((q) => q.id),
      at,
    );
    unique(
      turn.questions.map((q) => q.callId),
      at,
    );
    if (turn.updatedAt < turn.createdAt) fail(at, 'invalid chronology');
    if ((turn.status === 'running') !== (turn.worker !== null))
      fail(at, 'invalid worker ownership');
    const unanswered = turn.questions.filter((q) => q.answer === null);
    if (
      unanswered.length > 1 ||
      (turn.status === 'awaiting_input' && unanswered.length !== 1) ||
      (['queued', 'running', 'completed', 'partial'].includes(turn.status) && unanswered.length)
    )
      fail(at, 'invalid question checkpoint');
    if ((turn.response !== null) !== ['completed', 'partial'].includes(turn.status))
      fail(at, 'invalid response state');
  },
);
export type ReviewChatTurn = ReturnType<typeof reviewChatTurn>;
export const localReviewConversation = refined(
  object({
    formatVersion: literal(1),
    id,
    reviewRunId: id,
    identity: executionIdentity,
    limits: reviewChatLimits,
    createdAt: timestamp,
    updatedAt: timestamp,
    turns: list(reviewChatTurn, 100),
    closed: boolean,
  }),
  (chat, at) => {
    unique(
      chat.turns.map((turn) => turn.id),
      at,
    );
    if (chat.updatedAt < chat.createdAt) fail(at, 'invalid chronology');
    for (const [index, turn] of chat.turns.entries()) {
      if (turn.createdAt < chat.createdAt || turn.updatedAt > chat.updatedAt)
        fail(at, 'turn outside conversation');
      if (
        index < chat.turns.length - 1 &&
        ['queued', 'running', 'awaiting_input'].includes(turn.status)
      )
        fail(at, 'unfinished earlier turn');
      if (chat.closed && ['queued', 'running', 'awaiting_input'].includes(turn.status))
        fail(at, 'closed conversation is active');
      for (const key of ['modelCalls', 'durationMs', 'sourceBytes', 'toolCalls'] as const)
        if (turn.usage[key] > chat.limits[key]) fail(at, 'usage exceeds limit');
    }
  },
);
export type LocalReviewConversation = ReturnType<typeof localReviewConversation>;
