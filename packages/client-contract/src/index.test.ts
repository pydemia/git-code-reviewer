import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  legacyAnalysisReportSchema,
  normalizeLegacyReport,
} from '../../review-contract/src/index.js';
import {
  ContractError,
  advisoryHookExitCode,
  clientIdentity,
  clientReviewReport,
  importLegacyAssessment,
  localKnowledge,
  projectCommitDefender,
  repositoryIdentity,
  reviewExitCode,
  type ClientReviewReport,
  type CentralAudience,
} from './index.js';

const corpus = JSON.parse(
  readFileSync(
    new URL('../../../tests/fixtures/client-contract/reports.json', import.meta.url),
    'utf8',
  ),
);
const cases = corpus.cases as Array<{
  name: string;
  report: unknown;
  expected: { legacyStatus: string; exitCode: number; comments: number };
}>;
function fixture(name = 'legacy-verified-advisory'): ClientReviewReport {
  return clientReviewReport(cases.find((entry) => entry.name === name)!.report);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const audience: CentralAudience = {
  serverId: 'server-fixture',
  tenantId: 'tenant-fixture',
  userId: 'user-fixture',
  repositoryId: 'repo-fixture',
};
function centralized(): ClientReviewReport {
  const report = fixture();
  report.identity.client = {
    ...report.identity.client,
    mode: 'centralized',
    audience: { ...audience },
  };
  report.identity.context.centralSnapshot = {
    id: 'snapshot-fixture',
    hash: hash('central fixture'),
    audience: { ...audience },
    authorizationRevision: 'authz-1',
    offlineValidUntil: '2026-01-02T00:00:00.000Z',
  };
  report.identity.context.entries.push({
    origin: 'central',
    kind: 'policy',
    id: 'rule-fixture',
    revision: 2,
    hash: hash('rule fixture'),
    component: 'policy',
  });
  return report;
}

describe('shared client report fixtures', () => {
  it.each(cases)(
    '$name preserves the terminal result, reasons and complete source/evidence record',
    ({ report: value, expected }) => {
      const report = clientReviewReport(value);
      const projected = projectCommitDefender(report);
      expect(projected.review.status).toBe(expected.legacyStatus);
      expect(reviewExitCode(report)).toBe(expected.exitCode);
      expect(projected.review.file_comments).toHaveLength(expected.comments);
      expect(projected.review.incomplete_reasons).toEqual([
        ...new Set(report.problems.map((problem) => problem.code)),
      ]);
      expect(projected.source_exclusions).toEqual(report.excluded);
      expect(projected.gcr.report).toEqual(report);
      expect(projected.gcr.report).not.toBe(report);
      expect(projected.exit_code).toBe(0);
      expect(projected.review.blocking).toBe(false);
      expect(projected.gcr.enforcement).toBe('advisory');
      expect(advisoryHookExitCode()).toBe(0);
      for (const file of report.files) {
        expect(projected.source_anchors[file.source.path]).toEqual({
          sha256: file.source.hash,
          line_count: file.source.lineCount,
          side: file.source.side,
        });
      }
      if (report.identity.source.kind === 'index') {
        expect(projected.source_snapshot).toEqual({
          kind: 'index',
          base_commit: report.identity.source.baseCommit,
          base_tree: report.identity.source.baseTree,
          source_tree: report.identity.source.sourceTree,
        });
      } else {
        expect(projected.source_snapshot).toEqual({
          kind: 'working-tree',
          content_sha256: Object.fromEntries(
            report.files.map((file) => [file.source.path, file.source.hash]),
          ),
        });
      }
    },
  );

  it('uses real UTF-8 content hashes and Git blob IDs, without claiming a model or test execution', () => {
    expect(corpus.synthetic).toBe(true);
    for (const entry of cases)
      for (const file of clientReviewReport(entry.report).sourceFiles) {
        const text = (file.side === 'base' ? corpus.baseText : corpus.sourceText)[file.path];
        expect(file.hash).toBe(hash(text));
        expect(file.byteLength).toBe(Buffer.byteLength(text));
        expect(file.lineCount).toBe(text.split('\n').length);
        expect(file.gitBlob).toBe(
          createHash('sha1')
            .update(`blob ${Buffer.byteLength(text)}\0`)
            .update(text)
            .digest('hex'),
        );
      }
    for (const evidence of fixture('test-evidence-claim').evidence)
      expect(evidence.provenance.kind).toBe('client-claim');
  });

  it.each([2, 99])(
    'imports the current server legacy normalizer at line %i without rewriting its confidence or verification',
    (line) => {
      const legacy = projectCommitDefender(fixture());
      legacy.review.file_comments[0]!.line = line;
      const coverage = {
        filesChanged: 1,
        filesExamined: 1,
        objectsExamined: 0,
        relationsExamined: 0,
        truncated: false,
        limitations: [],
      };
      const normalized = normalizeLegacyReport(legacyAnalysisReportSchema.parse(legacy), {
        analysisRevisionId: randomUUID(),
        snapshotId: randomUUID(),
        files: [{ id: randomUUID(), path: 'source.ts', headLines: new Set([1, 2, 3, 4]) }],
        coverage,
        emptyImpact: { summary: '', affectedAreas: [], coverage, confidence: 'low' },
      });
      const old = normalized.findings[0]!;
      const before = structuredClone(old);
      const imported = importLegacyAssessment({
        confidence: old.confidence,
        verification: old.verification,
      });
      expect(old).toEqual(before);
      expect(imported.confidence).toBe(old.confidence);
      expect(imported.legacyVerification).toEqual(old.verification);
      expect(imported.anchorValidation.status).toBe(line === 2 ? 'verified' : 'limited');
      expect(imported.evidenceAssessment.level).toBe('unassessed');
      expect(imported.evidenceAssessment.evidenceIds).toEqual([]);
      expect(imported.evidenceAssessment.counterEvidence.status).toBe('not-reviewed');
    },
  );

  it('preserves an accepted violation and its exception without turning it into satisfied', () => {
    const report = fixture('accepted-exception');
    const projected = projectCommitDefender(report);
    expect(projected.gcr.report.findings[0]).toMatchObject({
      outcome: 'violation',
      severity: 'P3',
      followUp: 'none',
      policy: { exceptionId: 'exception-fixture' },
    });
    expect(reviewExitCode(report)).toBe(0);
    delete report.findings[0]!.policy.exceptionId;
    expect(() => clientReviewReport(report)).toThrow('explicit exception');
  });

  it('retains evaluations that legacy finding comments cannot display, and preserves P0 praise', () => {
    const report = fixture();
    report.findings[0]!.outcome = 'not-applicable';
    report.findings[0]!.followUp = 'none';
    const projected = projectCommitDefender(report);
    expect(projected.review.file_comments).toEqual([]);
    expect(projected.gcr.report.findings).toEqual(report.findings);
    expect(projected.gcr.projectionOmissions).toEqual([
      { findingId: 'finding-fixture', reason: 'Evaluation outcome: not-applicable' },
    ]);
    report.findings[0]!.outcome = 'satisfied';
    report.findings[0]!.severity = 'P0';
    expect(projectCommitDefender(report).review.file_comments[0]!.priority).toBe('P0');
    report.findings[0]!.outcome = 'violation';
    expect(() => clientReviewReport(report)).toThrow('P0 praise');
  });

  it('projects deleted files against the base source and retains a missing initial base commit', () => {
    const report = fixture();
    const base = report.sourceFiles.find((file) => file.side === 'base')!;
    report.files[0]!.source = { ...base };
    report.findings[0]!.anchor = { ...report.findings[0]!.anchor, side: 'base', hash: base.hash };
    report.identity.source.baseCommit = null;
    const projected = projectCommitDefender(report);
    expect(projected.source_anchors['source.ts']!.side).toBe('base');
    expect(projected.source_snapshot).toMatchObject({ base_commit: null });
  });
});

describe('boundary invariants', () => {
  const invalid: Array<[string, (report: ClientReviewReport) => void]> = [
    [
      'incomplete file',
      (r) => {
        r.files[0]!.status = 'failed';
        delete r.files[0]!.grade;
      },
    ],
    [
      'completion with failure',
      (r) => {
        r.problems.push({ code: 'provider-error', message: 'Failure.' });
      },
    ],
    [
      'missing context',
      (r) => {
        r.identity.context.required.push({
          kind: 'source',
          reference: 'caller',
          available: false,
          reason: 'Unavailable.',
        });
      },
    ],
    [
      'required unanswered question',
      (r) => {
        r.questions.push({ id: 'question', prompt: 'Missing assumption?', required: true });
      },
    ],
    [
      'unfinished finding',
      (r) => {
        r.findings[0]!.outcome = 'incomplete';
      },
    ],
    [
      'missing terminal time',
      (r) => {
        delete r.finishedAt;
      },
    ],
    [
      'invalid chronology',
      (r) => {
        r.finishedAt = '2025-12-31T00:00:00.000Z';
      },
    ],
    [
      'finished running result',
      (r) => {
        r.status = 'running';
      },
    ],
    [
      'unsafe source path',
      (r) => {
        r.files[0]!.source.path = '../secret';
      },
    ],
    [
      'mismatched selected source',
      (r) => {
        r.files[0]!.source.hash = hash('other');
      },
    ],
    [
      'duplicate selected path',
      (r) => {
        r.files.push(structuredClone(r.files[0]!));
      },
    ],
    [
      'duplicate source',
      (r) => {
        r.sourceFiles.push(structuredClone(r.sourceFiles[0]!));
      },
    ],
    [
      'wrong Git object format',
      (r) => {
        r.identity.source.objectFormat = 'sha256';
      },
    ],
    [
      'wrong Git blob format',
      (r) => {
        r.sourceFiles[1]!.gitBlob = hash('wrong');
      },
    ],
    [
      'another anchor hash',
      (r) => {
        r.findings[0]!.anchor.hash = hash('wrong');
      },
    ],
    [
      'out of range anchor',
      (r) => {
        r.findings[0]!.anchor.endLine = 999;
      },
    ],
    [
      'mixed whole-file and line range',
      (r) => {
        r.findings[0]!.anchor.startLine = 0;
      },
    ],
    [
      'fractional line',
      (r) => {
        r.findings[0]!.anchor.startLine = 1.5;
      },
    ],
    [
      'duplicate finding',
      (r) => {
        r.findings.push(structuredClone(r.findings[0]!));
      },
    ],
    [
      'missing evidence',
      (r) => {
        r.findings[0]!.evidenceAssessment.evidenceIds = ['absent'];
      },
    ],
    [
      'unrecorded source confirmation',
      (r) => {
        r.findings[0]!.evidenceAssessment.level = 'source-confirmed';
      },
    ],
    [
      'unrecorded test confirmation',
      (r) => {
        r.findings[0]!.evidenceAssessment.level = 'test-confirmed';
      },
    ],
    [
      'implicit severity-based block',
      (r) => {
        r.findings[0]!.policy.enforcement = 'block';
      },
    ],
    [
      'missing rule revision',
      (r) => {
        r.findings[0]!.policy.ruleId = 'rule';
      },
    ],
  ];
  it.each(invalid)('rejects %s', (_name, mutate) => {
    const report = fixture();
    mutate(report);
    expect(() => clientReviewReport(report)).toThrow(ContractError);
  });

  it.each(['queued', 'running'] as const)(
    'keeps %s out of terminal CD display projection',
    (status) => {
      const report = fixture('clean');
      report.status = status;
      delete report.finishedAt;
      delete report.grade;
      if (status === 'queued') delete report.startedAt;
      report.files[0]!.status = 'not-run';
      delete report.files[0]!.grade;
      expect(clientReviewReport(report).status).toBe(status);
      expect(reviewExitCode(report)).toBe(2);
      expect(() => projectCommitDefender(report)).toThrow('project only terminal');
    },
  );

  it('keeps superseded results cancelled and context shortages partial only with usable coverage', () => {
    const report = fixture('cancelled');
    report.status = 'superseded';
    report.problems = [{ code: 'superseded', message: 'New source replaced this run.' }];
    expect(projectCommitDefender(report).review.status).toBe('cancelled');
    const context = fixture('needs-context');
    context.files[0]!.status = 'partial';
    expect(projectCommitDefender(context).review.status).toBe('partial');
    expect(reviewExitCode(context)).toBe(2);
  });

  it('rejects unknown contract versions, raw secret fields and sparse JSON-like inputs', () => {
    const report = fixture();
    expect(() => clientReviewReport({ ...report, contractVersion: 2 })).toThrow(ContractError);
    expect(() => clientReviewReport({ ...report, apiKey: 'synthetic-not-a-secret' })).toThrow(
      'unknown field',
    );
    expect(() => clientReviewReport({ ...report, findings: new Array(1) })).toThrow(ContractError);
    expect(() =>
      clientReviewReport({
        ...report,
        identity: {
          ...report.identity,
          executor: { ...report.identity.executor, token: 'synthetic' },
        },
      }),
    ).toThrow('unknown field');
    expect(() => clientReviewReport(JSON.parse('{"__proto__":{}}'))).toThrow('unknown field');
  });

  it('permits related captured evidence while keeping findings on selected source', () => {
    const report = fixture('source-evidence');
    expect(clientReviewReport(report).evidence).toHaveLength(2);
    const related = report.evidence[1]!;
    if (related.kind !== 'source-read') throw new Error('fixture shape');
    report.findings[0]!.anchor = { ...related.location };
    expect(() => clientReviewReport(report)).toThrow('outside captured source');
    const missingRelated = fixture('source-evidence');
    missingRelated.sourceFiles = missingRelated.sourceFiles.filter(
      (file) => file.path !== 'caller.ts',
    );
    expect(() => clientReviewReport(missingRelated)).toThrow('outside captured source');
  });

  it.each(['sourceHash', 'contextHash'] as const)('rejects evidence from another %s', (key) => {
    const report = fixture('source-evidence');
    report.evidence[0]![key] = hash('different run');
    expect(() => clientReviewReport(report)).toThrow('another source/context');
  });

  it('requires source conditions and counter-evidence review instead of anchor verification alone', () => {
    const report = fixture('source-evidence');
    report.findings[0]!.evidenceAssessment.counterEvidence.status = 'not-reviewed';
    expect(() => clientReviewReport(report)).toThrow('counter-evidence review');
    report.findings[0]!.evidenceAssessment.counterEvidence.status = 'reviewed';
    report.findings[0]!.evidenceAssessment.conditions = [];
    expect(() => clientReviewReport(report)).toThrow('conditions');
  });

  it('requires recorded reproduction and a base observation; exit 0 alone supplies neither', () => {
    const report = fixture('test-evidence-claim');
    const evidence = report.evidence.find((entry) => entry.kind === 'test-execution')!;
    evidence.exitCode = 0;
    evidence.result = 'not-confirmed';
    expect(() => clientReviewReport(report)).toThrow('no reproduction evidence');
    evidence.result = 'confirmed';
    delete evidence.baseObservation;
    expect(() => clientReviewReport(report)).toThrow('base evidence');
    evidence.baseObservation = 'Base returns a number.';
    evidence.inputs = '';
    expect(() => clientReviewReport(report)).toThrow(ContractError);
  });
});

describe('identity, knowledge and policy boundaries', () => {
  it('does not accept residual central authority in standalone identity/context', () => {
    const central = centralized();
    expect(clientReviewReport(central).identity.client.mode).toBe('centralized');
    const standalone = fixture().identity.client;
    expect(() => clientIdentity({ ...standalone, audience })).toThrow(ContractError);
    central.identity.client = standalone;
    expect(() => clientReviewReport(central)).toThrow('standalone');
  });
  it.each(['serverId', 'tenantId', 'userId', 'repositoryId'] as const)(
    'binds a central snapshot to the same %s',
    (key) => {
      const report = centralized();
      report.identity.context.centralSnapshot!.audience[key] = 'another';
      expect(() => clientReviewReport(report)).toThrow('audience mismatch');
    },
  );
  it('permits policy enforcement only for an explicitly pinned rule revision and still projects advisory', () => {
    const report = centralized();
    report.findings[0]!.policy = { enforcement: 'block', ruleId: 'rule-fixture', ruleRevision: 2 };
    const projected = projectCommitDefender(report);
    expect(projected.gcr.report.findings[0]!.policy.enforcement).toBe('block');
    expect(projected.review.blocking).toBe(false);
    expect(projected.exit_code).toBe(0);
    report.findings[0]!.policy.ruleRevision = 3;
    expect(() => clientReviewReport(report)).toThrow('pinned policy rule revision');
    report.findings[0]!.policy.ruleRevision = 2;
    const entry = report.identity.context.entries[0]!;
    if (entry.origin !== 'central') throw new Error('fixture shape');
    entry.component = 'personal';
    expect(() => clientReviewReport(report)).toThrow('pinned policy rule revision');
  });
  it.each(['profileId', 'repositoryKey', 'worktreeKey'] as const)(
    'rejects local context with another %s',
    (key) => {
      const report = fixture();
      const client = report.identity.client;
      const scope = {
        kind: 'repository' as const,
        profileId: client.profileId,
        repositoryKey: client.repositoryKey,
        worktreeKey: client.worktreeKey,
      };
      report.identity.context.entries = [
        {
          origin: 'local',
          kind: 'memory',
          id: 'memory-fixture',
          revision: 1,
          hash: hash('memory'),
          scope,
        },
      ];
      expect(clientReviewReport(report).identity.context.entries).toHaveLength(1);
      scope[key] = key === 'profileId' ? 'another-profile' : hash('another-key');
      expect(() => clientReviewReport(report)).toThrow('mismatch');
    },
  );
  it('accepts only parsed remotes without a raw URL or credential field', () => {
    const identity = {
      key: hash('repo'),
      worktreeKey: hash('tree'),
      gitObjectFormat: 'sha1',
      remotes: [
        {
          name: 'origin',
          transport: 'https',
          host: 'example.invalid',
          namespace: 'team',
          repository: 'project',
        },
      ],
    };
    expect(repositoryIdentity(identity).remotes[0]!.host).toBe('example.invalid');
    expect(() =>
      repositoryIdentity({
        ...identity,
        remotes: [
          { ...identity.remotes[0], url: 'https://synthetic@example.invalid/team/project' },
        ],
      }),
    ).toThrow('unknown field');
  });

  const memory = {
    kind: 'memory',
    id: 'memory-fixture',
    scope: { kind: 'profile', profileId: 'profile-fixture' },
    revision: 1,
    hash: hash('knowledge fixture'),
    state: 'candidate',
    title: 'Return contract',
    body: 'Callers require a number.',
    appliesTo: { paths: ['src/**'], languages: ['typescript'], symbols: ['load'], branches: [] },
    sources: [{ kind: 'user-note', id: 'note-fixture' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rationale: 'Synthetic fixture.',
    counterEvidence: [],
  };
  it('separates candidate memory and review-only Skills, preserving scope and immutable revision fields', () => {
    expect(localKnowledge(memory)).toMatchObject({
      state: 'candidate',
      revision: 1,
      scope: memory.scope,
    });
    const header = Object.fromEntries(
      Object.entries(memory).filter(([key]) => !['rationale', 'counterEvidence'].includes(key)),
    );
    const skill = { ...header, kind: 'skill', reviewOnly: true, origin: 'user-authored' };
    expect(localKnowledge(skill)).toMatchObject({
      kind: 'skill',
      reviewOnly: true,
      hash: memory.hash,
    });
    expect(() => localKnowledge({ ...skill, reviewOnly: false })).toThrow(ContractError);
    expect(() => localKnowledge({ ...skill, command: 'run' })).toThrow(ContractError);
    expect(() =>
      localKnowledge({ ...memory, offlineValidUntil: '2026-01-02T00:00:00.000Z' }),
    ).toThrow(ContractError);
  });
  it('rejects invalid knowledge chronology and revision rather than silently rewriting imported data', () => {
    expect(() => localKnowledge({ ...memory, updatedAt: '2025-12-31T00:00:00.000Z' })).toThrow(
      'precedes creation',
    );
    expect(() => localKnowledge({ ...memory, revision: 0 })).toThrow(ContractError);
    expect(() => localKnowledge({ ...memory, hash: 'not-a-content-hash' })).toThrow(ContractError);
    expect(() => localKnowledge({ ...memory, expiresAt: '2026-02-30T00:00:00.000Z' })).toThrow(
      ContractError,
    );
  });
});
