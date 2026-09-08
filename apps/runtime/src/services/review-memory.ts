import { createHash } from 'node:crypto';
import type {
  ReviewMemoryKind,
  ReviewMemoryScope,
  ReviewMemorySourceKind,
  ReviewMemoryState,
} from '@gcr/contracts';
import type { Database } from '@gcr/db';

export const emptyReviewMemoryHash =
  '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
export const reviewMemoryMaximumItems = 12;
export const reviewMemoryMaximumContextCharacters = 8_000;
export const reviewMemoryMaximumItemCharacters = 1_200;

export type ReviewMemoryRecord = {
  id: string;
  tenantId: string;
  repositoryId: string;
  scope: ReviewMemoryScope;
  ownerUserId: string | null;
  kind: ReviewMemoryKind;
  state: ReviewMemoryState;
  revision: number;
  supersedesId: string | null;
  summary: string;
  detail: string;
  recommendation: string;
  categories: string[];
  filePaths: string[];
  symbols: string[];
  aggregationKey: string;
  contributorCount: number;
  conflictCount: number;
  confidence: number;
  importance: number;
  sourceKind: ReviewMemorySourceKind;
  sourceAnalysisRunId: string | null;
  sourceFindingId: string | null;
  sourceChatMessageId: string | null;
  sourceBaseSha: string | null;
  sourceHeadSha: string | null;
  sourceAnchor: Record<string, unknown>;
  contentHash: string;
  createdBy: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | string | null;
  reviewNote: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  searchText: string;
};

export type ReviewMemoryQuery = {
  tenantId: string;
  repositoryId: string;
  ownerUserId?: string;
  filePaths: string[];
  symbols?: string[];
  categories?: string[];
  queryText?: string;
  approvedBefore?: Date | string;
  maximumItems?: number;
  maximumCharacters?: number;
};

export type ReviewMemoryProjection = Pick<
  ReviewMemoryRecord,
  | 'id'
  | 'scope'
  | 'kind'
  | 'revision'
  | 'summary'
  | 'detail'
  | 'recommendation'
  | 'categories'
  | 'filePaths'
  | 'symbols'
  | 'confidence'
  | 'importance'
  | 'sourceKind'
  | 'sourceAnalysisRunId'
  | 'sourceBaseSha'
  | 'sourceHeadSha'
  | 'sourceAnchor'
  | 'contentHash'
  | 'aggregationKey'
  | 'contributorCount'
  | 'conflictCount'
> & { score: number };

export type ReviewMemorySnapshot = {
  hash: string;
  items: ReviewMemoryProjection[];
};

export type ReviewMemoryAggregation = {
  aggregationKey: string;
  kind: ReviewMemoryKind;
  contributors: ReviewMemoryRecord[];
  conflicts: ReviewMemoryRecord[];
  contributorCount: number;
  conflictCount: number;
  eligible: boolean;
};

export function reviewMemoryContentHash(
  input: Pick<
    ReviewMemoryRecord,
    'kind' | 'summary' | 'detail' | 'recommendation' | 'categories' | 'filePaths' | 'symbols'
  >,
): string {
  return sha256(
    JSON.stringify({
      kind: input.kind,
      summary: normalizeText(input.summary),
      detail: normalizeText(input.detail),
      recommendation: normalizeText(input.recommendation),
      categories: normalizedList(input.categories),
      filePaths: normalizedList(input.filePaths),
      symbols: normalizedList(input.symbols),
    }),
  );
}

export function buildReviewMemorySearchText(
  input: Pick<
    ReviewMemoryRecord,
    'summary' | 'detail' | 'recommendation' | 'categories' | 'filePaths' | 'symbols'
  >,
): string {
  return normalizeText(
    [
      input.summary,
      input.detail,
      input.recommendation,
      ...input.categories,
      ...input.filePaths,
      ...input.symbols,
    ].join(' '),
  );
}

export function reviewMemoryAggregationKey(
  input: Pick<
    ReviewMemoryRecord,
    'kind' | 'categories' | 'filePaths' | 'symbols' | 'summary' | 'sourceAnchor'
  >,
  sourceFingerprint?: string,
): string {
  const anchorFingerprint =
    sourceFingerprint ||
    [
      String(input.sourceAnchor.path ?? ''),
      String(input.sourceAnchor.side ?? ''),
      String(input.sourceAnchor.startLine ?? ''),
    ]
      .map(normalizeText)
      .filter(Boolean)
      .join(':');
  return sha256(
    JSON.stringify({
      topicKind: input.kind === 'false-positive' ? 'recurring-finding' : input.kind,
      categories: normalizedList(input.categories),
      filePaths: normalizedList(input.filePaths),
      symbols: normalizedList(input.symbols),
      anchorFingerprint,
      summary: anchorFingerprint ? '' : normalizeText(input.summary).toLocaleLowerCase(),
    }),
  );
}

export function aggregatePersonalReviewMemories(
  records: ReviewMemoryRecord[],
  quorum = 2,
): ReviewMemoryAggregation[] {
  const groups = new Map<string, ReviewMemoryRecord[]>();
  for (const record of records) {
    if (record.scope !== 'personal' || record.state !== 'active' || !record.ownerUserId) continue;
    const group = groups.get(record.aggregationKey) ?? [];
    if (!group.some(({ ownerUserId }) => ownerUserId === record.ownerUserId)) group.push(record);
    groups.set(record.aggregationKey, group);
  }
  return [...groups.entries()]
    .map(([aggregationKey, group]) => {
      const byKind = new Map<ReviewMemoryKind, ReviewMemoryRecord[]>();
      for (const record of group) {
        const sameKind = byKind.get(record.kind) ?? [];
        sameKind.push(record);
        byKind.set(record.kind, sameKind);
      }
      const [kind, contributors] = [...byKind.entries()].sort(
        (left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]),
      )[0]!;
      const conflicts = group.filter((record) => record.kind !== kind);
      return {
        aggregationKey,
        kind,
        contributors,
        conflicts,
        contributorCount: contributors.length,
        conflictCount: conflicts.length,
        eligible: contributors.length >= Math.max(2, quorum),
      };
    })
    .sort(
      (left, right) =>
        Number(right.eligible) - Number(left.eligible) ||
        right.contributorCount - left.contributorCount ||
        left.aggregationKey.localeCompare(right.aggregationKey),
    );
}

export function rankReviewMemories(
  records: ReviewMemoryRecord[],
  query: Omit<ReviewMemoryQuery, 'tenantId' | 'repositoryId' | 'approvedBefore'>,
): ReviewMemorySnapshot {
  const filePaths = normalizedSet(query.filePaths);
  const symbols = normalizedSet(query.symbols ?? []);
  const categories = normalizedSet(query.categories ?? []);
  const queryTokens = tokenSet(
    [query.queryText ?? '', ...query.filePaths, ...(query.symbols ?? [])].join(' '),
  );
  const maximumItems = Math.max(1, query.maximumItems ?? reviewMemoryMaximumItems);
  const maximumCharacters = Math.max(
    reviewMemoryMaximumItemCharacters,
    query.maximumCharacters ?? reviewMemoryMaximumContextCharacters,
  );
  const seen = new Set<string>();
  let usedCharacters = 0;
  const collectiveKeys = new Set(
    records
      .filter((record) => record.state === 'active' && record.scope === 'collective')
      .map((record) => record.aggregationKey),
  );
  const items = records
    .filter((record) => record.state === 'active')
    .filter((record) => record.scope === 'collective' || !collectiveKeys.has(record.aggregationKey))
    .map((record) => {
      const pathMatches = overlapCount(record.filePaths, filePaths);
      const symbolMatches = overlapCount(record.symbols, symbols);
      const categoryMatches = overlapCount(record.categories, categories);
      const textRank = tokenOverlap(record.searchText, queryTokens);
      const scoped = record.filePaths.length > 0 || record.symbols.length > 0;
      const relevant = !scoped || pathMatches > 0 || symbolMatches > 0 || textRank >= 0.2;
      const score =
        (record.scope === 'collective' ? 100 : 0) +
        pathMatches * 40 +
        symbolMatches * 30 +
        categoryMatches * 15 +
        textRank * 10 +
        record.importance * 3 +
        record.confidence * 2;
      return { record, relevant, score };
    })
    .filter(({ relevant }) => relevant)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.record.revision - left.record.revision ||
        left.record.id.localeCompare(right.record.id),
    )
    .flatMap(({ record, score }) => {
      const dedupeKey = record.contentHash || record.id;
      if (seen.has(dedupeKey)) return [];
      const projection = projectReviewMemory(record, score);
      const size = JSON.stringify(projection).length;
      if (usedCharacters + size > maximumCharacters) return [];
      seen.add(dedupeKey);
      usedCharacters += size;
      return [projection];
    })
    .slice(0, maximumItems);
  return reviewMemorySnapshot(items);
}

export async function recallReviewMemories(
  database: Pick<Database, 'query'>,
  query: ReviewMemoryQuery,
): Promise<ReviewMemorySnapshot> {
  const result = await database.query<ReviewMemoryRecord>(
    `select memory.id, memory.tenant_id as "tenantId", memory.repository_id as "repositoryId",
            memory.scope, memory.owner_user_id as "ownerUserId", memory.kind, memory.state,
            memory.revision, memory.supersedes_id as "supersedesId",
            memory.summary, memory.detail, memory.recommendation, memory.categories,
            memory.file_paths as "filePaths", memory.symbols, memory.confidence,
            memory.importance, memory.aggregation_key as "aggregationKey",
            memory.contributor_count as "contributorCount",
            memory.conflict_count as "conflictCount", memory.source_kind as "sourceKind",
            memory.source_analysis_run_id as "sourceAnalysisRunId",
            memory.source_finding_id as "sourceFindingId",
            memory.source_chat_message_id as "sourceChatMessageId",
            memory.source_base_sha as "sourceBaseSha", memory.source_head_sha as "sourceHeadSha",
            memory.source_anchor as "sourceAnchor", memory.content_hash as "contentHash",
            memory.created_by as "createdBy", memory.reviewed_by as "reviewedBy",
            memory.reviewed_at as "reviewedAt", memory.review_note as "reviewNote",
            memory.created_at as "createdAt", memory.updated_at as "updatedAt",
            memory.search_text as "searchText"
       from review_memories memory
       join repositories repository on repository.id = memory.repository_id
      where memory.tenant_id = $1 and memory.repository_id = $2
        and memory.state = 'active' and repository.enabled
        and (memory.scope = 'collective'
          or ($3::uuid is not null and memory.scope = 'personal' and memory.owner_user_id = $3))
        and ($4::timestamptz is null or memory.reviewed_at <= $4::timestamptz)
      order by memory.reviewed_at desc, memory.created_at desc
      limit 200`,
    [query.tenantId, query.repositoryId, query.ownerUserId ?? null, query.approvedBefore ?? null],
  );
  return rankReviewMemories(result.rows, query);
}

export function reviewMemorySnapshot(items: ReviewMemoryProjection[]): ReviewMemorySnapshot {
  const normalized = [...items].sort(
    (left, right) => left.id.localeCompare(right.id) || left.revision - right.revision,
  );
  const identity = normalized.map(({ id, revision, contentHash }) => ({
    id,
    revision,
    contentHash,
  }));
  return {
    hash: identity.length ? sha256(JSON.stringify(identity)) : emptyReviewMemoryHash,
    items,
  };
}

function projectReviewMemory(record: ReviewMemoryRecord, score: number): ReviewMemoryProjection {
  return {
    id: record.id,
    scope: record.scope,
    kind: record.kind,
    revision: record.revision,
    summary: clip(record.summary, 500),
    detail: clip(record.detail, reviewMemoryMaximumItemCharacters),
    recommendation: clip(record.recommendation, 700),
    categories: record.categories.slice(0, 20),
    filePaths: record.filePaths.slice(0, 100),
    symbols: record.symbols.slice(0, 100),
    confidence: record.confidence,
    importance: record.importance,
    sourceKind: record.sourceKind,
    sourceAnalysisRunId: record.sourceAnalysisRunId,
    sourceBaseSha: record.sourceBaseSha,
    sourceHeadSha: record.sourceHeadSha,
    sourceAnchor: record.sourceAnchor,
    contentHash: record.contentHash,
    aggregationKey: record.aggregationKey,
    contributorCount: record.contributorCount,
    conflictCount: record.conflictCount,
    score: Number(score.toFixed(3)),
  };
}

function overlapCount(values: string[], expected: Set<string>): number {
  return normalizedList(values).filter((value) => expected.has(value)).length;
}

function tokenOverlap(value: string, expected: Set<string>): number {
  if (expected.size === 0) return 0;
  const actual = tokenSet(value);
  let matches = 0;
  for (const token of expected) if (actual.has(token)) matches += 1;
  return matches / expected.size;
}

function tokenSet(value: string): Set<string> {
  return new Set(
    normalizeText(value)
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}_./-]+/u)
      .filter(Boolean),
  );
}

function normalizedSet(values: string[]): Set<string> {
  return new Set(normalizedList(values));
}

function normalizedList(values: string[]): string[] {
  return [
    ...new Set(values.map((value) => normalizeText(value).toLocaleLowerCase()).filter(Boolean)),
  ].sort();
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clip(value: string, maximum: number): string {
  const normalized = normalizeText(value);
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
