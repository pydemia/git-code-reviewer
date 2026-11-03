import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { normalizeLegacyReport } from '@gcr/review-contract';
import { assignFindingOccurrences } from './occurrences.js';

function report(line = 1, code = 'cache[key];', problem = 'Tenant key missing') {
  const file = { id: randomUUID(), path: 'cache.ts', patch: `@@ -0,0 +${line},1 @@\n+${code}\n` };
  const coverage = {
    filesChanged: 1,
    filesExamined: 1,
    objectsExamined: 0,
    relationsExamined: 0,
    truncated: false,
    limitations: [],
  };
  const output = normalizeLegacyReport(
    {
      schema_version: 1,
      staged_files: [file.path],
      duration_ms: 0,
      exit_code: 0,
      lint_findings: [],
      review: {
        summary: 'synthetic',
        grade: 'adequate',
        blocking: false,
        is_error: false,
        file_comments: [
          { file: file.path, line, category: 'correctness', priority: 'P2', comment: problem },
        ],
      },
    },
    {
      analysisRevisionId: randomUUID(),
      snapshotId: randomUUID(),
      files: [{ id: file.id, path: file.path, headLines: new Set([line]) }],
      coverage,
      emptyImpact: { summary: '', affectedAreas: [], coverage, confidence: 'low' },
    },
  );
  assignFindingOccurrences(output, [file]);
  return { output, file };
}
it('uses a new source observation identity that survives line movement without changing the original fingerprint', () => {
  const first = report(),
    moved = report(30);
  expect(first.output.findings[0]!.occurrence?.key).toBe(moved.output.findings[0]!.occurrence?.key);
  expect(first.output.findings[0]!.fingerprint).not.toBe(moved.output.findings[0]!.fingerprint);
});
it.each(['code', 'problem', 'profile', 'path', 'rule'])(
  'does not merge another %s into an observation',
  (kind) => {
    const first = report(),
      other = report(
        2,
        kind === 'code' ? 'cache[tenant][key];' : 'cache[key];',
        kind === 'problem' ? 'Cache value lifetime is wrong' : 'Tenant key missing',
      );
    if (kind === 'profile') other.output.versions.model = 'another-profile';
    if (kind === 'path') other.file.path = 'another.ts';
    if (kind === 'rule') other.output.findings[0]!.source.rule = 'other-rule';
    assignFindingOccurrences(other.output, [other.file]);
    expect(other.output.findings[0]!.occurrence?.key).not.toBe(
      first.output.findings[0]!.occurrence?.key,
    );
  },
);
it('does not assign unverified, praise or unavailable source segments', () => {
  const { output, file } = report();
  const item = output.findings[0]!;
  delete item.occurrence;
  item.verification.status = 'limited';
  assignFindingOccurrences(output, [file]);
  expect(item.occurrence).toBeUndefined();
  item.verification.status = 'verified';
  item.priority = 'P0';
  assignFindingOccurrences(output, [file]);
  expect(item.occurrence).toBeUndefined();
  item.priority = 'P2';
  file.patch = '';
  assignFindingOccurrences(output, [file]);
  expect(item.occurrence).toBeUndefined();
});
it('separates changed public policy and refuses conflicting overlapping source lines', () => {
  const { output, file } = report();
  assignFindingOccurrences(output, [file], 'a'.repeat(64));
  const key = output.findings[0]!.occurrence!.key;
  assignFindingOccurrences(output, [file], 'b'.repeat(64));
  expect(output.findings[0]!.occurrence!.key).not.toBe(key);
  file.patch += '@@ -0,0 +1,1 @@\n+different();\n';
  assignFindingOccurrences(output, [file]);
  expect(output.findings[0]!.occurrence).toBeUndefined();
});
