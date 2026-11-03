import { randomUUID } from 'node:crypto';
import {
  clientReviewReport,
  localReviewConversation,
  reviewChatQuestionInput,
  reviewChatLimits,
  centralAudience,
  type CentralAudience,
  type ClientReviewReport,
  type LocalReviewConversation,
  type ReviewChatTurn,
} from '@gcr/client-contract';
import { canonicalJson, contentHash } from './local-identity.js';
import { LocalRecordStore } from './local-records.js';
import { LocalStoreError } from './local-errors.js';
import { LocalHistoryStore } from './local-history.js';
import {
  restoreLocalSource,
  type FrozenLocalSource,
  type LocalSourceSnapshot,
} from './source-snapshot.js';
import type { LocalExecutionPolicy } from './review-policy.js';

export class ReviewConversationError extends Error {
  constructor(
    readonly code:
      | 'missing'
      | 'audience-mismatch'
      | 'invalid-state'
      | 'stale-identity'
      | 'expired'
      | 'quota-exceeded',
  ) {
    super(code);
    this.name = 'ReviewConversationError';
  }
}
export interface StoredReviewConversation {
  revision: number;
  conversation: LocalReviewConversation;
  source: FrozenLocalSource;
  review: ClientReviewReport;
}
export const activeReviewChatTurn = (turn: ReviewChatTurn) =>
  ['queued', 'running', 'awaiting_input'].includes(turn.status);
const invalid = () => new ReviewConversationError('invalid-state');
const zeroUsage = () => ({ modelCalls: 0, durationMs: 0, sourceBytes: 0, toolCalls: 0 });

/** One encrypted CAS record contains the fixed source, transcript, question and
 * continuation state. This namespace is separate from legacy transcript archives.
 * Saved identities are comparison data, never a replacement for a fresh policy. */
export class ReviewConversationStore {
  private readonly audience?: CentralAudience;
  constructor(
    private readonly records: LocalRecordStore,
    private readonly now = () => new Date(),
    audience?: CentralAudience,
  ) {
    if (audience) this.audience = Object.freeze(centralAudience(audience));
  }

  private time(previous?: string) {
    const now = this.now().toISOString();
    return previous && previous > now ? previous : now;
  }
  private validate(value: unknown): Omit<StoredReviewConversation, 'revision'> {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'conversation,review,source'
    )
      throw invalid();
    const data = value as Omit<StoredReviewConversation, 'revision'>;
    const conversation = localReviewConversation(data.conversation);
    const client = conversation.identity.client;
    if (
      this.audience
        ? client.mode !== 'centralized' ||
          canonicalJson(client.audience) !== canonicalJson(this.audience)
        : client.mode !== 'standalone'
    )
      throw new ReviewConversationError('audience-mismatch');
    const review = clientReviewReport(data.review);
    const snapshot = restoreLocalSource(data.source);
    try {
      const client = conversation.identity.client,
        scope = this.records.scope;
      if (
        scope.kind !== 'repository' ||
        client.profileId !== scope.profileId ||
        client.repositoryKey !== scope.repositoryKey ||
        client.worktreeKey !== scope.worktreeKey ||
        conversation.reviewRunId !== review.runId ||
        contentHash(conversation.identity) !== contentHash(review.identity) ||
        contentHash(conversation.identity.source) !== contentHash(snapshot.identity) ||
        snapshot.repository.repositoryKey !== scope.repositoryKey ||
        snapshot.repository.worktreeKey !== scope.worktreeKey ||
        !['completed', 'partial', 'needs-context'].includes(review.status)
      )
        throw invalid();
      return { conversation, review, source: snapshot.freeze() };
    } finally {
      snapshot.close();
    }
  }
  async get(id: string): Promise<StoredReviewConversation> {
    const record = await this.records.read('conversations', id);
    if (!record || record.deleted) throw new ReviewConversationError('missing');
    const value = this.validate(record.value);
    if (value.conversation.id !== id) throw invalid();
    return { revision: record.revision, ...value };
  }
  private async write(value: StoredReviewConversation) {
    const data = this.validate({
      conversation: value.conversation,
      source: value.source,
      review: value.review,
    });
    const record = await this.records.write(
      'conversations',
      data.conversation.id,
      data,
      value.revision,
    );
    return { revision: record.revision, ...data };
  }
  async create(input: {
    id: string;
    review: ClientReviewReport;
    snapshot: LocalSourceSnapshot;
    policy: LocalExecutionPolicy;
  }) {
    if (contentHash(input.review.identity) !== contentHash(input.policy.identity))
      throw new ReviewConversationError('stale-identity');
    const { modelCalls, durationMs, sourceBytes, toolCalls } = input.policy.budgets;
    const at = this.time();
    return this.write({
      revision: 0,
      source: input.snapshot.freeze(),
      review: input.review,
      conversation: {
        formatVersion: 1,
        id: input.id,
        reviewRunId: input.review.runId,
        identity: input.policy.identity,
        limits: reviewChatLimits({ modelCalls, durationMs, sourceBytes, toolCalls }),
        createdAt: at,
        updatedAt: at,
        turns: [],
        closed: false,
      },
    });
  }
  async append(id: string, turnId: string, content: string) {
    const stored = await this.get(id),
      chat = stored.conversation;
    const existing = chat.turns.find((t) => t.id === turnId);
    if (existing) {
      if (existing.content !== content) throw invalid();
      return stored;
    }
    if (chat.closed || chat.turns.some(activeReviewChatTurn)) throw invalid();
    const at = this.time(chat.updatedAt);
    chat.turns.push({
      id: turnId,
      content,
      status: 'queued',
      worker: null,
      createdAt: at,
      updatedAt: at,
      questions: [],
      response: null,
      usage: zeroUsage(),
      error: null,
    });
    chat.updatedAt = at;
    return this.write(stored);
  }
  /** The returned worker token and revision fence every result/checkpoint. Unknown
   * execution consumes its entire reservation until explicit interruption closes it. */
  async claim(id: string, turnId: string, policy: LocalExecutionPolicy) {
    const stored = await this.get(id),
      chat = stored.conversation;
    if (
      contentHash(chat.identity) !== contentHash(policy.identity) ||
      canonicalJson(chat.limits) !==
        canonicalJson(
          reviewChatLimits(
            (({ modelCalls, durationMs, sourceBytes, toolCalls }) => ({
              modelCalls,
              durationMs,
              sourceBytes,
              toolCalls,
            }))(policy.budgets),
          ),
        )
    )
      throw new ReviewConversationError('stale-identity');
    const turn = chat.turns.at(-1);
    if (chat.closed || !turn || turn.id !== turnId || turn.status !== 'queued') throw invalid();
    if (
      turn.usage.modelCalls >= chat.limits.modelCalls ||
      turn.usage.durationMs >= chat.limits.durationMs ||
      turn.usage.sourceBytes >= chat.limits.sourceBytes ||
      turn.usage.toolCalls >= chat.limits.toolCalls
    )
      throw new ReviewConversationError('quota-exceeded');
    const previousUsage = { ...turn.usage };
    turn.status = 'running';
    turn.worker = randomUUID();
    turn.usage = { ...chat.limits, modelCalls: previousUsage.modelCalls + 1 };
    turn.updatedAt = chat.updatedAt = this.time(chat.updatedAt);
    return { stored: await this.write(stored), previousUsage };
  }
  private owned(stored: StoredReviewConversation, worker: string) {
    const turn = stored.conversation.turns.at(-1);
    if (!turn || turn.status !== 'running' || turn.worker !== worker) throw invalid();
    return turn;
  }
  async checkpoint(input: {
    stored: StoredReviewConversation;
    worker: string;
    callId: string;
    question: unknown;
    usage: ReviewChatTurn['usage'];
  }) {
    const stored = structuredClone(input.stored),
      turn = this.owned(stored, input.worker);
    const question = reviewChatQuestionInput(input.question);
    const at = this.time(stored.conversation.updatedAt);
    turn.questions.push({
      id: randomUUID(),
      callId: input.callId,
      ...question,
      answer: null,
      expiresAt: new Date(Date.parse(at) + 24 * 60 * 60 * 1000).toISOString(),
    });
    turn.status = 'awaiting_input';
    turn.worker = null;
    turn.usage = input.usage;
    turn.updatedAt = stored.conversation.updatedAt = at;
    return this.write(stored);
  }
  async finish(input: {
    stored: StoredReviewConversation;
    worker: string;
    status: 'completed' | 'partial' | 'failed';
    response: ReviewChatTurn['response'];
    error: ReviewChatTurn['error'];
    usage: ReviewChatTurn['usage'];
  }) {
    const stored = structuredClone(input.stored),
      turn = this.owned(stored, input.worker);
    turn.status = input.status;
    turn.worker = null;
    turn.response = input.response;
    turn.error = input.error;
    turn.usage = input.usage;
    turn.updatedAt = stored.conversation.updatedAt = this.time(stored.conversation.updatedAt);
    return this.write(stored);
  }
  async answer(id: string, turnId: string, questionId: string, answer: string) {
    const stored = await this.get(id),
      chat = stored.conversation;
    const turn = chat.turns.find((t) => t.id === turnId),
      question = turn?.questions.find((q) => q.id === questionId);
    if (!turn || !question) throw invalid();
    if (question.answer !== null) {
      if (question.answer !== answer) throw invalid();
      return stored;
    }
    if (chat.closed || turn.status !== 'awaiting_input') throw invalid();
    if (question.expiresAt <= this.time()) throw new ReviewConversationError('expired');
    question.answer = answer;
    turn.status = 'queued';
    turn.updatedAt = chat.updatedAt = this.time(chat.updatedAt);
    return this.write(stored);
  }
  async cancel(id: string, turnId: string) {
    const stored = await this.get(id),
      turn = stored.conversation.turns.find((t) => t.id === turnId);
    if (!turn) throw invalid();
    if (!activeReviewChatTurn(turn)) return stored;
    turn.status = 'cancelled';
    turn.worker = null;
    turn.error = 'cancelled';
    turn.updatedAt = stored.conversation.updatedAt = this.time(stored.conversation.updatedAt);
    return this.write(stored);
  }
  /** No automatic retry after a process dies: external model acceptance is unknown. */
  async interrupt(id: string, expectedRevision: number) {
    const stored = await this.get(id);
    if (stored.revision !== expectedRevision)
      throw new LocalStoreError('revision-conflict', 'Conversation changed.');
    const turn = stored.conversation.turns.at(-1);
    if (!turn || turn.status !== 'running') throw invalid();
    turn.status = 'failed';
    turn.worker = null;
    turn.error = 'interrupted';
    turn.updatedAt = stored.conversation.updatedAt = this.time(stored.conversation.updatedAt);
    return this.write(stored);
  }
  async list() {
    const result: Array<{ revision: number; conversation: LocalReviewConversation }> = [];
    for (const id of await this.records.listIds('conversations')) {
      try {
        const { revision, conversation } = await this.get(id);
        result.push({ revision, conversation });
      } catch (error) {
        if (
          !(error instanceof ReviewConversationError) ||
          !['missing', 'audience-mismatch'].includes(error.code)
        )
          throw error;
      }
    }
    return result.sort((a, b) => b.conversation.updatedAt.localeCompare(a.conversation.updatedAt));
  }
  async close(id: string) {
    const stored = await this.get(id);
    if (stored.conversation.closed) return stored;
    const turn = stored.conversation.turns.at(-1);
    if (turn && activeReviewChatTurn(turn)) {
      turn.status = 'cancelled';
      turn.worker = null;
      turn.error = 'cancelled';
      turn.updatedAt = this.time(stored.conversation.updatedAt);
    }
    stored.conversation.closed = true;
    stored.conversation.updatedAt = this.time(stored.conversation.updatedAt);
    return this.write(stored);
  }
  /** Reuses the configured chat retention policy. A queued/running process is
   * never evicted by age. Expired user questions are closed before pruning. */
  async prune(): Promise<{ deleted: number; expired: number; cleanupPending: boolean }> {
    const { policy } = await new LocalHistoryStore(this.records, this.now).getRetention();
    const at = this.time();
    let deleted = 0,
      expired = 0,
      cleanupPending = false,
      retained = 0;
    for (const entry of await this.list()) {
      try {
        let stored = await this.get(entry.conversation.id);
        let turn = stored.conversation.turns.at(-1);
        if (turn?.status === 'awaiting_input' && turn.questions.at(-1)!.expiresAt <= at) {
          turn.status = 'cancelled';
          turn.worker = null;
          turn.error = 'expired';
          turn.updatedAt = stored.conversation.updatedAt = at;
          stored = await this.write(stored);
          expired++;
          turn = stored.conversation.turns.at(-1);
        }
        if (turn && activeReviewChatTurn(turn)) continue;
        if (
          retained++ < policy.chats.maxEntries &&
          Date.parse(stored.conversation.updatedAt) >
            Date.parse(at) - policy.chats.maxAgeDays * 86400000
        )
          continue;
        const removed = await this.remove(stored.conversation.id, stored.revision);
        deleted++;
        cleanupPending ||= removed.cleanupPending;
      } catch (error) {
        if (
          (error instanceof LocalStoreError && error.code === 'revision-conflict') ||
          (error instanceof ReviewConversationError && error.code === 'missing')
        )
          cleanupPending = true;
        else throw error;
      }
    }
    return { deleted, expired, cleanupPending };
  }
  async remove(id: string, revision: number) {
    await this.get(id);
    return this.records.remove('conversations', id, revision);
  }
}
