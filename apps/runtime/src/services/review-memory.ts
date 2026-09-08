import { createHash } from 'node:crypto';
import type {
  ReviewMemoryKind,
  ReviewMemoryScope,
  ReviewMemorySourceKind,
  ReviewMemoryState,
} from '@gcr/contracts';
import type { Database, DatabaseClient } from '@gcr/db';

export const emptyReviewMemoryHash =
  '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
export const reviewMemoryMaximumItems = 12;
export const reviewMemoryMaximumContextCharacters = 8_000;
export const reviewMemoryMaximumItemCharacters = 1_200;

export const reviewMemoryColumns = `
  id, tenant_id as "tenantId", repository_id as "repositoryId", scope,
  owner_user_id as "ownerUserId", kind, state, revision,
  supersedes_id as "supersedesId", summary, detail, recommendation, categories,
  file_paths as "filePaths", symbols, aggregation_key as "aggregationKey",
  contributor_count as "contributorCount", conflict_count as "conflictCount",
  confidence, importance, source_kind as "sourceKind",
  source_analysis_run_id as "sourceAnalysisRunId", source_finding_id as "sourceFindingId",
  source_chat_message_id as "sourceChatMessageId",
  source_github_pr_message_id as "sourceGithubPrMessageId",
  source_github_pr_message_content_hash as "sourceGithubPrMessageContentHash",
  source_base_sha as "sourceBaseSha",
  source_head_sha as "sourceHeadSha", source_anchor as "sourceAnchor",
  content_hash as "contentHash", created_by as "createdBy", reviewed_by as "reviewedBy",
  reviewed_at as "reviewedAt", review_note as "reviewNote", created_at as "createdAt",
  updated_at as "updatedAt", search_text as "searchText"`;

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
  sourceGithubPrMessageId: string | null;
  sourceGithubPrMessageContentHash: string | null;
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

export type PersonalReviewMemoryCandidateInput = {
  tenantId: string;
  repositoryId: string;
  ownerUserId: string;
  kind: ReviewMemoryKind;
  summary: string;
  detail: string;
  recommendation: string;
  categories: string[];
  filePaths: string[];
  symbols: string[];
  confidence: number;
  importance: number;
  sourceKind: Exclude<ReviewMemorySourceKind, 'manual'>;
  sourceAnalysisRunId: string;
  sourceFindingId?: string;
  sourceChatMessageId?: string;
  sourceGithubPrMessageId?: string;
  sourceGithubPrMessageContentHash?: string;
  sourceBaseSha: string;
  sourceHeadSha: string;
  sourceAnchor: Record<string, unknown>;
  sourceFingerprint?: string;
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
            memory.source_github_pr_message_id as "sourceGithubPrMessageId",
            memory.source_github_pr_message_content_hash as "sourceGithubPrMessageContentHash",
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

export async function createPersonalReviewMemoryCandidate(
  database: Pick<DatabaseClient, 'query'>,
  input: PersonalReviewMemoryCandidateInput,
): Promise<ReviewMemoryRecord> {
  const normalized = {
    ...input,
    summary: normalizeText(input.summary),
    detail: normalizeText(input.detail),
    recommendation: normalizeText(input.recommendation),
    categories: cleanList(input.categories),
    filePaths: cleanList(input.filePaths),
    symbols: cleanList(input.symbols),
  };
  const contentHash = reviewMemoryContentHash(normalized);
  const aggregationKey = reviewMemoryAggregationKey(normalized, input.sourceFingerprint);
  const searchText = buildReviewMemorySearchText(normalized);
  const inserted = await database.query<ReviewMemoryRecord>(
    `insert into review_memories(
       tenant_id, repository_id, scope, owner_user_id, kind, state, summary, detail,
       recommendation, categories, file_paths, symbols, search_text, aggregation_key,
       confidence, importance, source_kind, source_analysis_run_id, source_finding_id,
       source_chat_message_id, source_github_pr_message_id,
       source_github_pr_message_content_hash, source_base_sha, source_head_sha, source_anchor,
       content_hash, created_by)
     values ($1,$2,'personal',$3,$4,'candidate',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
       $15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24,$3)
     on conflict (repository_id, owner_user_id, content_hash)
       where scope = 'personal' and state in ('candidate', 'active') do nothing
     returning ${reviewMemoryColumns}`,
    [
      input.tenantId,
      input.repositoryId,
      input.ownerUserId,
      input.kind,
      normalized.summary,
      normalized.detail,
      normalized.recommendation,
      normalized.categories,
      normalized.filePaths,
      normalized.symbols,
      searchText,
      aggregationKey,
      input.confidence,
      input.importance,
      input.sourceKind,
      input.sourceAnalysisRunId,
      input.sourceFindingId ?? null,
      input.sourceChatMessageId ?? null,
      input.sourceGithubPrMessageId ?? null,
      input.sourceGithubPrMessageContentHash ?? null,
      input.sourceBaseSha,
      input.sourceHeadSha,
      JSON.stringify(input.sourceAnchor),
      contentHash,
    ],
  );
  if (inserted.rows[0]) {
    await database.query(
      `insert into review_memory_events(memory_id, action, actor_user_id, after_state, revision)
       values ($1, 'created', $2, 'candidate', $3)`,
      [inserted.rows[0].id, input.ownerUserId, inserted.rows[0].revision],
    );
    return inserted.rows[0];
  }
  const existing = await database.query<ReviewMemoryRecord>(
    `select ${reviewMemoryColumns} from review_memories
      where repository_id = $1 and owner_user_id = $2 and content_hash = $3
        and scope = 'personal' and state in ('candidate', 'active') limit 1`,
    [input.repositoryId, input.ownerUserId, contentHash],
  );
  if (!existing.rows[0]) throw new Error('Review memory candidate conflict could not be resolved');
  return existing.rows[0];
}

export async function createFindingReviewMemoryCandidates(
  database: Pick<DatabaseClient, 'query'>,
  analysisId: string,
): Promise<ReviewMemoryRecord[]> {
  const context = await database.query<{
    tenantId: string;
    repositoryId: string;
    ownerUserId: string | null;
    baseSha: string;
    headSha: string;
  }>(
    `select repository.tenant_id as "tenantId", repository.id as "repositoryId",
            analysis.memory_owner_user_id as "ownerUserId", request.base_sha as "baseSha",
            request.head_sha as "headSha"
       from analysis_runs analysis
       join snapshots snapshot on snapshot.id = analysis.snapshot_id
       join snapshot_requests request on request.id = snapshot.request_id
       join pull_requests pull_request on pull_request.id = request.pull_request_id
       join repositories repository on repository.id = pull_request.repository_id
      where analysis.id = $1`,
    [analysisId],
  );
  const owner = context.rows[0];
  if (!owner?.ownerUserId) return [];
  const findings = await database.query<{
    id: string;
    priority: 'P2' | 'P3';
    category: string;
    confidence: 'low' | 'medium' | 'high';
    title: string;
    problem: string;
    impact: string;
    recommendation: string;
    anchor: Record<string, unknown>;
    fingerprint: string;
    filePath: string | null;
  }>(
    `select finding.id, finding.priority, finding.category, finding.confidence, finding.title,
            finding.problem, finding.impact, finding.recommendation, finding.anchor,
            finding.fingerprint, snapshot_file.path as "filePath"
       from findings finding
       join reports report on report.id = finding.report_id
       left join snapshot_files snapshot_file on snapshot_file.id::text = finding.anchor->>'fileId'
      where report.analysis_run_id = $1 and finding.priority in ('P2', 'P3')
      order by finding.priority desc, finding.id`,
    [analysisId],
  );
  const candidates: ReviewMemoryRecord[] = [];
  for (const finding of findings.rows) {
    candidates.push(
      await createPersonalReviewMemoryCandidate(database, {
        tenantId: owner.tenantId,
        repositoryId: owner.repositoryId,
        ownerUserId: owner.ownerUserId,
        kind: 'recurring-finding',
        summary: finding.title,
        detail: [finding.problem, finding.impact].filter(Boolean).join('\n'),
        recommendation: finding.recommendation,
        categories: [finding.category],
        filePaths: finding.filePath ? [finding.filePath] : [],
        symbols: [],
        confidence: confidenceNumber(finding.confidence),
        importance: finding.priority === 'P3' ? 5 : 4,
        sourceKind: 'finding',
        sourceAnalysisRunId: analysisId,
        sourceFindingId: finding.id,
        sourceBaseSha: owner.baseSha,
        sourceHeadSha: owner.headSha,
        sourceAnchor: finding.anchor,
        sourceFingerprint: finding.fingerprint,
      }),
    );
  }
  return candidates;
}

export async function refreshCollectiveReviewMemoryCandidate(
  database: Pick<DatabaseClient, 'query'>,
  repositoryId: string,
  aggregationKey: string,
): Promise<ReviewMemoryRecord | null> {
  const personal = await database.query<ReviewMemoryRecord>(
    `select ${reviewMemoryColumns} from review_memories
      where repository_id = $1 and aggregation_key = $2 and scope = 'personal'
        and state = 'active' order by reviewed_at, id`,
    [repositoryId, aggregationKey],
  );
  const aggregation = aggregatePersonalReviewMemories(personal.rows).find(
    (item) => item.aggregationKey === aggregationKey,
  );
  if (!aggregation?.eligible) return null;
  const representative = [...aggregation.contributors].sort(
    (left, right) =>
      right.importance - left.importance ||
      right.confidence - left.confidence ||
      left.id.localeCompare(right.id),
  )[0]!;
  const current = await database.query<ReviewMemoryRecord>(
    `select ${reviewMemoryColumns} from review_memories
      where repository_id = $1 and aggregation_key = $2 and scope = 'collective'
        and state in ('candidate', 'active') order by state = 'candidate' desc, revision desc`,
    [repositoryId, aggregationKey],
  );
  const candidate = current.rows.find(({ state }) => state === 'candidate');
  if (candidate) {
    const updated = await database.query<ReviewMemoryRecord>(
      `update review_memories set contributor_count = $2, conflict_count = $3,
         updated_at = clock_timestamp() where id = $1 returning ${reviewMemoryColumns}`,
      [candidate.id, aggregation.contributorCount, aggregation.conflictCount],
    );
    await replaceContributions(database, candidate.id, aggregation);
    return updated.rows[0]!;
  }
  const active = current.rows.find(({ state }) => state === 'active');
  if (
    active &&
    (await contributionIds(database, active.id)).join() ===
      contributionRecordIds(aggregation).join()
  ) {
    return active;
  }
  const inserted = await database.query<ReviewMemoryRecord>(
    `insert into review_memories(
       tenant_id, repository_id, scope, kind, state, revision, supersedes_id, summary, detail,
       recommendation, categories, file_paths, symbols, search_text, aggregation_key,
       contributor_count, conflict_count, confidence, importance, source_kind,
       source_analysis_run_id, source_base_sha, source_head_sha, source_anchor, content_hash)
     values ($1,$2,'collective',$3,'candidate',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
       $16,$17,'manual',$18,$19,$20,$21::jsonb,$22)
     returning ${reviewMemoryColumns}`,
    [
      representative.tenantId,
      repositoryId,
      aggregation.kind,
      Math.max(0, ...current.rows.map(({ revision }) => revision)) + 1,
      active?.id ?? null,
      representative.summary,
      representative.detail,
      representative.recommendation,
      representative.categories,
      representative.filePaths,
      representative.symbols,
      representative.searchText,
      aggregationKey,
      aggregation.contributorCount,
      aggregation.conflictCount,
      representative.confidence,
      representative.importance,
      representative.sourceAnalysisRunId,
      representative.sourceBaseSha,
      representative.sourceHeadSha,
      JSON.stringify(representative.sourceAnchor),
      representative.contentHash,
    ],
  );
  const collective = inserted.rows[0]!;
  await replaceContributions(database, collective.id, aggregation);
  await database.query(
    `insert into review_memory_events(memory_id, action, after_state, revision)
     values ($1, 'aggregated', 'candidate', $2)`,
    [collective.id, collective.revision],
  );
  return collective;
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

function cleanList(values: string[]): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const cleaned = normalizeText(value);
    const key = cleaned.toLocaleLowerCase();
    if (!cleaned || seen.has(key)) return [];
    seen.add(key);
    return [cleaned];
  });
}

function confidenceNumber(confidence: 'low' | 'medium' | 'high'): number {
  return { low: 0.4, medium: 0.7, high: 0.9 }[confidence];
}

function contributionRecordIds(aggregation: ReviewMemoryAggregation): string[] {
  return [...aggregation.contributors, ...aggregation.conflicts].map(({ id }) => id).sort();
}

async function contributionIds(
  database: Pick<DatabaseClient, 'query'>,
  collectiveMemoryId: string,
): Promise<string[]> {
  const result = await database.query<{ personalMemoryId: string }>(
    `select personal_memory_id as "personalMemoryId"
       from review_memory_contributions
      where collective_memory_id = $1
      order by personal_memory_id`,
    [collectiveMemoryId],
  );
  return result.rows.map(({ personalMemoryId }) => personalMemoryId);
}

async function replaceContributions(
  database: Pick<DatabaseClient, 'query'>,
  collectiveMemoryId: string,
  aggregation: ReviewMemoryAggregation,
): Promise<void> {
  await database.query('delete from review_memory_contributions where collective_memory_id = $1', [
    collectiveMemoryId,
  ]);
  for (const [agreement, records] of [
    ['support', aggregation.contributors],
    ['conflict', aggregation.conflicts],
  ] as const) {
    for (const record of records) {
      await database.query(
        `insert into review_memory_contributions(
           collective_memory_id, personal_memory_id, contributor_user_id,
           personal_revision, agreement)
         values ($1,$2,$3,$4,$5)`,
        [collectiveMemoryId, record.id, record.ownerUserId, record.revision, agreement],
      );
    }
  }
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
