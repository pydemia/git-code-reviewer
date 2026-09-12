import {
  choice,
  fail,
  id,
  integer,
  list,
  literal,
  object,
  optional,
  refined,
  sha256,
  sourcePath,
  text,
  timestamp,
  union,
} from './codec.js';
import { localScope } from './identity.js';

export const knowledgeSource = union(
  object({ kind: literal('user-note'), id }),
  object({ kind: literal('repository-file'), path: sourcePath, hash: sha256 }),
  object({ kind: literal('review'), runId: id, findingId: optional(id) }),
  object({ kind: literal('import'), label: text(1024, 1), hash: sha256 }),
);
export const knowledgeAppliesTo = object({
  paths: list(text(4096, 1), 10_000),
  languages: list(text(128, 1), 1000),
  symbols: list(text(1024, 1), 10_000),
  branches: list(text(1024, 1), 1000),
});
const header = {
  id,
  scope: localScope,
  revision: integer(1),
  hash: sha256,
  state: choice(['candidate', 'active', 'inactive', 'archived']),
  title: text(1024, 1),
  body: text(1_000_000, 1),
  appliesTo: knowledgeAppliesTo,
  sources: list(knowledgeSource, 10_000),
  createdAt: timestamp,
  updatedAt: timestamp,
  expiresAt: optional(timestamp),
};
export const localKnowledge = refined(
  union(
    object({
      kind: literal('memory'),
      ...header,
      rationale: text(100_000),
      counterEvidence: list(text(100_000, 1), 1000),
    }),
    object({
      kind: literal('skill'),
      ...header,
      reviewOnly: literal(true),
      origin: choice(['user-authored', 'imported-repository', 'imported-file']),
    }),
  ),
  (value, at) => {
    if (value.updatedAt < value.createdAt) fail(at, 'updatedAt precedes creation');
    if (value.expiresAt && value.expiresAt < value.createdAt) fail(at, 'expiry precedes creation');
  },
);
export type LocalKnowledge = ReturnType<typeof localKnowledge>;
export type LocalMemory = Extract<LocalKnowledge, { kind: 'memory' }>;
export type LocalSkill = Extract<LocalKnowledge, { kind: 'skill' }>;
