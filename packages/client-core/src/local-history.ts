import {
  clientReviewReport,
  localScope,
  type ClientReviewReport,
  type LocalScope,
} from '@gcr/client-contract';
import { canonicalJson } from './local-identity.js';
import { LocalStoreError } from './local-errors.js';
import { LocalRecordStore } from './local-records.js';

export interface HistoryRetention {
  reviews: { maxAgeDays: number; maxEntries: number };
  chats: { maxAgeDays: number; maxEntries: number };
}
/** Initial product default; callers can persist a different policy with configureRetention. */
export const DEFAULT_HISTORY_RETENTION: Readonly<HistoryRetention> = Object.freeze({
  reviews: Object.freeze({ maxAgeDays: 90, maxEntries: 1000 }),
  chats: Object.freeze({ maxAgeDays: 90, maxEntries: 1000 }),
});
export interface LocalChatArchive {
  formatVersion: 1;
  id: string;
  scope: LocalScope;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; at: string }>;
}
const invalid = () =>
  new LocalStoreError('corrupt-storage', 'Local history data or retention policy is invalid.');
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key)))
    throw invalid();
  return result;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value))
    throw invalid();
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw invalid();
  return value;
}
function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw invalid();
  return value;
}
function retention(value: unknown): HistoryRetention {
  const policy = record(value, ['reviews', 'chats']);
  const limit = (value: unknown) => {
    const part = record(value, ['maxAgeDays', 'maxEntries']);
    if (
      !Number.isSafeInteger(part.maxAgeDays) ||
      Number(part.maxAgeDays) < 1 ||
      Number(part.maxAgeDays) > 3650 ||
      !Number.isSafeInteger(part.maxEntries) ||
      Number(part.maxEntries) < 1 ||
      Number(part.maxEntries) > 10_000
    )
      throw invalid();
    return { maxAgeDays: Number(part.maxAgeDays), maxEntries: Number(part.maxEntries) };
  };
  return { reviews: limit(policy.reviews), chats: limit(policy.chats) };
}
export function localChatArchive(value: unknown): LocalChatArchive {
  const chat = record(value, [
    'formatVersion',
    'id',
    'scope',
    'title',
    'createdAt',
    'updatedAt',
    'messages',
  ]);
  if (chat.formatVersion !== 1 || !Array.isArray(chat.messages) || chat.messages.length > 10_000)
    throw invalid();
  const createdAt = timestamp(chat.createdAt),
    updatedAt = timestamp(chat.updatedAt);
  if (createdAt > updatedAt) throw invalid();
  let last = createdAt;
  const seen = new Set<string>();
  const messages = Array.from(chat.messages, (value: unknown) => {
    const message = record(value, ['id', 'role', 'content', 'at']);
    const messageId = id(message.id),
      at = timestamp(message.at);
    if (
      seen.has(messageId) ||
      at < last ||
      at > updatedAt ||
      (message.role !== 'user' && message.role !== 'assistant')
    )
      throw invalid();
    last = at;
    seen.add(messageId);
    return {
      id: messageId,
      role: message.role as 'user' | 'assistant',
      content: text(message.content, 1_000_000),
      at,
    };
  });
  return {
    formatVersion: 1,
    id: id(chat.id),
    scope: localScope(chat.scope),
    title: text(chat.title, 4096),
    createdAt,
    updatedAt,
    messages,
  };
}

/** Persistence and retention only. Interactive execution/checkpoints are implemented in P08. */
export class LocalHistoryStore {
  constructor(
    private readonly records: LocalRecordStore,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async getRetention(): Promise<{ revision: number; policy: HistoryRetention }> {
    const stored = await this.records.read('settings', 'history-retention');
    if (!stored) return { revision: 0, policy: retention(DEFAULT_HISTORY_RETENTION) };
    if (stored.deleted) throw invalid();
    const value = record(stored.value, ['formatVersion', 'policy']);
    if (value.formatVersion !== 1) throw invalid();
    return { revision: stored.revision, policy: retention(value.policy) };
  }
  async configureRetention(value: HistoryRetention, expectedRevision: number): Promise<void> {
    const policy = retention(value);
    await this.records.write(
      'settings',
      'history-retention',
      { formatVersion: 1, policy },
      expectedRevision,
    );
  }
  private validateReview(value: unknown): ClientReviewReport {
    const report = clientReviewReport(value);
    const scope = this.records.scope;
    const client = report.identity.client;
    if (
      scope.kind !== 'repository' ||
      client.mode !== 'standalone' ||
      client.profileId !== scope.profileId ||
      client.repositoryKey !== scope.repositoryKey ||
      client.worktreeKey !== scope.worktreeKey ||
      ['queued', 'running'].includes(report.status)
    )
      throw invalid();
    return report;
  }
  private validateChat(value: unknown): LocalChatArchive {
    const chat = localChatArchive(value);
    if (canonicalJson(chat.scope) !== canonicalJson(this.records.scope)) throw invalid();
    return chat;
  }
  async getReview(id: string): Promise<ClientReviewReport | undefined> {
    const stored = await this.records.read('reviews', id);
    if (!stored || stored.deleted) return undefined;
    const review = this.validateReview(stored.value);
    if (review.runId !== id || stored.revision !== 1) throw invalid();
    return review;
  }
  async getChat(id: string): Promise<{ revision: number; chat: LocalChatArchive } | undefined> {
    const stored = await this.records.read('chats', id);
    if (!stored || stored.deleted) return undefined;
    const chat = this.validateChat(stored.value);
    if (chat.id !== id) throw invalid();
    return { revision: stored.revision, chat };
  }
  async saveReview(
    value: ClientReviewReport,
  ): Promise<{ revision: number; retentionPending: boolean }> {
    const report = this.validateReview(value);
    await this.getRetention();
    const stored = await this.records.write('reviews', report.runId, report, 0);
    return { revision: stored.revision, retentionPending: await this.pruneAfterWrite() };
  }
  async saveChat(
    value: LocalChatArchive,
    expectedRevision: number,
  ): Promise<{ revision: number; retentionPending: boolean }> {
    const chat = this.validateChat(value);
    await this.getRetention();
    const previous = await this.getChat(chat.id);
    if (previous && previous.chat.createdAt !== chat.createdAt) throw invalid();
    const stored = await this.records.write('chats', chat.id, chat, expectedRevision);
    return { revision: stored.revision, retentionPending: await this.pruneAfterWrite() };
  }
  private async pruneAfterWrite(): Promise<boolean> {
    try {
      return (await this.prune()).cleanupPending;
    } catch {
      return true;
    }
  }
  async listReviews(): Promise<ClientReviewReport[]> {
    const result: ClientReviewReport[] = [];
    for (const id of await this.records.listIds('reviews')) {
      const review = await this.getReview(id);
      if (review) result.push(review);
    }
    return result.sort(
      (a, b) => b.finishedAt!.localeCompare(a.finishedAt!) || a.runId.localeCompare(b.runId),
    );
  }
  async listChats(): Promise<Array<{ revision: number; chat: LocalChatArchive }>> {
    const result: Array<{ revision: number; chat: LocalChatArchive }> = [];
    for (const id of await this.records.listIds('chats')) {
      const chat = await this.getChat(id);
      if (chat) result.push(chat);
    }
    return result.sort(
      (a, b) =>
        b.chat.updatedAt.localeCompare(a.chat.updatedAt) || a.chat.id.localeCompare(b.chat.id),
    );
  }
  removeReview(id: string): Promise<{ revision: number; cleanupPending: boolean }> {
    return this.records.remove('reviews', id, 1);
  }
  removeChat(id: string, revision: number): Promise<{ revision: number; cleanupPending: boolean }> {
    return this.records.remove('chats', id, revision);
  }
  async prune(): Promise<{ deleted: number; cleanupPending: boolean }> {
    const { policy } = await this.getRetention();
    const now = this.now().getTime();
    if (!Number.isFinite(now)) throw invalid();
    let deleted = 0,
      cleanupPending = false;
    const groups = [
      {
        kind: 'reviews' as const,
        entries: (await this.listReviews()).map((review) => ({
          id: review.runId,
          revision: 1,
          at: review.finishedAt!,
        })),
      },
      {
        kind: 'chats' as const,
        entries: (await this.listChats()).map(({ revision, chat }) => ({
          id: chat.id,
          revision,
          at: chat.updatedAt,
        })),
      },
    ];
    for (const { kind, entries } of groups)
      for (const [index, entry] of entries.entries()) {
        if (
          index < policy[kind].maxEntries &&
          Date.parse(entry.at) > now - policy[kind].maxAgeDays * 86_400_000
        )
          continue;
        try {
          const result = await this.records.remove(kind, entry.id, entry.revision);
          deleted++;
          cleanupPending ||= result.cleanupPending;
        } catch (error) {
          if (!(error instanceof LocalStoreError) || error.code !== 'revision-conflict')
            throw error;
          // Another process may have pruned the record or updated the chat. Do not delete its new revision.
          cleanupPending = true;
        }
      }
    return { deleted, cleanupPending };
  }
}
