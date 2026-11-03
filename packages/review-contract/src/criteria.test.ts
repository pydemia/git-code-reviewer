import { describe, expect, it } from 'vitest';
import { bindFindingCriteria, type SharedCriterionContext } from './criteria.js';
import { criterionAssessmentInputSchema } from '@gcr/contracts';

const assessment = criterionAssessmentInputSchema.parse({
  id: 'rule',
  revision: 2,
  hash: 'a'.repeat(64),
  outcome: 'violation',
  rationale: 'Changed code uses an unscoped key.',
  counterEvidence: {
    status: 'reviewed',
    explanation: 'The supplied caller does not add a tenant prefix.',
  },
});
const context: SharedCriterionContext = {
  pinHash: 'b'.repeat(64),
  contextHash: 'c'.repeat(64),
  criteria: [
    {
      id: 'rule',
      revision: 2,
      hash: assessment.hash,
      title: '<script>rule</script>',
      targets: [{ path: 'cache.ts', side: 'source', hash: 'd'.repeat(64) }],
    },
  ],
};
const finding = { path: 'cache.ts', side: 'head' as const, priority: 'P2', anchorVerified: true };
describe('immutable criterion linkage', () => {
  it('takes title, source and publication identities only from trusted selection', () => {
    const result = bindFindingCriteria([assessment], finding, context)!;
    expect(result.status).toBe('linked');
    expect(result.items[0]).toMatchObject({
      ...assessment,
      title: context.criteria[0]!.title,
      sourceHash: 'd'.repeat(64),
      pinHash: context.pinHash,
      contextHash: context.contextHash,
      evaluator: 'model',
      validation: 'pinned-target',
    });
    expect(result.items[0]).not.toHaveProperty('testConfirmed');
  });
  it.each([
    'id',
    'revision',
    'hash',
    'path',
    'side',
    'anchor',
    'context',
    'counter-evidence',
    'praise',
  ])('rejects a mismatched or unsupported %s without leaking raw identifiers', (kind) => {
    const raw = structuredClone(assessment),
      anchor = { ...finding },
      trusted = structuredClone(context);
    if (kind === 'id') raw.id = 'private-or-invented-rule';
    if (kind === 'revision') raw.revision++;
    if (kind === 'hash') raw.hash = 'e'.repeat(64);
    if (kind === 'path') anchor.path = 'other.ts';
    if (kind === 'side') trusted.criteria[0]!.targets[0]!.side = 'base';
    if (kind === 'anchor') anchor.anchorVerified = false;
    if (kind === 'counter-evidence') raw.counterEvidence.status = 'not-reviewed';
    if (kind === 'praise') anchor.priority = 'P0';
    const result = bindFindingCriteria([raw], anchor, kind === 'context' ? undefined : trusted);
    expect(result).toEqual({ status: 'unavailable', rejected: 1, items: [] });
    expect(JSON.stringify(result)).not.toContain(raw.id);
  });
  it('preserves legacy absence and treats omitted judgments as unreported, never satisfied', () => {
    expect(bindFindingCriteria(undefined, finding)).toBeUndefined();
    expect(bindFindingCriteria([], finding, context)).toEqual({
      status: 'not-reported',
      rejected: 0,
      items: [],
    });
  });
  it('allows explicit uncertainty with unreviewed counter-evidence and binds a deleted source only to base', () => {
    const selected = structuredClone(context);
    selected.criteria[0]!.targets[0]!.side = 'base';
    const result = bindFindingCriteria(
      [
        {
          ...assessment,
          outcome: 'uncertain',
          counterEvidence: {
            status: 'not-reviewed',
            explanation: 'Caller was not available.',
          },
        },
      ],
      { ...finding, side: 'mergeBase' },
      selected,
    )!;
    expect(result.items[0]?.outcome).toBe('uncertain');
  });
  it('does not allow duplicate judgments to inflate linked criterion counts', () => {
    const result = bindFindingCriteria([assessment, assessment], finding, context)!;
    expect(result.items).toHaveLength(1);
    expect(result.rejected).toBe(1);
  });
});
