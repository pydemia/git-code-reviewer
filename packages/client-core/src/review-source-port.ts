import {
  sourcePath,
  type FixedSourceToolName,
  type FixedSourceToolPort,
  type SourceReadReceipt,
} from '@gcr/client-contract';
import { contentHash } from './local-identity.js';
import {
  ReviewPolicyError,
  type LocalExecutionPolicy,
  type ReviewRunBudget,
} from './review-policy.js';
import type { LocalSourceSnapshot } from './source-snapshot.js';

/** The model sees serialized, authorized snapshot data, never a mutable filesystem path. */
export class LocalReviewSourcePort implements FixedSourceToolPort {
  #receipts: SourceReadReceipt[] = [];
  constructor(
    private readonly snapshot: LocalSourceSnapshot,
    private readonly policy: LocalExecutionPolicy,
    private readonly budget: ReviewRunBudget,
  ) {
    const identity = policy.identity;
    const repository = snapshot.repository;
    if (
      identity.source.hash !== snapshot.identity.hash ||
      identity.client.repositoryKey !== repository.repositoryKey ||
      identity.client.worktreeKey !== repository.worktreeKey ||
      contentHash(budget.limits) !== contentHash(policy.budgets)
    )
      throw new ReviewPolicyError('policy-unavailable');
  }
  get receipts(): SourceReadReceipt[] {
    return structuredClone(this.#receipts);
  }
  async execute(name: FixedSourceToolName, argumentsValue: unknown): Promise<string> {
    this.policy.requireTool(name);
    this.budget.consumeTool();
    if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue))
      throw new ReviewPolicyError('policy-unavailable');
    const args = structuredClone(argumentsValue) as Record<string, unknown>;
    const allowed =
      name === 'list_files'
        ? ['offset', 'limit']
        : name === 'read_file'
          ? ['path', 'side', 'startLine', 'endLine']
          : ['query', 'side'];
    if (Object.keys(args).some((key) => !allowed.includes(key)))
      throw new ReviewPolicyError('policy-unavailable');
    let response: unknown;
    if (name === 'list_files') {
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 100;
      if (
        typeof offset !== 'number' ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > 10_000 ||
        typeof limit !== 'number' ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw new ReviewPolicyError('policy-unavailable');
      const files = this.policy.sources;
      response = {
        files: files.slice(offset, offset + limit),
        total: files.length,
        nextOffset: offset + limit < files.length ? offset + limit : null,
        scope: 'authorized-fixed-source-only',
      };
    } else {
      const side = args.side ?? 'source';
      if (side !== 'source' && side !== 'base') throw new ReviewPolicyError('policy-unavailable');
      if (name === 'read_file') {
        const file = sourcePath(args.path);
        const descriptor = this.policy.sources.find((s) => s.side === side && s.path === file);
        if (!descriptor) throw new ReviewPolicyError('policy-unavailable');
        const start = args.startLine ?? 1;
        const end = args.endLine ?? (typeof start === 'number' ? start + 159 : 0);
        if (typeof start !== 'number' || typeof end !== 'number')
          throw new ReviewPolicyError('policy-unavailable');
        const result = this.snapshot.readLines(file, side, start, end);
        if (result.status !== 'available' || !this.policy.allowSource(result.source))
          throw new ReviewPolicyError('policy-unavailable');
        response = result;
      } else {
        if (typeof args.query !== 'string' || !args.query || args.query.length > 300)
          throw new ReviewPolicyError('policy-unavailable');
        const matches: Array<{
          path: string;
          side: 'source' | 'base';
          contentHash: string;
          line: number;
          text: string;
          textTruncated: boolean;
        }> = [];
        let truncated = false;
        outer: for (const file of this.policy.sources.filter((s) => s.side === side)) {
          this.budget.assertActive();
          const result = this.snapshot.readFile(file.path, side);
          if (result.status !== 'available' || !this.policy.allowSource(result.source))
            throw new ReviewPolicyError('policy-unavailable');
          for (const [line, text] of result.text.split('\n').entries()) {
            if (!text.includes(args.query)) continue;
            if (matches.length === 100) {
              truncated = true;
              break outer;
            }
            matches.push({
              path: file.path,
              side,
              contentHash: file.hash,
              line: line + 1,
              text: text.slice(0, 300),
              textTruncated: text.length > 300,
            });
          }
        }
        response = {
          matches,
          truncated,
          scope: 'authorized-fixed-source-only',
          method: 'literal-text',
          verifiedCallGraph: false,
        };
      }
    }
    const text = JSON.stringify(response);
    const bytes = Buffer.byteLength(text);
    this.budget.consumeSource(bytes);
    this.#receipts.push({
      sequence: this.#receipts.length + 1,
      tool: name,
      argumentsHash: contentHash(args),
      responseHash: contentHash(text),
      responseBytes: bytes,
    });
    return text;
  }
}
