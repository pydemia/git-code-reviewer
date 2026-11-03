import {
  boolean,
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
  text,
  timestamp,
  union,
  unique,
} from './codec.js';
import { executionIdentity, sourceFile, sourceLocation } from './identity.js';

export const severity = choice(['P0', 'P1', 'P2', 'P3']);
export type Severity = ReturnType<typeof severity>;
export const enforcement = choice(['advisory', 'warn', 'block']);
export const findingOutcome = choice([
  'violation',
  'satisfied',
  'not-applicable',
  'incomplete',
  'error',
]);
export const grade = choice(['exceptional', 'proficient', 'adequate', 'insufficient', 'critical']);
export const reviewStatus = choice([
  'queued',
  'running',
  'completed',
  'partial',
  'needs-context',
  'unavailable',
  'failed',
  'cancelled',
  'superseded',
]);
export type ReviewStatus = ReturnType<typeof reviewStatus>;
export const sourceExclusionReason = choice([
  'invalid-path',
  'private-data',
  'generated',
  'binary',
  'user-excluded',
  'git-ignored',
  'symlink',
  'not-file',
  'unreadable',
  'unsupported-source',
  'policy-excluded',
]);
export const problemCode = choice([
  'provider-error',
  'source-error',
  'timeout',
  'cancelled',
  'superseded',
  'source-truncated',
  'response-truncated',
  'response-incomplete',
  'context-truncated',
  'invalid-output',
  'missing-context',
  'executor-unavailable',
  'policy-unavailable',
  'quota-exceeded',
]);
export const reviewProblem = object({ code: problemCode, message: text(4096, 1) });
export const anchorValidation = object({
  status: choice(['verified', 'limited', 'unassessed']),
  checks: list(text(256, 1), 100),
  reason: text(4096),
});
export const evidenceAssessment = object({
  level: choice(['unassessed', 'hypothesis', 'source-confirmed', 'test-confirmed']),
  rationale: text(100_000),
  conditions: list(text(4096, 1), 1000),
  evidenceIds: list(id, 10_000),
  counterEvidence: object({
    status: choice(['not-reviewed', 'reviewed', 'conflicting']),
    summary: text(100_000),
    evidenceIds: list(id, 10_000),
  }),
});
export type EvidenceAssessment = ReturnType<typeof evidenceAssessment>;

/** Claimed provenance is data. Parsing cannot authenticate an issuer or attest execution. */
const provenance = object({
  kind: choice(['local-observation', 'client-claim', 'central-attestation', 'ci-attestation']),
  producer: text(256, 1),
  reference: text(4096, 1),
});
const evidenceHeader = {
  id,
  sourceHash: sha256,
  contextHash: sha256,
  provenance,
  observedAt: timestamp,
};
export const reviewEvidence = union(
  object({
    kind: literal('source-read'),
    ...evidenceHeader,
    location: sourceLocation,
    observation: text(100_000, 1),
  }),
  object({ kind: literal('reasoning'), ...evidenceHeader, statement: text(100_000, 1) }),
  object({
    kind: literal('test-execution'),
    ...evidenceHeader,
    runnerProfileHash: sha256,
    environmentHash: sha256,
    artifactHash: sha256,
    result: choice(['confirmed', 'not-confirmed', 'incomplete']),
    inputs: text(100_000, 1),
    expected: text(100_000, 1),
    actual: text(100_000, 1),
    comparison: choice(['base-to-source', 'source-only']),
    baseObservation: optional(text(100_000, 1)),
    baseSourceHash: optional(sha256),
    exitCode: union(integer(-2147483648, 2147483647), literal(null)),
  }),
);
export type ReviewEvidence = ReturnType<typeof reviewEvidence>;
export const reviewFinding = object({
  id,
  title: text(4096, 1),
  problem: text(100_000, 1),
  impact: text(100_000),
  recommendation: text(100_000),
  category: text(64, 1, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  severity,
  outcome: findingOutcome,
  confidence: choice(['low', 'medium', 'high', 'unassessed']),
  followUp: choice(['required', 'none']),
  anchor: sourceLocation,
  anchorValidation,
  evidenceAssessment,
  policy: object({
    enforcement,
    ruleId: optional(id),
    ruleRevision: optional(integer(1)),
    exceptionId: optional(id),
  }),
  legacyVerification: optional(
    object({
      status: choice(['verified', 'limited']),
      checks: list(text(256, 1), 100),
      originalPriority: text(64, 1),
    }),
  ),
});
export type ReviewFinding = ReturnType<typeof reviewFinding>;
const fileOutcome = object({
  source: sourceFile,
  status: choice(['completed', 'partial', 'failed', 'cancelled', 'not-run']),
  summary: text(100_000),
  grade: optional(grade),
});
const reportShape = object({
  contractVersion: literal(1),
  runId: id,
  identity: executionIdentity,
  status: reviewStatus,
  trigger: choice(['manual', 'save', 'stage', 'commit', 'push', 'work_completed']),
  requestedAt: timestamp,
  startedAt: optional(timestamp),
  finishedAt: optional(timestamp),
  durationMs: integer(),
  summary: text(1_000_000),
  grade: optional(grade),
  sourceFiles: list(sourceFile),
  files: list(fileOutcome),
  excluded: list(object({ path: text(4096, 1), reason: sourceExclusionReason })),
  problems: list(reviewProblem, 10_000),
  findings: list(reviewFinding),
  evidence: list(reviewEvidence),
  questions: list(object({ id, prompt: text(100_000, 1), required: boolean }), 10_000),
});
export type ClientReviewReport = ReturnType<typeof reportShape>;
const finalStatuses = new Set<ReviewStatus>([
  'completed',
  'partial',
  'needs-context',
  'unavailable',
  'failed',
  'cancelled',
  'superseded',
]);

export const clientReviewReport = refined(reportShape, (report, at) => {
  const { client, source, context } = report.identity;
  if (finalStatuses.has(report.status) !== !!report.finishedAt)
    fail(at, 'terminal state/finishedAt mismatch');
  if (report.status === 'running' && !report.startedAt)
    fail(at, 'running review has no start time');
  if (report.status === 'queued' && report.startedAt) fail(at, 'queued review already started');
  if (
    (report.startedAt && report.startedAt < report.requestedAt) ||
    (report.finishedAt && report.finishedAt < (report.startedAt ?? report.requestedAt))
  )
    fail(at, 'invalid run chronology');
  if (report.status !== 'completed' && report.grade) fail(at, 'incomplete review has a grade');
  if (
    report.status === 'completed' &&
    (!report.startedAt ||
      report.files.length === 0 ||
      report.files.some((file) => file.status !== 'completed') ||
      report.problems.length ||
      report.questions.some((question) => question.required) ||
      context.required.some((item) => !item.available) ||
      report.findings.some((finding) => ['incomplete', 'error'].includes(finding.outcome)))
  )
    fail(at, 'completed review has unfinished work');
  if (report.status === 'completed' && client.mode === 'centralized' && !context.centralSnapshot)
    fail(at, 'centralized completion lacks policy snapshot');
  if (
    ['partial', 'needs-context', 'unavailable', 'failed', 'cancelled', 'superseded'].includes(
      report.status,
    ) &&
    report.problems.length === 0
  )
    fail(at, 'incomplete review has no reason');
  if (
    report.status === 'partial' &&
    !report.files.some((file) => file.status === 'completed' || file.status === 'partial')
  )
    fail(at, 'partial review has no usable coverage');
  for (const file of report.files)
    if (file.status !== 'completed' && file.grade) fail(at, 'incomplete file has a grade');
  unique(
    report.files.map((file) => file.source.path),
    `${at}.files`,
  );
  unique(
    report.sourceFiles.map((file) => `${file.side}:${file.path}`),
    `${at}.sourceFiles`,
  );
  const sources = new Map(report.sourceFiles.map((file) => [`${file.side}:${file.path}`, file]));
  const selected = new Map(
    report.files.map((file) => [`${file.source.side}:${file.source.path}`, file.source]),
  );
  for (const file of report.files) {
    const captured = sources.get(`${file.source.side}:${file.source.path}`);
    if (
      !captured ||
      captured.hash !== file.source.hash ||
      captured.byteLength !== file.source.byteLength ||
      captured.lineCount !== file.source.lineCount ||
      captured.gitBlob !== file.source.gitBlob
    )
      fail(at, 'selected file is not in captured source manifest');
  }
  for (const file of report.sourceFiles)
    if (file.gitBlob && file.gitBlob.length !== (source.objectFormat === 'sha1' ? 40 : 64))
      fail(at, 'blob object format mismatch');
  unique(
    report.findings.map((finding) => finding.id),
    `${at}.findings`,
  );
  unique(
    report.evidence.map((evidence) => evidence.id),
    `${at}.evidence`,
  );
  unique(
    report.questions.map((question) => question.id),
    `${at}.questions`,
  );
  const evidenceById = new Map(report.evidence.map((evidence) => [evidence.id, evidence]));
  const validateLocation = (location: ReturnType<typeof sourceLocation>, selectedOnly = false) => {
    if (
      location.endLine < location.startLine ||
      (location.startLine === 0 && location.endLine !== 0)
    )
      fail(at, 'invalid source range');
    const file = (selectedOnly ? selected : sources).get(`${location.side}:${location.path}`);
    if (!file || file.hash !== location.hash || location.endLine > file.lineCount)
      fail(at, 'anchor is outside captured source');
  };
  for (const evidence of report.evidence) {
    if (evidence.sourceHash !== source.hash || evidence.contextHash !== context.hash)
      fail(at, 'evidence belongs to another source/context');
    if (evidence.kind === 'source-read') validateLocation(evidence.location);
    if (
      evidence.kind === 'test-execution' &&
      evidence.comparison === 'base-to-source' &&
      (!evidence.baseObservation || !evidence.baseSourceHash)
    )
      fail(at, 'base comparison has no base evidence');
  }
  for (const finding of report.findings) {
    validateLocation(finding.anchor, true);
    if (finding.severity === 'P0' && finding.outcome !== 'satisfied')
      fail(at, 'P0 praise must describe a satisfied outcome');
    const assessment = finding.evidenceAssessment;
    unique(assessment.evidenceIds, `${at}.evidenceAssessment.evidenceIds`);
    unique(assessment.counterEvidence.evidenceIds, `${at}.counterEvidence.evidenceIds`);
    const evidenceIds = [...assessment.evidenceIds, ...assessment.counterEvidence.evidenceIds];
    for (const id of evidenceIds) if (!evidenceById.has(id)) fail(at, 'missing evidence reference');
    const evidence = assessment.evidenceIds.map((id) => evidenceById.get(id)!);
    if (
      assessment.level === 'source-confirmed' &&
      !evidence.some((entry) => entry.kind === 'source-read')
    )
      fail(at, 'source confirmation has no read evidence');
    if (
      assessment.level === 'test-confirmed' &&
      !evidence.some((entry) => entry.kind === 'test-execution' && entry.result === 'confirmed')
    )
      fail(at, 'test confirmation has no reproduction evidence');
    if (
      ['source-confirmed', 'test-confirmed'].includes(assessment.level) &&
      (!assessment.rationale ||
        !assessment.conditions.length ||
        assessment.counterEvidence.status !== 'reviewed')
    )
      fail(at, 'confirmed assessment lacks conditions or counter-evidence review');
    if ((finding.policy.ruleId === undefined) !== (finding.policy.ruleRevision === undefined))
      fail(at, 'rule identity is incomplete');
    if (
      finding.policy.enforcement !== 'advisory' &&
      !context.entries.some(
        (entry) =>
          entry.origin === 'central' &&
          entry.kind === 'policy' &&
          entry.component === 'policy' &&
          entry.id === finding.policy.ruleId &&
          entry.revision === finding.policy.ruleRevision,
      )
    )
      fail(at, 'enforcement has no pinned policy rule revision');
    if (
      finding.outcome === 'violation' &&
      finding.followUp === 'none' &&
      !finding.policy.exceptionId
    )
      fail(at, 'violation without follow-up needs an explicit exception');
  }
});

/** CLI follow-up is independent from the enforcement policy applied by a hook adapter. */
export function reviewExitCode(value: ClientReviewReport): 0 | 1 | 2 {
  const report = clientReviewReport(value);
  if (report.status !== 'completed') return 2;
  return report.findings.some((finding) => finding.followUp === 'required') ||
    report.questions.length > 0
    ? 1
    : 0;
}
export function advisoryHookExitCode(): 0 {
  return 0;
}
