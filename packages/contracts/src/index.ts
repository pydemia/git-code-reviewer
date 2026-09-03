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
  enabled: z.boolean(),
  tenants: z.array(
    z.object({
      id: z.string().uuid(),
      slug: z.string(),
      displayName: z.string(),
    }),
  ),
});
export type User = z.infer<typeof userSchema>;

export const tenantSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  displayName: z.string(),
  enabled: z.boolean(),
  memberCount: z.number().int().nonnegative(),
  repositoryCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Tenant = z.infer<typeof tenantSchema>;

export const tenantListSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  items: z.array(tenantSchema),
});

export const adminUserSchema = z.object({
  id: z.string().uuid(),
  subject: z.string(),
  displayName: z.string(),
  role: roleSchema,
  enabled: z.boolean(),
  groups: z.array(z.string()),
  memberships: z.array(
    z.object({
      tenantId: z.string().uuid(),
      tenantSlug: z.string(),
      tenantName: z.string(),
      enabled: z.boolean(),
    }),
  ),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

export const adminUserListSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  items: z.array(adminUserSchema),
});

export const analysisPromptVersionSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  version: z.number().int().positive(),
  instructions: z.string(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  active: z.boolean(),
  createdBy: z.object({
    subject: z.string(),
    displayName: z.string(),
  }),
  activatedBy: z
    .object({
      subject: z.string(),
      displayName: z.string(),
    })
    .nullable(),
  activatedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type AnalysisPromptVersion = z.infer<typeof analysisPromptVersionSchema>;

export const analysisPromptListSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  tenant: z.object({
    id: z.string().uuid(),
    slug: z.string(),
    displayName: z.string(),
  }),
  model: z.object({ enabled: z.boolean(), name: z.string().nullable() }),
  active: analysisPromptVersionSchema.nullable(),
  items: z.array(analysisPromptVersionSchema),
});

export const analysisProviderModeSchema = z.enum(['disabled', 'openai-compatible']);
export type AnalysisProviderMode = z.infer<typeof analysisProviderModeSchema>;

export const analysisProviderVersionSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  mode: analysisProviderModeSchema,
  endpoint: z.string().url().nullable(),
  modelName: z.string().nullable(),
  timeoutMs: z.number().int().positive(),
  apiKeyConfigured: z.boolean(),
  configurationHash: z.string().regex(/^[0-9a-f]{64}$/),
  active: z.boolean(),
  createdBy: z.object({
    subject: z.string(),
    displayName: z.string(),
  }),
  activatedBy: z
    .object({
      subject: z.string(),
      displayName: z.string(),
    })
    .nullable(),
  activatedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type AnalysisProviderVersion = z.infer<typeof analysisProviderVersionSchema>;

export const analysisProviderEffectiveSchema = z.object({
  source: z.enum(['administration', 'deployment']),
  versionId: z.string().uuid().nullable(),
  version: z.number().int().positive().nullable(),
  mode: analysisProviderModeSchema,
  endpoint: z.string().url().nullable(),
  modelName: z.string().nullable(),
  timeoutMs: z.number().int().positive(),
  apiKeyConfigured: z.boolean(),
  configurationHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export const analysisProviderSettingsSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  editable: z.boolean(),
  allowedOrigins: z.array(z.string().url()),
  effective: analysisProviderEffectiveSchema,
  deployment: analysisProviderEffectiveSchema.omit({
    source: true,
    versionId: true,
    version: true,
  }),
  active: analysisProviderVersionSchema.nullable(),
  items: z.array(analysisProviderVersionSchema),
});

export const analysisProviderTestResultSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  status: z.literal('ok'),
  latencyMs: z.number().int().nonnegative(),
});

export const repositorySchema = z.object({
  id: z.string().uuid(),
  githubId: z.string(),
  tenantId: z.string().uuid(),
  tenantSlug: z.string(),
  tenantName: z.string(),
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

export const pullRequestSummarySchema = pullRequestSchema.extend({
  latestAnalysisId: z.string().uuid().nullable(),
  analysisState: z.string().nullable(),
  grade: z.enum(['exceptional', 'proficient', 'adequate', 'insufficient', 'critical']).nullable(),
  attentionCount: z.number().int().nonnegative(),
});
export type PullRequestSummary = z.infer<typeof pullRequestSummarySchema>;

export const repositoryListSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  items: z.array(repositorySchema),
  nextCursor: z.string().nullable(),
});

export const pullRequestListSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  repositoryId: z.string().uuid(),
  items: z.array(pullRequestSummarySchema),
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

export const snapshotCommitListSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  commits: z.array(
    z.object({
      sha: z.string(),
      subject: z.string(),
      author: z.string(),
      authoredAt: z.string(),
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

export const chatCitationSchema = z.object({
  findingId: z.string().uuid().optional(),
  evidenceId: z.string().uuid(),
  fileId: z.string().uuid(),
  line: z.number().int().positive().optional(),
  label: z.string(),
});

export const chatSessionSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  id: z.string().uuid(),
  analysisId: z.string().uuid(),
  scope: z.object({
    findingId: z.string().uuid().optional(),
    fileId: z.string().uuid().optional(),
    symbolId: z.string().uuid().optional(),
  }),
  model: z.object({
    available: z.boolean(),
    name: z.string().nullable(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(['user', 'assistant']),
  status: z.enum(['pending', 'completed', 'failed']),
  content: z.string(),
  citations: z.array(chatCitationSchema),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});

export const chatMessageListSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  sessionId: z.string().uuid(),
  items: z.array(chatMessageSchema),
});

export const chatSendResponseSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  sessionId: z.string().uuid(),
  userMessage: chatMessageSchema,
  assistantMessage: chatMessageSchema,
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
