import { z } from 'zod';

export const schemaVersion = 1 as const;

export const roleSchema = z.enum(['reviewer', 'administrator']);
export type Role = z.infer<typeof roleSchema>;

export const userSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  id: z.string(),
  subject: z.string(),
  displayName: z.string(),
  role: roleSchema,
});
export type User = z.infer<typeof userSchema>;

export const repositorySchema = z.object({
  id: z.string().uuid(),
  githubId: z.string(),
  owner: z.string(),
  name: z.string(),
  webBaseUrl: z.string().url(),
  lastPolledAt: z.string().nullable(),
  nextPollAt: z.string().nullable(),
  pollOutcome: z.string().nullable(),
  pollError: z.string().nullable(),
});
export type Repository = z.infer<typeof repositorySchema>;

export const pullRequestSchema = z.object({
  id: z.string().uuid(),
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  author: z.string(),
  htmlUrl: z.string().url(),
  baseRef: z.string(),
  baseSha: z.string(),
  headRef: z.string(),
  headSha: z.string(),
  updatedAt: z.string(),
  observedAt: z.string(),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

export const repositoryListSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  items: z.array(repositorySchema),
  nextCursor: z.string().nullable(),
});

export const pullRequestListSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  repositoryId: z.string().uuid(),
  items: z.array(pullRequestSchema),
  nextCursor: z.string().nullable(),
});

export const pullRequestDetailSchema = pullRequestSchema.extend({
  schemaVersion: z.literal(schemaVersion),
  repositoryId: z.string().uuid(),
  owner: z.string(),
  name: z.string(),
  webBaseUrl: z.string().url(),
});

export const analysisListSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  items: z.array(
    z.object({
      id: z.string().uuid().nullable(),
      snapshotId: z.string().uuid(),
      revision: z.number().int().nullable(),
      state: z.string().nullable(),
      stage: z.string().nullable(),
      progress: z.number().int().nullable(),
      createdAt: z.string().nullable(),
      resolution: z.enum(['exact', 'unresolved']),
      mergeBaseSha: z.string().nullable(),
      baseSha: z.string(),
      headSha: z.string(),
    }),
  ),
});

export const snapshotFileListSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  snapshotId: z.string().uuid(),
  items: z.array(
    z.object({
      id: z.string().uuid(),
      path: z.string(),
      previousPath: z.string().nullable(),
      status: z.string(),
      additions: z.number().nullable(),
      deletions: z.number().nullable(),
    }),
  ),
});

export const diffIndexSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  patch: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      previousPath: z.string().nullable(),
      status: z.string(),
      additions: z.number().nullable(),
      deletions: z.number().nullable(),
      patch: z.string(),
    }),
  ),
});

export const refreshResponseSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  operationId: z.string().uuid(),
  state: z.string(),
  deduplicated: z.boolean(),
  eventsUrl: z.string(),
});

export const operationSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  id: z.string().uuid(),
  type: z.string(),
  state: z.string(),
  result: z
    .object({
      snapshotChanged: z.boolean(),
      snapshotId: z.string().uuid().nullable(),
      analysisId: z.string().uuid().nullable(),
    })
    .nullable(),
  error: z.record(z.string(), z.unknown()).nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

export const linkViewSchema = z.object({
  rel: z.string(),
  href: z.string(),
  target: z.enum(['same-tab', 'new-tab']),
  available: z.boolean(),
});

export const evidenceLocatorSchema = z.object({
  id: z.string().uuid(),
  fileId: z.string().uuid(),
  side: z.enum(['mergeBase', 'head']),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  symbolId: z.string().uuid().optional(),
  commitOid: z.string().optional(),
  artifactType: z.string(),
});

export const coverageSchema = z.object({
  filesChanged: z.number().int().nonnegative(),
  filesExamined: z.number().int().nonnegative(),
  objectsExamined: z.number().int().nonnegative(),
  relationsExamined: z.number().int().nonnegative(),
  truncated: z.boolean(),
  limitations: z.array(z.string()),
});

export const findingViewSchema = z.object({
  id: z.string().uuid(),
  source: z.object({
    kind: z.enum(['analyzer', 'model']),
    producer: z.string(),
    rule: z.string().optional(),
    original: z.record(z.string(), z.unknown()).optional(),
  }),
  title: z.string(),
  problem: z.string(),
  impact: z.string(),
  recommendation: z.string(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']),
  category: z.string(),
  confidence: z.enum(['low', 'medium', 'high']),
  verification: z.object({
    status: z.enum(['verified', 'limited']),
    checks: z.array(z.string()),
    originalPriority: z.string(),
  }),
  anchor: evidenceLocatorSchema,
  evidence: z.array(evidenceLocatorSchema),
  fingerprint: z.string(),
  links: z.array(linkViewSchema),
});

export const reportViewSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  analysisRevisionId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  summary: z.string(),
  grade: z.enum(['exceptional', 'proficient', 'adequate', 'insufficient', 'critical']),
  hasCriticalFindings: z.boolean(),
  perFileSummaries: z.array(
    z.object({
      fileId: z.string().uuid(),
      summary: z.string(),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']),
      grade: z.string(),
    }),
  ),
  findings: z.array(findingViewSchema),
  impact: z.object({
    summary: z.string(),
    affectedAreas: z.array(
      z.object({
        objectId: z.string().uuid(),
        risk: z.enum(['low', 'medium', 'high', 'critical']),
        reason: z.string(),
        relationIds: z.array(z.string().uuid()),
        evidence: z.array(evidenceLocatorSchema),
      }),
    ),
    coverage: coverageSchema,
    confidence: z.enum(['low', 'medium', 'high']),
  }),
  coverage: coverageSchema,
  versions: z.record(z.string(), z.string()),
  durationMs: z.number().int().nonnegative(),
  context: z.object({
    repositoryId: z.string().uuid(),
    owner: z.string(),
    name: z.string(),
    pullNumber: z.number().int().positive(),
    pullTitle: z.string(),
    snapshotId: z.string().uuid(),
    baseSha: z.string(),
    headSha: z.string(),
  }),
  links: z.array(linkViewSchema),
});

export const codeObjectSchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  qualifiedName: z.string(),
  definition: evidenceLocatorSchema.optional(),
  change: z.enum(['added', 'removed', 'modified', 'unchanged']),
});

const codeRelationSchema = z.object({
  id: z.string().uuid(),
  sourceObjectId: z.string().uuid(),
  targetObjectId: z.string().uuid(),
  kind: z.string(),
  distance: z.number().int().positive(),
  change: z.enum(['added', 'removed', 'unchanged']),
  confidence: z.enum(['low', 'medium', 'high']),
  evidence: z.array(evidenceLocatorSchema),
});

export const codeObjectListSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  analysisId: z.string().uuid(),
  items: z.array(codeObjectSchema),
  coverage: coverageSchema,
});

export const relationshipViewSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  analysisId: z.string().uuid(),
  objectId: z.string().uuid(),
  direction: z.enum(['outgoing', 'incoming']),
  depth: z.number().int(),
  structure: z.object({
    parents: z.array(codeRelationSchema),
    children: z.array(codeRelationSchema),
  }),
  dependencies: z.object({
    uses: z.array(codeRelationSchema),
    usedBy: z.array(codeRelationSchema),
  }),
  objects: z.array(codeObjectSchema),
  paths: z.array(
    z.object({
      objectIds: z.array(z.string().uuid()),
      relationIds: z.array(z.string().uuid()),
      cycle: z.boolean(),
      truncated: z.boolean(),
    }),
  ),
  coverage: coverageSchema,
});

export const dependencyHealthSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  status: z.enum(['ok', 'degraded']),
  dependencies: z.record(
    z.string(),
    z.object({
      status: z.enum(['ok', 'degraded', 'disabled']),
      latencyMs: z.number().nonnegative().nullable(),
      message: z.string().optional(),
    }),
  ),
});
export type DependencyHealth = z.infer<typeof dependencyHealthSchema>;

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export function errorEnvelope(
  code: string,
  message: string,
  requestId: string,
  retryable = false,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      requestId,
      retryable,
      ...(details ? { details } : {}),
    },
  };
}
