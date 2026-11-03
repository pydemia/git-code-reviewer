import {
  centralKnowledgeBundle,
  canonicalKnowledgeJson,
  type CentralKnowledgeBundle,
  type ContextEntry,
  type SourceFile,
} from '@gcr/client-contract';
import { compilePathPatterns } from './source-policy.js';
import { sourceLanguage } from './source-language.js';

type Memory = Extract<CentralKnowledgeBundle, { component: 'personal' }>['memories'][number];
type AppliesTo = Memory['content']['appliesTo'];
type Target = Pick<SourceFile, 'path' | 'side' | 'hash'>;
export type CentralReviewItem = {
  component: 'policy' | 'collective' | 'personal';
  kind: 'policy' | 'memory' | 'skill';
  id: string;
  revision: number;
  hash: string;
  targets: Target[];
  required: boolean;
  role: 'authoritative' | 'supplement';
  value: unknown;
  source?: {
    audience: import('@gcr/client-contract').CentralAudience;
    repositoryName?: string | undefined;
    snapshotId: string;
    manifestHash: string;
    originalId: string;
  };
};
export type CentralSelection = {
  items: CentralReviewItem[];
  entries: ContextEntry[];
  omissions: Array<{
    reference: string;
    reason:
      'not-applicable' | 'expired' | 'disabled' | 'exception' | 'unsupported-scope' | 'budget';
    targets: Target[];
  }>;
  precedence: Array<{
    personalId: string;
    collectiveIds: string[];
    target: Target;
    retained: 'sources-and-counter-evidence';
  }>;
  required: Array<{ kind: 'policy'; reference: string; available: boolean; reason: string }>;
  bytes: number;
  validUntil: string | null;
};
const reference = (item: Pick<CentralReviewItem, 'component' | 'kind' | 'id'>) =>
  `central:${item.component}:${item.kind}:${item.id}`;
const key = (target: Target) => `${target.side}:${target.path}`;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function matches(
  scope: AppliesTo,
  file: { source: SourceFile; text: string },
  branch: string | null,
  semanticContracts: boolean,
) {
  if (scope.branches.length && (!branch || !compilePathPatterns(scope.branches)(branch)))
    return false;
  return (
    (!scope.filePaths.length || compilePathPatterns(scope.filePaths)(file.source.path)) &&
    (!scope.languages.length ||
      scope.languages.some(
        (language) => language.toLowerCase() === sourceLanguage(file.source.path),
      )) &&
    (!scope.symbols.length || scope.symbols.some((symbol) => file.text.includes(symbol))) &&
    (semanticContracts ||
      !scope.contracts.length ||
      scope.contracts.some((contract) => file.text.includes(contract)))
  );
}
/** Contract descriptions are semantic conditions supplied to the reviewer, not literal code needles.
 * Deterministic grouping follows applicability. Scope symbols are lexical candidates, never proof of a current defect. */
type SelectionInput = {
  selected: Array<{ source: SourceFile; text: string }>;
  branch: string | null;
  now: string;
  semanticContracts?: boolean;
  byteLimit: number;
  referenceOnly?: boolean | undefined;
  /** Provenance is part of the admitted item and must count toward its byte budget. */
  source?: Omit<NonNullable<CentralReviewItem['source']>, 'originalId'> | undefined;
};
export function selectCentralKnowledge(
  input: SelectionInput & {
    bundles: Record<'policy' | 'collective' | 'personal', CentralKnowledgeBundle>;
  },
): CentralSelection {
  const personal = centralKnowledgeBundle(input.bundles.personal);
  if (personal.component !== 'personal') throw Error('central-precedence-contract-required');
  return selectKnowledge({
    ...input,
    semanticContracts: true,
    bundles: { ...input.bundles, personal },
  });
}
/** Public PR analyses never read or construct a personal projection. */
export function selectSharedKnowledge(
  input: SelectionInput & {
    bundles: Record<'policy' | 'collective', CentralKnowledgeBundle>;
  },
): CentralSelection {
  return selectKnowledge({
    ...input,
    bundles: { policy: input.bundles.policy, collective: input.bundles.collective },
  });
}
function selectKnowledge(
  input: SelectionInput & {
    bundles: Record<'policy' | 'collective', CentralKnowledgeBundle> & {
      personal?: CentralKnowledgeBundle;
    };
  },
): CentralSelection {
  const policy = centralKnowledgeBundle(input.bundles.policy),
    collective = centralKnowledgeBundle(input.bundles.collective),
    personal = input.bundles.personal ? centralKnowledgeBundle(input.bundles.personal) : undefined;
  if (
    policy.component !== 'policy' ||
    collective.component !== 'collective' ||
    (personal && personal.component !== 'personal') ||
    [policy, collective, ...(personal ? [personal] : [])].some((b) => b.schemaVersion !== 2)
  )
    throw Error('central-precedence-contract-required');
  if (
    !Number.isSafeInteger(input.byteLimit) ||
    input.byteLimit < 0 ||
    input.byteLimit > 1_048_576 ||
    !Number.isFinite(Date.parse(input.now)) ||
    new Date(input.now).toISOString() !== input.now
  )
    throw Error('invalid-central-selection');
  if (
    [collective, ...(personal ? [personal] : [])].some(
      (b) => b.tenantId !== policy.tenantId || b.repositoryId !== policy.repositoryId,
    )
  )
    throw Error('central-scope-mismatch');
  const result: CentralSelection = {
    items: [],
    entries: [],
    omissions: [],
    precedence: [],
    required: [],
    bytes: 0,
    validUntil: null,
  };
  const boundaries: string[] = [];
  const targets = input.selected.map(({ source }) => ({
    path: source.path,
    side: source.side,
    hash: source.hash,
  }));
  const candidates: CentralReviewItem[] = [];
  const requiredFailures = new Set<string>();
  const applicability = (scope: AppliesTo) =>
    input.selected
      .filter((file) => matches(scope, file, input.branch, input.semanticContracts ?? false))
      .map(({ source }) => ({ path: source.path, side: source.side, hash: source.hash }));
  for (const skill of policy.skills.skills) {
    const item: CentralReviewItem = {
      component: 'policy',
      kind: 'skill',
      id: skill.name,
      revision: skill.version,
      hash: skill.contentHash,
      targets,
      required: !input.referenceOnly,
      role: input.referenceOnly ? 'supplement' : 'authoritative',
      value: skill,
    };
    if (skill.enabled) candidates.push(item);
    else result.omissions.push({ reference: reference(item), reason: 'disabled', targets });
  }
  for (const criterion of policy.criteria) {
    if (input.referenceOnly) continue;
    const item: CentralReviewItem = {
      component: 'policy',
      kind: 'policy',
      id: criterion.id,
      revision: criterion.revision,
      hash: criterion.contentHash,
      targets: [],
      required: true,
      role: 'authoritative',
      value: criterion,
    };
    try {
      item.targets = applicability(criterion.document.appliesTo);
      if (!item.targets.length) {
        result.omissions.push({
          reference: reference(item),
          reason: 'not-applicable',
          targets: [],
        });
        continue;
      }
      for (const exception of criterion.exceptions) {
        const affected = applicability(exception.appliesTo);
        if (!affected.some((t) => item.targets.some((c) => key(c) === key(t)))) continue;
        if (exception.startsAt > input.now) boundaries.push(exception.startsAt);
        else if (exception.expiresAt > input.now) {
          boundaries.push(exception.expiresAt);
          const excluded = item.targets.filter((t) => affected.some((a) => key(a) === key(t)));
          item.targets = item.targets.filter((t) => !affected.some((a) => key(a) === key(t)));
          result.omissions.push({
            reference: `${reference(item)}:exception:${exception.id}`,
            reason: 'exception',
            targets: excluded,
          });
        }
      }
      if (item.targets.length) candidates.push(item);
    } catch {
      requiredFailures.add(reference(item));
      result.omissions.push({
        reference: reference(item),
        reason: 'unsupported-scope',
        targets: [],
      });
    }
  }
  const relevant: Array<{
    component: 'collective' | 'personal';
    memory: Memory;
    targets: Target[];
  }> = [];
  const seen = new Set<string>();
  for (const bundle of [collective, ...(personal ? [personal] : [])])
    for (const memory of bundle.memories) {
      if (seen.has(memory.id)) throw Error('duplicate-central-memory');
      seen.add(memory.id);
      const ref = reference({ component: bundle.component, kind: 'memory', id: memory.id });
      if (memory.content.expiresAt && memory.content.expiresAt <= input.now) {
        result.omissions.push({ reference: ref, reason: 'expired', targets: [] });
        continue;
      }
      try {
        const applicable = applicability(memory.content.appliesTo);
        if (!applicable.length) {
          result.omissions.push({ reference: ref, reason: 'not-applicable', targets: [] });
          continue;
        }
        relevant.push({ component: bundle.component, memory, targets: applicable });
      } catch {
        result.omissions.push({ reference: ref, reason: 'unsupported-scope', targets: [] });
      }
    }
  const shared = relevant.filter((item) => item.component === 'collective');
  for (const item of relevant) {
    let selected = item.targets;
    const supplements: Array<{
      target: Target;
      collectiveIds: string[];
      sources: Memory['sources'];
      counterEvidence: string[];
    }> = [];
    if (item.component === 'personal') {
      selected = [];
      for (const target of item.targets) {
        const overrides = shared
          .filter(
            (other) =>
              other.memory.aggregationKey === item.memory.aggregationKey &&
              other.targets.some((t) => key(t) === key(target)),
          )
          .map((other) => other.memory.id)
          .sort(compare);
        if (!overrides.length) selected.push(target);
        else {
          result.precedence.push({
            personalId: item.memory.id,
            collectiveIds: overrides,
            target,
            retained: 'sources-and-counter-evidence',
          });
          supplements.push({
            target,
            collectiveIds: overrides,
            sources: item.memory.sources,
            counterEvidence: item.memory.content.counterEvidence,
          });
        }
      }
    }
    candidates.push({
      component: item.component,
      kind: 'memory',
      id: item.memory.id,
      revision: item.memory.revision,
      hash: item.memory.contentHash,
      targets: selected,
      required: false,
      role:
        !input.referenceOnly && item.component === 'collective' ? 'authoritative' : 'supplement',
      value: {
        ...(selected.length ? { memory: item.memory } : {}),
        ...(supplements.length ? { supplements } : {}),
      },
    });
  }
  candidates.sort(
    (a, b) =>
      Number(b.required) - Number(a.required) ||
      compare(a.component, b.component) ||
      compare(a.kind, b.kind) ||
      compare(a.id, b.id),
  );
  const selectedIds = new Set<string>();
  for (const candidate of candidates) {
    const item: CentralReviewItem = input.source
      ? { ...candidate, source: { ...input.source, originalId: candidate.id } }
      : candidate;
    const size = Buffer.byteLength(canonicalKnowledgeJson(item));
    if (result.bytes + size > input.byteLimit) {
      result.omissions.push({
        reference: reference(item),
        reason: 'budget',
        targets: item.targets,
      });
      if (item.required) requiredFailures.add(reference(item));
      continue;
    }
    // A personal supplement cannot stand in for a collective decision omitted by budget.
    if (
      item.component === 'personal' &&
      result.precedence.some(
        (p) => p.personalId === item.id && p.collectiveIds.some((id) => !selectedIds.has(id)),
      )
    ) {
      result.omissions.push({
        reference: reference(item),
        reason: 'budget',
        targets: item.targets,
      });
      continue;
    }
    result.items.push(item);
    result.bytes += size;
    selectedIds.add(item.id);
    result.entries.push({
      origin: 'central',
      kind: item.kind,
      id: item.id,
      revision: item.revision,
      hash: item.hash,
      component: item.component,
    });
    const memory = relevant.find((m) => m.memory.id === item.id)?.memory;
    if (memory?.content.expiresAt) boundaries.push(memory.content.expiresAt);
  }
  for (const item of candidates.filter((item) => item.required))
    result.required.push({
      kind: 'policy',
      reference: reference(item),
      available: !requiredFailures.has(reference(item)),
      reason: requiredFailures.has(reference(item))
        ? 'Required central instructions exceed the context budget.'
        : '',
    });
  for (const ref of requiredFailures)
    if (!result.required.some((item) => item.reference === ref))
      result.required.push({
        kind: 'policy',
        reference: ref,
        available: false,
        reason: 'Required central scope could not be interpreted.',
      });
  result.omissions.sort((a, b) => compare(a.reference, b.reference));
  result.precedence.sort(
    (a, b) => compare(a.personalId, b.personalId) || compare(key(a.target), key(b.target)),
  );
  result.validUntil = boundaries.sort()[0] ?? null;
  return result;
}
