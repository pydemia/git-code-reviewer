import { performance } from 'node:perf_hooks';
import {
  clientIdentity,
  executionIdentity,
  sourceFile,
  type ClientIdentity,
  type ExecutionIdentity,
  type SourceFile,
} from '@gcr/client-contract';
import { builtinReviewSkill } from './builtin-review.js';
import { canonicalJson, contentHash } from './local-identity.js';
import { compilePathPatterns } from './source-policy.js';
import type { LocalSourceSnapshot } from './source-snapshot.js';
import type { LocalContextResolution } from './review-context.js';
import type { ReviewProblem } from './review-mode.js';

export interface LocalExecutorDescriptor {
  id: string;
  version: string;
  model: string;
  configHash: string;
  capabilities: {
    available: boolean;
    sourceIsolation: 'fixed-source-only' | 'unrestricted' | 'unknown';
    cancellation: boolean;
    timeout: boolean;
    childProcessCleanup: boolean;
    outputTokenLimit: boolean;
  };
}
/** Trusted application input from the user's local profile or explicit invocation.
 * Repository settings, Skill bodies and remote material cannot issue this approval. */
export interface ApprovedLocalScope {
  client: ClientIdentity;
  executor: Pick<LocalExecutorDescriptor, 'id' | 'model' | 'configHash'>;
  sourceHash?: string;
  paths: readonly string[];
  allowRelated: boolean;
  allowBase: boolean;
  allowKnowledge: boolean;
}
export interface ReviewBudgetOptions {
  modelCalls?: number;
  durationMs?: number;
  sourceBytes?: number;
  toolCalls?: number;
  outputTokensPerCall?: number;
}
export interface ReviewBudgetLimits {
  modelCalls: number;
  durationMs: number;
  sourceBytes: number;
  toolCalls: number;
  outputTokensPerCall?: number;
}
export class ReviewPolicyError extends Error {
  constructor(readonly code: 'policy-unavailable' | 'quota-exceeded' | 'timeout') {
    super(code);
    this.name = 'ReviewPolicyError';
  }
}
const integer = (value: number | undefined, fallback: number, maximum: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new ReviewPolicyError('policy-unavailable');
  return value;
};
export function reviewBudgetLimits(input: ReviewBudgetOptions = {}): ReviewBudgetLimits {
  if (
    !input ||
    typeof input !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Object.keys(input).some(
      (key) =>
        !['modelCalls', 'durationMs', 'sourceBytes', 'toolCalls', 'outputTokensPerCall'].includes(
          key,
        ),
    )
  )
    throw new ReviewPolicyError('policy-unavailable');
  return {
    modelCalls: integer(input.modelCalls, 2, 10),
    durationMs: integer(input.durationMs, 120_000, 600_000),
    sourceBytes: integer(input.sourceBytes, 1_048_576, 33_554_432),
    toolCalls: integer(input.toolCalls, 100, 1000),
    ...(input.outputTokensPerCall === undefined
      ? {}
      : { outputTokensPerCall: integer(input.outputTokensPerCall, 1, 32_768) }),
  };
}

/** Synchronous per-run admission. Failed attempts consume reservations; no silent retries.
 * This is not the cross-process/project scheduler or persistent quota ledger from P07. */
export class ReviewRunBudget {
  #limits: ReviewBudgetLimits;
  #start: number;
  #last: number;
  #used = { modelCalls: 0, sourceBytes: 0, toolCalls: 0 };
  constructor(
    limits: ReviewBudgetLimits,
    private readonly clock: () => number = () => performance.now(),
  ) {
    this.#limits = reviewBudgetLimits(limits);
    this.#start = this.#last = clock();
    if (!Number.isFinite(this.#start)) throw new ReviewPolicyError('policy-unavailable');
  }
  assertActive(): void {
    const now = this.clock();
    if (!Number.isFinite(now) || now < this.#last)
      throw new ReviewPolicyError('policy-unavailable');
    this.#last = now;
    if (now - this.#start >= this.#limits.durationMs) throw new ReviewPolicyError('timeout');
  }
  private consume(kind: 'modelCalls' | 'sourceBytes' | 'toolCalls', amount: number): void {
    this.assertActive();
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new ReviewPolicyError('policy-unavailable');
    if (amount > this.#limits[kind] - this.#used[kind])
      throw new ReviewPolicyError('quota-exceeded');
    this.#used[kind] += amount;
  }
  reserveModelCall(): void {
    this.consume('modelCalls', 1);
  }
  consumeSource(bytes: number): void {
    this.consume('sourceBytes', bytes);
  }
  consumeTool(): void {
    this.consume('toolCalls', 1);
  }
  get used() {
    return { ...this.#used };
  }
  get limits(): ReviewBudgetLimits {
    return { ...this.#limits };
  }
}

export const localReviewTools = Object.freeze(['list_files', 'read_file', 'search_code'] as const);
class LocalExecutionPolicy {
  #identity: ExecutionIdentity;
  #sources: Map<string, SourceFile>;
  #budgets: ReviewBudgetLimits;
  constructor(identity: ExecutionIdentity, sources: SourceFile[], budgets: ReviewBudgetLimits) {
    this.#identity = executionIdentity(identity);
    this.#sources = new Map(
      sources.map((source) => [`${source.side}:${source.path}`, structuredClone(source)]),
    );
    this.#budgets = { ...budgets };
  }
  get identity(): ExecutionIdentity {
    return structuredClone(this.#identity);
  }
  get sources(): SourceFile[] {
    return [...this.#sources.values()].map((source) => structuredClone(source));
  }
  get budgets(): ReviewBudgetLimits {
    return { ...this.#budgets };
  }
  get enforcement() {
    return 'advisory' as const;
  }
  get centralRequests() {
    return 'forbidden' as const;
  }
  allowSource(value: SourceFile): boolean {
    try {
      const source = sourceFile(value);
      const allowed = this.#sources.get(`${source.side}:${source.path}`);
      return !!allowed && canonicalJson(allowed) === canonicalJson(source);
    } catch {
      return false;
    }
  }
  requireTool(name: string): void {
    if (!(localReviewTools as readonly string[]).includes(name))
      throw new ReviewPolicyError('policy-unavailable');
  }
  createRunBudget(): ReviewRunBudget {
    return new ReviewRunBudget(this.#budgets);
  }
}
export type { LocalExecutionPolicy };
export interface ResolvePolicyInput {
  context: LocalContextResolution;
  snapshot: LocalSourceSnapshot;
  executor: LocalExecutorDescriptor;
  workspaceTrusted: boolean;
  approval?: ApprovedLocalScope;
  budget?: ReviewBudgetOptions;
  reviewProfile?: ExecutionIdentity['reviewProfile'];
  now?: Date;
}
export type LocalPolicyResolution =
  | { status: 'ready'; problems: ReviewProblem[]; policy: LocalExecutionPolicy }
  | { status: 'needs-context' | 'unavailable'; problems: ReviewProblem[]; policy?: never };

const unavailable = (code: ReviewProblem['code'], message: string): LocalPolicyResolution => ({
  status: 'unavailable',
  problems: [{ code, message }],
});

/** No provider discovery/switching or credential/network operations occur in this gate. */
export function resolveLocalExecutionPolicy(input: ResolvePolicyInput): LocalPolicyResolution {
  if (input.context.status !== 'ready' || !input.context.context)
    return {
      status: input.context.status === 'unavailable' ? 'unavailable' : 'needs-context',
      problems: input.context.problems.length
        ? structuredClone(input.context.problems)
        : [{ code: 'missing-context', message: 'Review context is not ready.' }],
    };
  try {
    const context = input.context.context;
    const snapshot = input.snapshot.identity;
    const repository = input.snapshot.repository;
    if (
      repository.repositoryKey !== context.client.repositoryKey ||
      repository.worktreeKey !== context.client.worktreeKey
    )
      return unavailable('source-error', 'Context belongs to another repository or worktree.');
    if (snapshot.hash !== context.sourceHash)
      return unavailable('source-error', 'Context belongs to a different source snapshot.');
    if (input.workspaceTrusted !== true || !input.approval)
      return unavailable(
        'policy-unavailable',
        'Local source review requires a trusted workspace and an approved executor/source scope.',
      );
    const approval = structuredClone(input.approval);
    const client = clientIdentity(context.client);
    if (
      canonicalJson(clientIdentity(approval.client)) !== canonicalJson(client) ||
      (approval.sourceHash !== undefined && approval.sourceHash !== snapshot.hash)
    )
      return unavailable(
        'policy-unavailable',
        'Source approval belongs to another client or snapshot.',
      );
    const executor = structuredClone(input.executor);
    if (
      approval.executor.id !== executor.id ||
      approval.executor.model !== executor.model ||
      approval.executor.configHash !== executor.configHash
    )
      return unavailable(
        'policy-unavailable',
        'The selected executor, model or configuration is not approved.',
      );
    const capabilities = executor.capabilities;
    if (
      capabilities.available !== true ||
      capabilities.sourceIsolation !== 'fixed-source-only' ||
      capabilities.cancellation !== true ||
      capabilities.timeout !== true ||
      capabilities.childProcessCleanup !== true
    )
      return unavailable(
        'executor-unavailable',
        'The selected executor cannot enforce the required source isolation, cancellation, timeout and process cleanup.',
      );
    const budgets = reviewBudgetLimits(input.budget);
    if (budgets.outputTokensPerCall !== undefined && capabilities.outputTokenLimit !== true)
      return unavailable(
        'executor-unavailable',
        'The selected executor cannot enforce the requested output-token limit.',
      );
    const now = (input.now ?? new Date()).toISOString();
    if (context.validUntil && context.validUntil <= now)
      return unavailable(
        'missing-context',
        'Selected local knowledge expired before execution. Resolve context again.',
      );
    if (context.knowledge.length && approval.allowKnowledge !== true)
      return unavailable(
        'policy-unavailable',
        'Sending the selected local knowledge to this executor is not approved.',
      );
    const matches = compilePathPatterns(approval.paths);
    const selectedPaths = new Set(
      input.snapshot.selected.flatMap((file) => [
        file.path,
        ...(file.oldPath ? [file.oldPath] : []),
      ]),
    );
    const sources = input.snapshot.sourceFiles.filter(
      (source) =>
        matches(source.path) &&
        (source.side !== 'base' || approval.allowBase === true) &&
        (approval.allowRelated === true || selectedPaths.has(source.path)),
    );
    const required = context.sources.filter((source) => source.available);
    if (
      required.some(
        (source) => !sources.some((file) => source.side === file.side && source.path === file.path),
      )
    )
      return {
        status: 'needs-context',
        problems: [
          {
            code: 'missing-context',
            message: 'Required fixed source is outside the approved transmission scope.',
          },
        ],
      };
    const requiredBytes = sources
      .filter((source) =>
        required.some((item) => item.side === source.side && item.path === source.path),
      )
      .reduce((sum, source) => sum + source.byteLength, 0);
    if (requiredBytes > budgets.sourceBytes)
      return {
        status: 'needs-context',
        problems: [
          {
            code: 'source-truncated',
            message: 'Required fixed source exceeds the execution source-byte budget.',
          },
        ],
      };
    const reviewProfile = input.reviewProfile ?? {
      id: builtinReviewSkill.id,
      revision: builtinReviewSkill.revision,
      hash: builtinReviewSkill.hash,
    };
    const toolsHash = contentHash({ version: 1, tools: localReviewTools, sources, budgets });
    const identity = executionIdentity({
      client,
      source: snapshot,
      context: context.identity,
      reviewProfile,
      executor: {
        id: executor.id,
        version: executor.version,
        model: executor.model,
        configHash: executor.configHash,
      },
      toolsHash,
    });
    return {
      status: 'ready',
      problems: [],
      policy: new LocalExecutionPolicy(identity, sources, budgets),
    };
  } catch {
    return unavailable(
      'policy-unavailable',
      'Local execution settings or source scope could not be validated.',
    );
  }
}
