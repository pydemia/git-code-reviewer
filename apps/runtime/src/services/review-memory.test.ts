import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  aggregatePersonalReviewMemories,
  buildReviewMemorySearchText,
  emptyReviewMemoryHash,
  rankReviewMemories,
  reviewMemoryAggregationKey,
  reviewMemoryContentHash,
  reviewMemorySnapshot,
  type ReviewMemoryRecord,
} from './review-memory.js';

function memory(overrides: Partial<ReviewMemoryRecord> = {}): ReviewMemoryRecord {
  const base: ReviewMemoryRecord = {
    id: randomUUID(),
    tenantId: randomUUID(),
    repositoryId: randomUUID(),
    scope: 'personal',
    ownerUserId: randomUUID(),
    kind: 'recurring-finding',
    state: 'active',
    revision: 1,
    supersedesId: null,
    summary: '삭제된 행은 일반 조회에서 제외해야 합니다.',
    detail: 'soft delete 정책이 적용됩니다.',
    recommendation: 'deleted_at 조건을 확인합니다.',
    categories: ['correctness'],
    filePaths: ['src/users.ts'],
    symbols: ['listUsers'],
    aggregationKey: '1'.repeat(64),
    contributorCount: 1,
    conflictCount: 0,
    confidence: 0.9,
    importance: 4,
    sourceKind: 'finding',
    sourceAnalysisRunId: randomUUID(),
    sourceFindingId: randomUUID(),
    sourceChatMessageId: null,
    sourceBaseSha: 'a'.repeat(40),
    sourceHeadSha: 'b'.repeat(40),
    sourceAnchor: { path: 'src/users.ts', startLine: 10 },
    contentHash: '0'.repeat(64),
    createdBy: null,
    reviewedBy: randomUUID(),
    reviewedAt: new Date(),
    reviewNote: '',
    createdAt: new Date(),
    updatedAt: new Date(),
    searchText: '',
  };
  const record = { ...base, ...overrides };
  return {
    ...record,
    contentHash: overrides.contentHash ?? reviewMemoryContentHash(record),
    searchText: overrides.searchText ?? buildReviewMemorySearchText(record),
  };
}

describe('review memory ranking', () => {
  it('prioritizes collective memory, then exact personal matches, and excludes unrelated scope', () => {
    const exact = memory({ aggregationKey: '2'.repeat(64) });
    const collective = memory({
      id: randomUUID(),
      scope: 'collective',
      ownerUserId: null,
      kind: 'decision',
      summary: '모든 삭제는 soft delete로 처리합니다.',
      filePaths: [],
      symbols: [],
      aggregationKey: '3'.repeat(64),
      contributorCount: 3,
    });
    const unrelated = memory({
      id: randomUUID(),
      summary: '결제 승인 검증',
      detail: '승인 금액을 확인합니다.',
      recommendation: '',
      filePaths: ['src/payments.ts'],
      symbols: ['approvePayment'],
      aggregationKey: '4'.repeat(64),
    });
    const snapshot = rankReviewMemories([unrelated, exact, collective], {
      filePaths: ['src/users.ts'],
      symbols: ['listUsers'],
      categories: ['correctness'],
      queryText: '사용자 삭제 조회',
    });
    expect(snapshot.items.map(({ id }) => id)).toEqual([collective.id, exact.id]);
    expect(snapshot.items[0]!.score).toBeGreaterThan(snapshot.items[1]!.score);
  });

  it('suppresses personal memory for a topic already represented by collective memory', () => {
    const personal = memory();
    const collective = memory({
      id: randomUUID(),
      scope: 'collective',
      ownerUserId: null,
      contributorCount: 2,
      contentHash: '9'.repeat(64),
    });
    expect(
      rankReviewMemories([personal, collective], { filePaths: ['src/users.ts'] }).items.map(
        ({ id }) => id,
      ),
    ).toEqual([collective.id]);
  });

  it('uses stable content and snapshot hashes independent of input ordering', () => {
    const first = memory();
    const second = memory({ id: randomUUID(), revision: 2, summary: '두 번째 결정' });
    expect(reviewMemoryContentHash(first)).toBe(
      reviewMemoryContentHash({
        ...first,
        categories: [...first.categories].reverse(),
        filePaths: [...first.filePaths].reverse(),
      }),
    );
    expect(reviewMemorySnapshot([firstProjection(first), firstProjection(second)]).hash).toBe(
      reviewMemorySnapshot([firstProjection(second), firstProjection(first)]).hash,
    );
    expect(reviewMemorySnapshot([]).hash).toBe(emptyReviewMemoryHash);
  });

  it('bounds the number and serialized size of recalled items', () => {
    const records = Array.from({ length: 20 }, (_, index) =>
      memory({
        id: randomUUID(),
        summary: `결정 ${index}`,
        detail: '긴 설명 '.repeat(500),
        filePaths: [],
        symbols: [],
      }),
    );
    const snapshot = rankReviewMemories(records, {
      filePaths: [],
      maximumItems: 4,
      maximumCharacters: 5_000,
    });
    expect(snapshot.items.length).toBeLessThanOrEqual(4);
    expect(JSON.stringify(snapshot.items).length).toBeLessThanOrEqual(5_000);
    expect(snapshot.items.every(({ detail }) => detail.length <= 1_200)).toBe(true);
  });

  it('groups recurring findings and false positives under the same aggregation key', () => {
    const finding = memory({ kind: 'recurring-finding' });
    const falsePositive = memory({ ...finding, kind: 'false-positive' });
    expect(reviewMemoryAggregationKey(finding, 'finding-fingerprint')).toBe(
      reviewMemoryAggregationKey(falsePositive, 'finding-fingerprint'),
    );
  });

  it('requires independent users and reports minority conflicts for collective aggregation', () => {
    const aggregationKey = 'a'.repeat(64);
    const first = memory({ aggregationKey, ownerUserId: randomUUID() });
    const duplicateOwner = memory({ aggregationKey, ownerUserId: first.ownerUserId });
    const second = memory({ aggregationKey, ownerUserId: randomUUID() });
    const conflict = memory({
      aggregationKey,
      ownerUserId: randomUUID(),
      kind: 'false-positive',
    });
    const [aggregation] = aggregatePersonalReviewMemories([
      first,
      duplicateOwner,
      second,
      conflict,
    ]);
    expect(aggregation).toMatchObject({
      kind: 'recurring-finding',
      contributorCount: 2,
      conflictCount: 1,
      eligible: true,
    });
  });
});

function firstProjection(record: ReviewMemoryRecord) {
  return rankReviewMemories([record], { filePaths: record.filePaths }).items[0]!;
}
