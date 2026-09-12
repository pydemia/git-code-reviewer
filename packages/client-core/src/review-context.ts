import path from 'node:path';
import {
  clientIdentity,
  contextIdentity,
  localKnowledge,
  sourcePath,
  type ClientIdentity,
  type ContextIdentity,
  type LocalKnowledge,
  type SourceFile,
} from '@gcr/client-contract';
import { builtinReviewSkill } from './builtin-review.js';
import { canonicalJson, contentHash } from './local-identity.js';
import { compilePathPatterns } from './source-policy.js';
import { resolveReviewMode, type ReviewProblem } from './review-mode.js';
import type { LocalSourceSnapshot } from './source-snapshot.js';

export interface KnowledgeReader {
  entries(): AsyncIterable<LocalKnowledge>;
}
export interface RequiredSource {
  path: string;
  side: 'source' | 'base';
}
export interface LocalContextQuery {
  client: ClientIdentity;
  snapshot: LocalSourceSnapshot;
  settings?: { mode?: unknown; [key: string]: unknown };
  stores: readonly KnowledgeReader[];
  /** Branch observations must belong to this captured HEAD, not a later checkout. */
  branch?: { name: string; headCommit: string | null };
  requiredKnowledgeIds?: readonly string[];
  requiredSources?: readonly RequiredSource[];
  knowledgeBytes?: number;
  scanBytes?: number;
  scanItems?: number;
  now?: Date;
}
export interface KnowledgeOmission {
  id: string;
  reason: 'inactive' | 'expired' | 'not-applicable' | 'unsupported-scope' | 'budget';
}
export interface ContextSourceRequirement extends RequiredSource {
  reference: string;
  available: boolean;
  reason: string;
}
interface ContextData {
  client: ClientIdentity;
  sourceHash: string;
  identity: ContextIdentity;
  knowledge: LocalKnowledge[];
  builtin: typeof builtinReviewSkill | null;
  bytes: number;
  omissions: KnowledgeOmission[];
  sources: ContextSourceRequirement[];
  validUntil: string | null;
}
class LocalReviewContext {
  #data: ContextData;
  constructor(data: ContextData) {
    this.#data = structuredClone(data);
  }
  get client(): ClientIdentity {
    return structuredClone(this.#data.client);
  }
  get sourceHash(): string {
    return this.#data.sourceHash;
  }
  get identity(): ContextIdentity {
    return structuredClone(this.#data.identity);
  }
  get knowledge(): LocalKnowledge[] {
    return structuredClone(this.#data.knowledge);
  }
  get builtin(): typeof builtinReviewSkill | null {
    return structuredClone(this.#data.builtin);
  }
  get bytes(): number {
    return this.#data.bytes;
  }
  get omissions(): KnowledgeOmission[] {
    return structuredClone(this.#data.omissions);
  }
  get sources(): ContextSourceRequirement[] {
    return structuredClone(this.#data.sources);
  }
  get validUntil(): string | null {
    return this.#data.validUntil;
  }
}
export type { LocalReviewContext };
export type LocalContextResolution =
  | { status: 'ready' | 'needs-context'; problems: ReviewProblem[]; context: LocalReviewContext }
  | { status: 'unavailable'; problems: ReviewProblem[]; context?: never };

const bounded = (value: number | undefined, fallback: number, maximum: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw Error('invalid-context-budget');
  return value;
};
const languages: Readonly<Record<string, string>> = {
  '.py': 'python',
  '.pyi': 'python',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.sql': 'sql',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.html': 'html',
  '.css': 'css',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.md': 'markdown',
};
export function sourceLanguage(file: string): string | undefined {
  sourcePath(file);
  return languages[path.posix.extname(file).toLowerCase()];
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function inScope(item: LocalKnowledge, client: ClientIdentity): boolean {
  return (
    item.scope.profileId === client.profileId &&
    (item.scope.kind === 'profile' ||
      (item.scope.repositoryKey === client.repositoryKey &&
        item.scope.worktreeKey === client.worktreeKey))
  );
}
function applicable(
  item: LocalKnowledge,
  sources: Array<{ source: SourceFile; text: string }>,
  branch?: string,
): boolean {
  const { paths, languages: requiredLanguages, symbols, branches } = item.appliesTo;
  if (
    [paths, requiredLanguages, symbols, branches].some((values) => values.length > 128) ||
    symbols.some((symbol) => symbol.length > 128)
  )
    throw Error('unsupported-scope');
  const pathMatches = paths.length ? compilePathPatterns(paths) : () => true;
  if (branches.length && (!branch || !compilePathPatterns(branches)(branch))) return false;
  // Every constrained dimension must match the same selected file. Symbol matches
  // are lexical candidates and do not establish semantic binding or correctness.
  return sources.some(
    ({ source, text }) =>
      pathMatches(source.path) &&
      (!requiredLanguages.length ||
        requiredLanguages.includes(sourceLanguage(source.path) ?? '')) &&
      (!symbols.length || symbols.some((symbol) => text.includes(symbol))),
  );
}
function knowledgeReference(id: string): string {
  return `knowledge:${id}`;
}

/** Build only local context. There is deliberately no central/cache/network port. */
export async function resolveLocalContext(
  input: LocalContextQuery,
): Promise<LocalContextResolution> {
  const mode = resolveReviewMode(input.settings);
  if (!mode.supported) return { status: 'unavailable', problems: mode.problems };
  try {
    const client = clientIdentity(input.client);
    if (client.mode !== 'standalone')
      return {
        status: 'unavailable',
        problems: [
          {
            code: 'policy-unavailable',
            message: 'Standalone context requires a local client identity.',
          },
        ],
      };
    const sourceHash = input.snapshot.identity.hash;
    const repository = input.snapshot.repository;
    if (
      repository.repositoryKey !== client.repositoryKey ||
      repository.worktreeKey !== client.worktreeKey
    )
      throw Error('source-scope-mismatch');
    const selected = input.snapshot.selected;
    const branch =
      input.branch === undefined
        ? input.snapshot.branchName === null
          ? undefined
          : { name: input.snapshot.branchName, headCommit: input.snapshot.headCommit }
        : { name: input.branch.name, headCommit: input.branch.headCommit };
    if (
      branch &&
      (branch.headCommit !== input.snapshot.headCommit ||
        branch.name !== input.snapshot.branchName ||
        !branch.name ||
        branch.name.length > 1024)
    )
      throw Error('branch-mismatch');
    if (branch) sourcePath(branch.name);
    const now = (input.now ?? new Date()).toISOString();
    const byteLimit = bounded(input.knowledgeBytes, 65_536, 1_048_576);
    const scanLimit = bounded(input.scanBytes, 16_777_216, 67_108_864);
    const itemLimit = bounded(input.scanItems, 5000, 10_000);
    const requiredIds = [...new Set(Array.from(input.requiredKnowledgeIds ?? []))].sort(compare);
    if (
      requiredIds.length > 1000 ||
      requiredIds.some(
        (id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id),
      )
    )
      throw Error('invalid-required-knowledge');
    const requiredSet = new Set(requiredIds);
    const requestedSources = Array.from(input.requiredSources ?? [], (source) => ({
      path: source.path,
      side: source.side,
    }));
    if (requestedSources.length > 1000) throw Error('invalid-required-source');
    const primary: Array<{ source: SourceFile; text: string }> = [];
    for (const file of selected) {
      requestedSources.push({ path: file.path, side: file.side });
      const read = input.snapshot.readFile(file.path, file.side);
      if (read.status === 'available') primary.push(read);
      const basePath = file.oldPath ?? file.path;
      if (
        file.side === 'source' &&
        input.snapshot.readFile(basePath, 'base').status === 'available'
      )
        requestedSources.push({ path: basePath, side: 'base' });
    }
    const sources: ContextSourceRequirement[] = [];
    for (const request of requestedSources) {
      sourcePath(request.path);
      if (request.side !== 'base' && request.side !== 'source')
        throw Error('invalid-required-source');
      const reference = `source:${contentHash(request)}`;
      if (sources.some((source) => source.reference === reference)) continue;
      const read = input.snapshot.readFile(request.path, request.side);
      sources.push({
        ...request,
        reference,
        available: read.status === 'available',
        reason:
          read.status === 'available'
            ? ''
            : read.status === 'absent'
              ? 'Source is absent from the captured view.'
              : `Source is unavailable: ${read.reason}.`,
      });
    }
    sources.sort((a, b) => compare(a.reference, b.reference));
    const omissions: KnowledgeOmission[] = [];
    const candidates = new Map<string, { item: LocalKnowledge; bytes: number }>();
    const seen = new Set<string>();
    const problems: ReviewProblem[] = [];
    let scannedBytes = 0,
      scanned = 0;
    if (input.stores.length > 2) throw Error('unexpected-knowledge-stores');
    scan: for (const store of [...input.stores])
      for await (const value of store.entries()) {
        if (++scanned > itemLimit) {
          problems.push({
            code: 'context-truncated',
            message: 'Local knowledge scan exceeds its entry budget.',
          });
          break scan;
        }
        const item = localKnowledge(value);
        if (!inScope(item, client) || seen.has(item.id)) throw Error('knowledge-scope-mismatch');
        seen.add(item.id);
        const { hash, ...body } = item;
        if (hash !== contentHash(body)) throw Error('knowledge-hash-mismatch');
        const bytes = Buffer.byteLength(canonicalJson(item));
        scannedBytes += bytes;
        if (scannedBytes > scanLimit) {
          problems.push({
            code: 'context-truncated',
            message: 'Local knowledge scan exceeds its byte budget.',
          });
          break scan;
        }
        let reason: KnowledgeOmission['reason'] | undefined;
        if (item.state !== 'active') reason = 'inactive';
        else if (item.expiresAt && item.expiresAt <= now) reason = 'expired';
        else if (bytes > byteLimit) reason = 'budget';
        else {
          try {
            if (!applicable(item, primary, branch?.name)) reason = 'not-applicable';
          } catch {
            reason = 'unsupported-scope';
          }
        }
        if (reason) {
          omissions.push({ id: item.id, reason });
          continue;
        }
        candidates.set(item.id, { item, bytes });
      }
    const builtinBytes = Buffer.byteLength(canonicalJson(builtinReviewSkill));
    const builtin = builtinBytes <= byteLimit ? builtinReviewSkill : null;
    let bytes = builtin ? builtinBytes : 0;
    const knowledge: LocalKnowledge[] = [];
    const ordered = [...candidates.values()].sort(
      (a, b) =>
        Number(requiredSet.has(b.item.id)) - Number(requiredSet.has(a.item.id)) ||
        Number(b.item.scope.kind === 'repository') - Number(a.item.scope.kind === 'repository') ||
        compare(a.item.id, b.item.id),
    );
    for (const candidate of ordered) {
      if (bytes + candidate.bytes > byteLimit) {
        omissions.push({ id: candidate.item.id, reason: 'budget' });
        continue;
      }
      bytes += candidate.bytes;
      knowledge.push(candidate.item);
    }
    omissions.sort((a, b) => compare(a.id, b.id));
    const required: ContextIdentity['required'] = [
      {
        kind: 'knowledge',
        reference: `builtin:${builtinReviewSkill.id}`,
        available: !!builtin,
        reason: builtin ? '' : 'Required built-in review instructions exceed the context budget.',
      },
      ...sources.map((source) => ({
        kind: 'source' as const,
        reference: source.reference,
        available: source.available,
        reason: source.reason,
      })),
      ...requiredIds.map((id) => ({
        kind: 'knowledge' as const,
        reference: knowledgeReference(id),
        available: knowledge.some((item) => item.id === id),
        reason: knowledge.some((item) => item.id === id)
          ? ''
          : `Required local knowledge is unavailable: ${omissions.find((entry) => entry.id === id)?.reason ?? 'missing'}.`,
      })),
    ];
    if (!selected.length)
      problems.push({
        code: 'missing-context',
        message: 'No reviewable source was selected in the captured view.',
      });
    if (required.some((item) => !item.available))
      problems.push({
        code: 'missing-context',
        message: 'Required review context is unavailable or exceeds the context budget.',
      });
    const entries: ContextIdentity['entries'] = [
      ...(builtin
        ? [
            {
              origin: 'builtin' as const,
              kind: 'skill' as const,
              id: builtin.id,
              revision: builtin.revision,
              hash: builtin.hash,
            },
          ]
        : []),
      ...knowledge.map((item) => ({
        origin: 'local' as const,
        kind: item.kind,
        id: item.id,
        revision: item.revision,
        hash: item.hash,
        scope: item.scope,
      })),
    ];
    const identity = contextIdentity({
      entries,
      required,
      hash: contentHash({
        version: 1,
        client,
        sourceHash,
        branch: branch ?? null,
        entries,
        required,
        omissions,
        scanComplete: !problems.some((item) => item.code === 'context-truncated'),
      }),
    });
    const expiry = knowledge.flatMap((item) => (item.expiresAt ? [item.expiresAt] : [])).sort();
    return {
      status: problems.length ? 'needs-context' : 'ready',
      problems,
      context: new LocalReviewContext({
        client,
        sourceHash,
        identity,
        knowledge,
        builtin,
        bytes,
        omissions,
        sources,
        validUntil: expiry[0] ?? null,
      }),
    };
  } catch {
    // Store/decoder failures can contain private material. No fallback to an empty successful context.
    return {
      status: 'unavailable',
      problems: [
        {
          code: 'missing-context',
          message: 'Local review context could not be validated or loaded.',
        },
      ],
    };
  }
}
