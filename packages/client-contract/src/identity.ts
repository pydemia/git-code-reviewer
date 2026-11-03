import {
  boolean,
  choice,
  fail,
  gitOid,
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
  unique,
} from './codec.js';

import { reviewExecution } from './review-execution.js';

export const clientMode = choice(['standalone', 'centralized']);
export type ClientMode = ReturnType<typeof clientMode>;
export const centralAudience = object({ serverId: id, tenantId: id, userId: id, repositoryId: id });
export type CentralAudience = ReturnType<typeof centralAudience>;
export const clientIdentity = refined(
  union(
    object({
      mode: literal('standalone'),
      profileId: id,
      repositoryKey: sha256,
      worktreeKey: sha256,
      execution: optional(reviewExecution),
    }),
    object({
      mode: literal('centralized'),
      profileId: id,
      repositoryKey: sha256,
      worktreeKey: sha256,
      audience: centralAudience,
      execution: optional(reviewExecution),
    }),
  ),
  (value, at) => {
    if (value.execution && value.mode !== value.execution.effectiveMode)
      fail(at, 'client mode differs from effective execution mode');
  },
);
export type ClientIdentity = ReturnType<typeof clientIdentity>;

/** A parsed remote descriptor has no URL userinfo, query, fragment or authentication material. */
export const repositoryRemote = object({
  name: id,
  transport: choice(['https', 'ssh']),
  host: text(253, 1, /^[a-zA-Z0-9.-]+$/),
  port: optional(integer(1, 65535)),
  namespace: sourcePath,
  repository: text(255, 1, /^[a-zA-Z0-9_.-]+$/),
});
export type RepositoryRemote = ReturnType<typeof repositoryRemote>;
export const repositoryIdentity = object({
  key: sha256,
  worktreeKey: sha256,
  gitObjectFormat: choice(['sha1', 'sha256']),
  remotes: list(repositoryRemote, 100),
});
export type RepositoryIdentity = ReturnType<typeof repositoryIdentity>;

const gitBase = {
  objectFormat: choice(['sha1', 'sha256']),
  baseCommit: union(gitOid, literal(null)),
  baseTree: gitOid,
};
export const snapshotIdentity = refined(
  union(
    object({ kind: literal('index'), hash: sha256, ...gitBase, sourceTree: gitOid }),
    object({ kind: literal('working-tree'), hash: sha256, ...gitBase }),
    object({
      kind: literal('commit-tree'),
      hash: sha256,
      ...gitBase,
      sourceCommit: gitOid,
      sourceTree: gitOid,
    }),
  ),
  (value, at) => {
    const size = value.objectFormat === 'sha1' ? 40 : 64;
    const oids = [
      value.baseCommit,
      value.baseTree,
      ...('sourceTree' in value ? [value.sourceTree] : []),
      ...('sourceCommit' in value ? [value.sourceCommit] : []),
    ];
    if (oids.some((oid) => oid !== null && oid.length !== size))
      fail(at, 'Git object format mismatch');
  },
);
export type SnapshotIdentity = ReturnType<typeof snapshotIdentity>;
export const sourceFile = object({
  path: sourcePath,
  side: choice(['base', 'source']),
  hash: sha256,
  byteLength: integer(),
  lineCount: integer(1),
  gitBlob: optional(gitOid),
});
export type SourceFile = ReturnType<typeof sourceFile>;
export const sourceLocation = object({
  path: sourcePath,
  side: choice(['base', 'source']),
  hash: sha256,
  startLine: integer(),
  endLine: integer(),
});
export type SourceLocation = ReturnType<typeof sourceLocation>;

export const localScope = union(
  object({ kind: literal('profile'), profileId: id }),
  object({
    kind: literal('repository'),
    profileId: id,
    repositoryKey: sha256,
    worktreeKey: sha256,
  }),
);
export type LocalScope = ReturnType<typeof localScope>;
export const contextEntry = union(
  object({
    origin: literal('local'),
    kind: choice(['memory', 'skill']),
    id,
    revision: integer(1),
    hash: sha256,
    scope: localScope,
  }),
  object({
    origin: literal('builtin'),
    kind: literal('skill'),
    id,
    revision: integer(1),
    hash: sha256,
  }),
  object({
    origin: literal('central'),
    kind: choice(['policy', 'memory', 'skill']),
    id,
    revision: integer(1),
    hash: sha256,
    component: choice(['policy', 'collective', 'personal']),
    audience: optional(centralAudience),
  }),
);
export type ContextEntry = ReturnType<typeof contextEntry>;
export const contextIdentity = refined(
  object({
    hash: sha256,
    entries: list(contextEntry),
    centralSnapshot: optional(
      object({
        id,
        hash: sha256,
        audience: centralAudience,
        authorizationRevision: id,
        offlineValidUntil: timestamp,
      }),
    ),
    centralSources: optional(
      list(
        object({
          id,
          hash: sha256,
          audience: centralAudience,
          authorizationRevision: id,
          offlineValidUntil: timestamp,
        }),
        100,
        1,
      ),
    ),
    required: list(
      object({
        kind: choice(['source', 'knowledge', 'tool', 'model', 'policy']),
        reference: text(4096, 1),
        available: boolean,
        reason: text(4096),
      }),
      10_000,
    ),
  }),
  (value, at) => {
    unique(
      value.entries.map((entry) => `${entry.origin}:${entry.kind}:${entry.id}`),
      `${at}.entries`,
    );
    if (value.entries.some((entry) => entry.origin === 'central') && !value.centralSnapshot)
      fail(at, 'central context has no pinned snapshot');
    if (value.centralSources) {
      if (!value.centralSnapshot) fail(at, 'central sources lack an anchor snapshot');
      if (
        !value.centralSources.some(
          (source) =>
            source.id === value.centralSnapshot!.id &&
            source.hash === value.centralSnapshot!.hash &&
            source.authorizationRevision === value.centralSnapshot!.authorizationRevision &&
            source.offlineValidUntil === value.centralSnapshot!.offlineValidUntil &&
            JSON.stringify(source.audience) === JSON.stringify(value.centralSnapshot!.audience),
        )
      )
        fail(at, 'central sources lack the anchor audience');
      unique(
        value.centralSources.map((s) => JSON.stringify(s.audience)),
        `${at}.centralSources`,
      );
      for (const source of value.centralSources)
        for (const key of ['serverId', 'tenantId', 'userId'] as const)
          if (source.audience[key] !== value.centralSnapshot!.audience[key])
            fail(at, 'central reference source crosses an account boundary');
      for (const entry of value.entries)
        if (
          entry.origin === 'central' &&
          entry.audience &&
          !value.centralSources.some(
            (s) => JSON.stringify(s.audience) === JSON.stringify(entry.audience),
          )
        )
          fail(at, 'central entry lacks its source snapshot');
    } else
      for (const entry of value.entries)
        if (
          entry.origin === 'central' &&
          entry.audience &&
          JSON.stringify(entry.audience) !== JSON.stringify(value.centralSnapshot?.audience)
        )
          fail(at, 'central entry crosses the pinned audience');
  },
);
export type ContextIdentity = ReturnType<typeof contextIdentity>;
export const executionIdentity = refined(
  object({
    client: clientIdentity,
    source: snapshotIdentity,
    context: contextIdentity,
    reviewProfile: object({ id, revision: integer(1), hash: sha256 }),
    executor: object({ id, version: text(128, 1), model: text(256, 1), configHash: sha256 }),
    toolsHash: sha256,
  }),
  (value, at) => {
    const { client, context } = value;
    if (
      client.mode === 'standalone' &&
      (context.centralSnapshot || context.entries.some((entry) => entry.origin === 'central'))
    )
      fail(at, 'standalone identity contains central context');
    if (client.mode === 'centralized' && context.centralSnapshot) {
      for (const key of ['serverId', 'tenantId', 'userId', 'repositoryId'] as const)
        if (client.audience[key] !== context.centralSnapshot.audience[key])
          fail(at, 'central audience mismatch');
    }
    for (const entry of context.entries)
      if (entry.origin === 'local') {
        if (entry.scope.profileId !== client.profileId) fail(at, 'local profile mismatch');
        if (
          entry.scope.kind === 'repository' &&
          (entry.scope.repositoryKey !== client.repositoryKey ||
            entry.scope.worktreeKey !== client.worktreeKey)
        )
          fail(at, 'local repository/worktree mismatch');
      }
  },
);
export type ExecutionIdentity = ReturnType<typeof executionIdentity>;
