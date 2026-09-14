import { type CriterionAssessmentInput, type FindingCriteria } from '@gcr/contracts';
export {
  criterionAssessmentInputSchema,
  findingCriteriaSchema,
  type CriterionAssessmentInput,
  type FindingCriteria,
} from '@gcr/contracts';

/** Supplied by the runtime from its immutable selection, never parsed from model output. */
export type SharedCriterionContext = {
  pinHash: string;
  contextHash: string;
  criteria: Array<{
    id: string;
    revision: number;
    hash: string;
    title: string;
    targets: Array<{ path: string; side: 'source' | 'base'; hash: string }>;
  }>;
};

export function bindFindingCriteria(
  assessments: CriterionAssessmentInput[] | undefined,
  finding: { path: string; side: 'head' | 'mergeBase'; priority: string; anchorVerified: boolean },
  context?: SharedCriterionContext,
): FindingCriteria | undefined {
  if (!context && !assessments?.length) return undefined;
  const items: FindingCriteria['items'] = [];
  let rejected = 0;
  const seen = new Set<string>();
  for (const assessment of assessments ?? []) {
    const criterion = context?.criteria.find(
      (item) =>
        item.id === assessment.id &&
        item.revision === assessment.revision &&
        item.hash === assessment.hash,
    );
    const target = criterion?.targets.find(
      (item) =>
        item.path === finding.path && item.side === (finding.side === 'head' ? 'source' : 'base'),
    );
    if (
      !context ||
      !criterion ||
      !target ||
      !finding.anchorVerified ||
      (finding.priority === 'P0' && assessment.outcome !== 'satisfied') ||
      (assessment.outcome !== 'uncertain' && assessment.counterEvidence.status !== 'reviewed') ||
      seen.has(assessment.id)
    ) {
      rejected++;
      continue;
    }
    seen.add(assessment.id);
    items.push({
      ...assessment,
      title: criterion.title,
      sourceHash: target.hash,
      pinHash: context.pinHash,
      contextHash: context.contextHash,
      validation: 'pinned-target',
      evaluator: 'model',
    });
  }
  return {
    status: items.length ? 'linked' : rejected ? 'unavailable' : 'not-reported',
    rejected,
    items,
  };
}
