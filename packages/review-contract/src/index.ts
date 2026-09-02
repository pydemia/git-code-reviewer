import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const prioritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
export const gradeSchema = z.enum([
  'exceptional',
  'proficient',
  'adequate',
  'insufficient',
  'critical',
]);
export const confidenceSchema = z.enum(['low', 'medium', 'high']);
export const findingCategorySchema = z.enum([
  'correctness',
  'security',
  'compatibility',
  'testing',
  'maintenance',
  'optimization',
  'review-history',
  'setting',
]);

export const evidenceLocatorSchema = z.object({
  id: z.string().uuid(),
  fileId: z.string().uuid(),
  side: z.enum(['mergeBase', 'head']),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  symbolId: z.string().uuid().optional(),
  commitOid: z
    .string()
    .regex(/^[a-f0-9]{40}$/i)
    .optional(),
  artifactType: z.string().min(1),
});
export type EvidenceLocator = z.infer<typeof evidenceLocatorSchema>;

export const coverageSchema = z.object({
  filesChanged: z.number().int().nonnegative(),
  filesExamined: z.number().int().nonnegative(),
  objectsExamined: z.number().int().nonnegative(),
  relationsExamined: z.number().int().nonnegative(),
  truncated: z.boolean(),
  limitations: z.array(z.string()),
});
export type Coverage = z.infer<typeof coverageSchema>;

export const reviewFindingSchema = z.object({
  id: z.string().uuid(),
  source: z.object({
    kind: z.enum(['analyzer', 'model']),
    producer: z.string().min(1),
    rule: z.string().optional(),
    original: z
      .object({
        schemaVersion: z.number().int().positive(),
        priority: z.string(),
        category: z.string(),
        comment: z.string(),
      })
      .optional(),
  }),
  title: z.string().min(1),
  problem: z.string().min(1),
  impact: z.string().min(1),
  recommendation: z.string().min(1),
  priority: prioritySchema,
  category: findingCategorySchema,
  confidence: confidenceSchema,
  verification: z.object({
    status: z.enum(['verified', 'limited']),
    checks: z.array(z.string()),
    originalPriority: z.string(),
  }),
  anchor: evidenceLocatorSchema,
  evidence: z.array(evidenceLocatorSchema),
  fingerprint: z.string().min(1),
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const codeObjectSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum([
    'file',
    'module',
    'namespace',
    'class',
    'interface',
    'function',
    'method',
    'property',
    'variable',
    'schema',
    'test',
    'package',
  ]),
  qualifiedName: z.string().min(1),
  definition: evidenceLocatorSchema.optional(),
  change: z.enum(['added', 'removed', 'modified', 'unchanged']),
});
export type CodeObject = z.infer<typeof codeObjectSchema>;

export const codeRelationSchema = z.object({
  id: z.string().uuid(),
  sourceObjectId: z.string().uuid(),
  targetObjectId: z.string().uuid(),
  kind: z.enum([
    'contains',
    'defines',
    'calls',
    'imports',
    'extends',
    'implements',
    'reads',
    'writes',
    'constructs',
    'tests',
    'depends-on',
  ]),
  distance: z.number().int().positive(),
  change: z.enum(['added', 'removed', 'unchanged']),
  confidence: confidenceSchema,
  evidence: z.array(evidenceLocatorSchema),
});
export type CodeRelation = z.infer<typeof codeRelationSchema>;

export const impactReportSchema = z.object({
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
  confidence: confidenceSchema,
});

export const reviewReportSchema = z.object({
  schemaVersion: z.literal(1),
  compatibility: z.object({
    commitDefenderSchemaVersion: z.literal(1),
    baselineRevision: z.literal('47dabfea718729b0ccc685ae173857476040d6ea'),
  }),
  analysisRevisionId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  summary: z.string(),
  grade: gradeSchema,
  hasCriticalFindings: z.boolean(),
  perFileSummaries: z.array(
    z.object({
      fileId: z.string().uuid(),
      summary: z.string(),
      priority: prioritySchema,
      grade: gradeSchema,
    }),
  ),
  findings: z.array(reviewFindingSchema),
  impact: impactReportSchema,
  coverage: coverageSchema,
  versions: z.record(z.string(), z.string()),
  durationMs: z.number().int().nonnegative(),
});
export type ReviewReport = z.infer<typeof reviewReportSchema>;

export const relationshipGraphSchema = z.object({
  schemaVersion: z.literal(1),
  analysisRevisionId: z.string().uuid(),
  objects: z.array(codeObjectSchema),
  relations: z.array(codeRelationSchema),
  coverage: coverageSchema,
});
export type RelationshipGraph = z.infer<typeof relationshipGraphSchema>;

export const legacyAnalysisReportSchema = z.object({
  schema_version: z.literal(1),
  staged_files: z.array(z.string()),
  duration_ms: z.number().int().nonnegative(),
  exit_code: z.union([z.literal(0), z.literal(1)]),
  lint_findings: z.array(
    z.object({
      file: z.string(),
      line: z.number().int().positive(),
      col: z.number().int().positive(),
      rule: z.string(),
      message: z.string(),
      severity: z.enum(['error', 'warning', 'info']),
    }),
  ),
  review: z.object({
    summary: z.string(),
    blocking: z.boolean(),
    is_error: z.boolean(),
    file_comments: z.array(
      z.object({
        file: z.string(),
        line: z.number().int().nonnegative(),
        comment: z.string(),
        category: z.string(),
        priority: z.string(),
      }),
    ),
    grade: z.string(),
    per_file_summaries: z
      .array(
        z.object({
          file: z.string(),
          summary: z.string(),
          priority: z.string(),
          blocking: z.boolean(),
          grade: z.string(),
        }),
      )
      .optional(),
  }),
});
export type LegacyAnalysisReport = z.infer<typeof legacyAnalysisReportSchema>;

type LegacyContext = {
  analysisRevisionId: string;
  snapshotId: string;
  files: Array<{ id: string; path: string; headLines: Set<number> }>;
  emptyImpact: ReviewReport['impact'];
  coverage: Coverage;
};

export function normalizeLegacyReport(
  value: LegacyAnalysisReport,
  context: LegacyContext,
): ReviewReport {
  const report = legacyAnalysisReportSchema.parse(value);
  const files = new Map(context.files.map((file) => [file.path, file]));
  const raw = [
    ...report.lint_findings.map((finding) => ({
      file: finding.file,
      line: finding.line,
      priority: severityToPriority(finding.severity),
      category: lintRuleCategory(finding.rule),
      comment: finding.message,
      producer: 'commit-defender-lint',
      rule: finding.rule,
      kind: 'analyzer' as const,
    })),
    ...report.review.file_comments.map((finding) => ({
      file: finding.file,
      line: finding.line,
      priority: normalizePriority(finding.priority),
      category: normalizeCategory(finding.category),
      comment: finding.comment,
      producer: 'commit-defender-model',
      rule: undefined,
      kind: 'model' as const,
    })),
  ];
  const fingerprints = new Set<string>();
  const findings: ReviewFinding[] = [];
  for (const item of raw.sort(
    (left, right) => priorityRank(right.priority) - priorityRank(left.priority),
  )) {
    const file = files.get(item.file);
    if (!file) continue;
    const line = Math.max(1, item.line);
    const verified = item.line > 0 && file.headLines.has(line);
    const priority = item.priority === 'P3' && !verified ? 'P2' : item.priority;
    const fingerprint = createHash('sha256')
      .update(`${item.file}:${line}:${item.rule ?? ''}:${item.comment}`)
      .digest('hex');
    if (fingerprints.has(fingerprint)) continue;
    fingerprints.add(fingerprint);
    const evidence: EvidenceLocator = {
      id: randomUUID(),
      fileId: file.id,
      side: 'head',
      startLine: line,
      endLine: line,
      artifactType: 'snapshot-diff',
    };
    findings.push({
      id: randomUUID(),
      source: {
        kind: item.kind,
        producer: item.producer,
        ...(item.rule ? { rule: item.rule } : {}),
        original: {
          schemaVersion: 1,
          priority: item.priority,
          category: item.category,
          comment: item.comment,
        },
      },
      title: firstSentence(item.comment),
      problem: item.comment,
      impact: '변경된 코드의 안정성 또는 유지보수성에 영향을 줄 수 있습니다.',
      recommendation: '표시된 근거를 확인하고 변경 의도에 맞게 보완하세요.',
      priority,
      category: item.category,
      confidence: verified ? 'high' : 'medium',
      verification: {
        status: verified ? 'verified' : 'limited',
        checks: verified ? ['file-present', 'head-line-present'] : ['file-present'],
        originalPriority: item.priority,
      },
      anchor: evidence,
      evidence: [evidence],
      fingerprint,
    });
  }
  const grade = gradeSchema.safeParse(report.review.grade).success
    ? gradeSchema.parse(report.review.grade)
    : 'adequate';
  const perFileSummaries = (report.review.per_file_summaries ?? []).flatMap((summary) => {
    const file = files.get(summary.file);
    if (!file) return [];
    const parsedGrade = gradeSchema.safeParse(summary.grade);
    return [
      {
        fileId: file.id,
        summary: summary.summary,
        priority: normalizePriority(summary.priority),
        grade: parsedGrade.success ? parsedGrade.data : grade,
      },
    ];
  });
  return reviewReportSchema.parse({
    schemaVersion: 1,
    compatibility: {
      commitDefenderSchemaVersion: 1,
      baselineRevision: '47dabfea718729b0ccc685ae173857476040d6ea',
    },
    analysisRevisionId: context.analysisRevisionId,
    snapshotId: context.snapshotId,
    summary: report.review.summary,
    grade,
    hasCriticalFindings: findings.some((finding) => finding.priority === 'P3'),
    perFileSummaries,
    findings,
    impact: context.emptyImpact,
    coverage: context.coverage,
    versions: { compatibility: 'commit-defender-v1' },
    durationMs: report.duration_ms,
  });
}

export function priorityRank(priority: z.infer<typeof prioritySchema>): number {
  return { P0: 0, P1: 1, P2: 2, P3: 3 }[priority];
}

function severityToPriority(severity: 'error' | 'warning' | 'info') {
  return severity === 'error'
    ? ('P3' as const)
    : severity === 'warning'
      ? ('P2' as const)
      : ('P1' as const);
}

function lintRuleCategory(rule: string): z.infer<typeof findingCategorySchema> {
  const normalized = rule.toUpperCase();
  if (/^S\d/.test(normalized)) return 'security';
  if (/^(PERF|C90|FLY)/.test(normalized)) return 'optimization';
  if (/^(E|W|N|D|I|Q|UP|ANN|SIM|ERA|T|ARG|TC|TID|PTH|COM|G|FBT|ISC|ICN|PT|FA|RUF)/.test(normalized))
    return 'maintenance';
  return 'correctness';
}

function normalizePriority(priority: string): z.infer<typeof prioritySchema> {
  const parsed = prioritySchema.safeParse(priority.toUpperCase());
  return parsed.success ? parsed.data : 'P1';
}

function normalizeCategory(category: string): z.infer<typeof findingCategorySchema> {
  const parsed = findingCategorySchema.safeParse(category.toLowerCase());
  return parsed.success ? parsed.data : 'correctness';
}

function firstSentence(comment: string): string {
  const first = comment
    .split(/\r?\n|(?<=[.!?])\s/)[0]
    ?.replace(/^#+\s*/, '')
    .trim();
  return (first || 'Review finding').slice(0, 160);
}
