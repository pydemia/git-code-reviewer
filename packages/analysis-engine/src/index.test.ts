import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { analyzeSnapshot, expandRelationships, parseModelReviewJson } from './index.js';

describe('analysis engine', () => {
  it('produces verified Commit Defender compatible findings and relationship evidence', async () => {
    const output = await analyzeSnapshot({
      analysisId: randomUUID(),
      snapshotId: randomUUID(),
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      patch: '',
      fixtureMode: true,
      files: [
        {
          id: randomUUID(),
          path: 'src/auth/session.ts',
          previousPath: null,
          status: 'modified',
          additions: 3,
          deletions: 1,
          patch: [
            '@@ -1,3 +1,5 @@',
            ' export async function rotateSession(token: string) {',
            '+  return database.transaction(async (tx) => {',
            '   const current = await sessions.findByToken(token);',
            '   return current;',
            '+  });',
          ].join('\n'),
        },
      ],
    });
    expect(output.state).toBe('completed');
    expect(output.report.findings.map((finding) => finding.priority)).toEqual(['P2', 'P0']);
    expect(
      output.report.findings.every((finding) => finding.verification.status === 'verified'),
    ).toBe(true);
    expect(output.graph.relations.some((relation) => relation.kind === 'contains')).toBe(true);
    expect(output.graph.relations.some((relation) => relation.kind === 'calls')).toBe(true);
  });

  it('marks relationship cycles and bounded paths', () => {
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    const relations = [
      { id: randomUUID(), sourceObjectId: a, targetObjectId: b },
      { id: randomUUID(), sourceObjectId: b, targetObjectId: c },
      { id: randomUUID(), sourceObjectId: c, targetObjectId: a },
    ].map((relation) => ({
      ...relation,
      kind: 'calls' as const,
      distance: 1,
      change: 'unchanged' as const,
      confidence: 'high' as const,
      evidence: [],
    }));
    const paths = expandRelationships({ relations }, a, 'outgoing', 4);
    expect(paths.some((path) => path.cycle)).toBe(true);
    expect(paths.find((path) => path.cycle)?.objectIds).toEqual([a, b, c, a]);
  });

  it('recovers complete entries from a truncated model object', () => {
    const parsed = parseModelReviewJson(
      '{"summary":"검토","grade":"adequate","file_comments":[{"file":"a.ts","line":1,"comment":"확인","category":"correctness","priority":"P2"}',
    );
    expect(parsed.truncated).toBe(true);
    expect(parsed.value.file_comments).toHaveLength(1);
  });
});
