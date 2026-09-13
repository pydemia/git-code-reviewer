import {
  boolean,
  choice,
  id,
  integer,
  gitOid,
  list,
  literal,
  object,
  refined,
  sha256,
  text,
  timestamp,
  union,
  unique,
  fail,
} from './codec.js';

export const KNOWLEDGE_BUNDLE_MAX_BYTES = 2 * 1024 * 1024;
const nullableId = union(id, literal(null));
const nullableTime = union(timestamp, literal(null));
const terms = list(text(500, 1), 100);
export const centralAppliesTo = object({
  languages: terms,
  filePaths: terms,
  symbols: terms,
  contracts: terms,
  branches: terms,
});
export const centralCriterionDocument = object({
  title: text(300, 1),
  topicKey: text(200, 1),
  requirement: text(4000, 1),
  rationale: text(4000, 1),
  counterEvidence: list(text(2000, 1), 30, 1),
  reviewSteps: list(text(2000, 1), 30, 1),
  appliesTo: centralAppliesTo,
  severity: choice(['P0', 'P1', 'P2', 'P3']),
  enforcement: literal('advisory'),
  reviewAfter: nullableTime,
});
const sourceReference = object({
  kind: choice(['memory', 'github-pr-message', 'manual']),
  id: nullableId,
  contentHash: sha256,
});
export const centralMemoryContent = object({
  summary: text(500, 1),
  detail: text(4000),
  recommendation: text(2000),
  categories: terms,
  appliesTo: centralAppliesTo,
  counterEvidence: list(text(2000, 1), 30),
  expiresAt: nullableTime,
});
export type CentralMemoryContent = ReturnType<typeof centralMemoryContent>;
const memory = object({
  id,
  revision: integer(1),
  contentHash: sha256,
  sourceRevision: integer(1),
  sourceContentHash: sha256,
  kind: choice(['recurring-finding', 'decision', 'false-positive', 'open-question']),
  content: centralMemoryContent,
  sources: list(sourceReference, 1, 1),
  sourceBaseSha: union(gitOid, literal(null)),
  sourceHeadSha: union(gitOid, literal(null)),
  supersedesId: nullableId,
});
const criterion = object({
  id,
  revision: integer(1),
  contentHash: sha256,
  sourceContentHash: sha256,
  document: centralCriterionDocument,
  decision: object({
    id,
    outcome: choice(['defect', 'false-positive', 'accepted-exception', 'design-decision']),
    sources: list(sourceReference, 12, 1),
  }),
  exceptions: list(
    object({
      id,
      appliesTo: centralAppliesTo,
      reason: text(4000, 1),
      startsAt: timestamp,
      expiresAt: timestamp,
    }),
    1000,
  ),
});
const skill = object({
  name: text(64, 1),
  title: text(120, 1),
  kind: choice(['perspective', 'form']),
  unit: choice(['code-segment', 'file', 'analysis']),
  version: integer(1),
  enabled: boolean,
  instructions: text(16000, 1),
  markdown: text(20000, 1),
  contentHash: sha256,
});
const common = { schemaVersion: literal(1), tenantId: id, repositoryId: id };
export const centralKnowledgeBundle = refined(
  union(
    object({
      ...common,
      component: literal('policy'),
      ownerUserId: literal(null),
      skills: object({ schemaVersion: literal(1), hash: sha256, skills: list(skill, 32, 4) }),
      criteria: list(criterion, 10000),
    }),
    object({
      ...common,
      component: literal('collective'),
      ownerUserId: literal(null),
      memories: list(memory, 10000),
    }),
    object({
      ...common,
      component: literal('personal'),
      ownerUserId: id,
      memories: list(memory, 10000),
    }),
  ),
  (value, at) => {
    if (value.component === 'policy') {
      unique(
        value.criteria.map((x) => x.id),
        at,
      );
      unique(
        value.skills.skills.map((x) => x.name),
        at,
      );
    } else
      unique(
        value.memories.map((x) => x.id),
        at,
      );
  },
);
export type CentralKnowledgeBundle = ReturnType<typeof centralKnowledgeBundle>;

/** Canonical JSON v1: UTF-16 key order, JSON number/string encoding, no omitted values. */
export function canonicalKnowledgeJson(value: unknown): string {
  const visit = (item: unknown): string => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return '[' + Array.from(item, visit).join(',') + ']';
    if (
      item &&
      typeof item === 'object' &&
      [Object.prototype, null].includes(Object.getPrototypeOf(item))
    )
      return (
        '{' +
        Object.keys(item)
          .sort()
          .map((key) => JSON.stringify(key) + ':' + visit((item as Record<string, unknown>)[key]))
          .join(',') +
        '}'
      );
    return fail('$', 'expected finite JSON data');
  };
  return visit(value);
}
export function encodeKnowledgeBundle(value: unknown): string {
  const encoded = canonicalKnowledgeJson(centralKnowledgeBundle(value));
  if (
    [...encoded].reduce((bytes, char) => {
      const code = char.codePointAt(0)!;
      return bytes + (code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4);
    }, 0) > KNOWLEDGE_BUNDLE_MAX_BYTES
  )
    fail('$', 'bundle exceeds byte limit');
  return encoded;
}
