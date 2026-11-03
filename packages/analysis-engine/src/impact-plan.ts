import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AnalysisFile } from './index.js';
import { buildReviewWindows, formatReviewWindow, type ReviewWindow } from './review-windows.js';

export type ImpactEdge = {
  id: string;
  from: string;
  to: string;
  kind: 'import' | 'sql-table' | 'path-reference';
  evidence: string;
  symbols?: string[];
};
export type ReviewTarget = {
  id: string;
  fileId: string;
  path: string;
  window?: ReviewWindow;
  metadata?: {
    status: string;
    previousPath: string | null;
    additions: number | null;
    deletions: number | null;
  };
};
export type ImpactTask = {
  id: string;
  kind: 'group' | 'boundary';
  targets: ReviewTarget[];
  edges: ImpactEdge[];
  body: string;
  inputHash: string;
  blocked: boolean;
};
export type ImpactPlan = {
  version: 1;
  hash: string;
  files: Array<{
    id: string;
    path: string;
    disposition: 'required' | 'excluded';
    reason: string | null;
    tasks: string[];
  }>;
  edges: ImpactEdge[];
  tasks: ImpactTask[];
  maxInputBytes: number;
};
export const contentHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Static hints are used to select context, never as proof that a dependency executes. */
export function buildImpactEdges(files: AnalysisFile[]): ImpactEdge[] {
  const byPath = new Map(files.map((file) => [file.path, file.id]));
  const modules = new Map<string, string[]>();
  for (const file of files) {
    const name = file.path
      .replace(/\.(py|tsx?|jsx?|[mc]ts)$/, '')
      .replace(/\/(__init__|index)$/, '');
    for (const alias of [name, name.replaceAll('/', '.')]) {
      const list = modules.get(alias) ?? [];
      if (!list.includes(file.id)) list.push(file.id);
      modules.set(alias, list);
    }
  }
  const edges = new Map<string, ImpactEdge>();
  const add = (
    from: string,
    to: string,
    kind: ImpactEdge['kind'],
    evidence: string,
    symbols?: string[],
  ) => {
    if (from === to) return;
    const pair = [from, to].sort();
    const id = contentHash([pair, kind, evidence, symbols]);
    edges.set(id, { id, from, to, kind, evidence, ...(symbols?.length ? { symbols } : {}) });
  };
  const tables = new Map<string, { definitions: string[]; users: string[] }>();
  for (const file of files) {
    // Include both revisions: removing an import or a schema is still an impact edge.
    const source = file.patch
      .split('\n')
      .filter((line) => /^[ +-]/.test(line) && !/^(---|\+\+\+)/.test(line))
      .map((line) => line.slice(1))
      .join('\n');
    const imports = [...source.matchAll(/\b(?:from|import)\s+['"]?([.\w/-]+)/g)];
    for (const match of imports) {
      const name = match[1]!;
      const tail = source.slice((match.index ?? 0) + match[0].length).split('\n', 1)[0]!;
      const symbols =
        /^from\b/.test(match[0]) && file.path.endsWith('.py')
          ? /\s+import\s+([\w, ]+)/
              .exec(tail)?.[1]
              ?.split(',')
              .map((value) => value.trim().split(/\s+as\s+/)[0]!)
              .filter(Boolean)
          : undefined;
      const dots = file.path.endsWith('.py') ? /^(\.+)(.*)$/.exec(name) : null;
      const relative = dots
        ? path.posix.join(
            path.posix.dirname(file.path),
            ...Array(dots[1]!.length - 1).fill('..'),
            dots[2]!.replaceAll('.', '/'),
          )
        : name.startsWith('.')
          ? path.posix
              .normalize(path.posix.join(path.posix.dirname(file.path), name))
              .replace(/\.(py|tsx?|jsx?)$/, '')
          : name;
      const exact =
        modules.get(relative) ?? modules.get(name) ?? modules.get(name.replaceAll('.', '/'));
      if (exact?.length === 1) add(file.id, exact[0]!, 'import', name, symbols);
      else {
        const suffix = '/' + name.replaceAll('.', '/');
        const matches = files.filter((candidate) =>
          candidate.path
            .replace(/\.py$/, '')
            .replace(/\/__init__$/, '')
            .endsWith(suffix),
        );
        if (matches.length === 1) add(file.id, matches[0]!.id, 'import', name, symbols);
      }
    }
    for (const match of source.matchAll(/['"]([^'"\n]+\.(?:sql|py|ya?ml|json))['"]/g)) {
      const reference = match[1]!;
      const id =
        byPath.get(reference) ??
        byPath.get(path.posix.normalize(path.posix.join(path.posix.dirname(file.path), reference)));
      if (id) add(file.id, id, 'path-reference', reference);
    }
    // Only SQL files or quoted SQL statements participate. Python `from ... import`
    // and unrelated prose are not table references.
    const sql = file.path.endsWith('.sql')
      ? source
      : [...source.matchAll(/(?:"""([\s\S]*?)"""|'''([\s\S]*?)'''|"([^"\n]*)"|'([^'\n]*)')/g)]
          .map((match) => match.slice(1).find((value) => value !== undefined) ?? '')
          .filter((value) =>
            /\b(select|insert\s+into|create\s+table|update|delete\s+from)\b/i.test(value),
          )
          .join('\n');
    for (const match of sql.matchAll(
      /\b(create\s+table|alter\s+table|insert\s+into|update|join|from|delete\s+from)\s+(?:if\s+not\s+exists\s+)?["`]?([a-z_][\w.]*)(?:["`])?/gi,
    )) {
      const name = match[2]!.toLowerCase(),
        entry = tables.get(name) ?? { definitions: [], users: [] };
      const list = /^(create|alter)/i.test(match[1]!) ? entry.definitions : entry.users;
      if (!list.includes(file.id)) list.push(file.id);
      tables.set(name, entry);
    }
  }
  for (const [name, entry] of tables) {
    const owners = entry.definitions.length ? entry.definitions : entry.users.slice(0, 1);
    for (const owner of owners)
      for (const user of [...entry.users, ...entry.definitions])
        add(owner, user, 'sql-table', name);
  }
  return [...edges.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function targetText(target: ReviewTarget) {
  return {
    targetId: target.id,
    file: target.path,
    ...(target.window
      ? { code: formatReviewWindow(target.window) }
      : {
          metadata: target.metadata,
          instruction:
            'Review this metadata-only change. There are no changed source lines. Do not invent code or line-level findings.',
        }),
  };
}
const taskBody = (targets: ReviewTarget[], edges: ImpactEdge[], kind: ImpactTask['kind']) =>
  JSON.stringify({
    kind,
    relationNotice:
      'Static relationships are context-selection hints, not runtime proof. Independently packed targets do not imply a dependency.',
    relations: edges,
    targets: targets.map(targetText),
  });

export function buildImpactPlan(input: {
  files: AnalysisFile[];
  eligibleIds: Set<string>;
  exclusionReasons?: Map<string, string>;
  identity: unknown;
  maxInputBytes?: number;
  maxFilesPerGroup?: number;
}): ImpactPlan {
  const maxInputBytes = input.maxInputBytes ?? 64_000,
    maxFiles = input.maxFilesPerGroup ?? 20;
  if (
    !Number.isInteger(maxInputBytes) ||
    maxInputBytes < 2048 ||
    !Number.isInteger(maxFiles) ||
    maxFiles < 2
  )
    throw Error('Invalid impact plan bounds');
  if (
    new Set(input.files.map((file) => file.id)).size !== input.files.length ||
    new Set(input.files.map((file) => file.path)).size !== input.files.length
  )
    throw Error('Duplicate file in review manifest');
  const eligible = input.files.filter((file) => input.eligibleIds.has(file.id));
  const edges = buildImpactEdges(eligible);
  const byId = new Map(eligible.map((file) => [file.id, file]));
  const neighbors = new Map<string, Set<string>>();
  for (const edge of edges)
    for (const [a, b] of [
      [edge.from, edge.to],
      [edge.to, edge.from],
    ]) {
      const values = neighbors.get(a!) ?? new Set<string>();
      values.add(b!);
      neighbors.set(a!, values);
    }
  const ordered: AnalysisFile[] = [],
    visited = new Set<string>();
  for (const file of [...eligible].sort((a, b) => a.path.localeCompare(b.path))) {
    if (visited.has(file.id)) continue;
    const queue = [file.id];
    visited.add(file.id);
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!;
      ordered.push(byId.get(id)!);
      for (const next of [...(neighbors.get(id) ?? [])].sort())
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
    }
  }
  const targets: ReviewTarget[] = [];
  for (const file of ordered) {
    let windows: ReviewWindow[] = [];
    for (const coreLines of [320, 160, 80, 16, 1]) {
      windows = buildReviewWindows(file, { coreLines, overlapLines: Math.min(12, coreLines - 1) });
      if (
        windows.every(
          (window) =>
            Buffer.byteLength(
              JSON.stringify(
                targetText({ id: window.id, fileId: file.id, path: file.path, window }),
              ),
            ) <
            maxInputBytes / 3,
        )
      )
        break;
    }
    if (windows.length)
      targets.push(
        ...windows.map((window) => ({ id: window.id, fileId: file.id, path: file.path, window })),
      );
    else
      targets.push({
        id: contentHash(['metadata', file.id, file.status, file.previousPath, file.patch]),
        fileId: file.id,
        path: file.path,
        metadata: {
          status: file.status,
          previousPath: file.previousPath,
          additions: file.additions,
          deletions: file.deletions,
        },
      });
  }
  const tasks: ImpactTask[] = [];
  const append = (members: ReviewTarget[], taskEdges: ImpactEdge[], kind: ImpactTask['kind']) => {
    const body = taskBody(members, taskEdges, kind),
      hash = contentHash([input.identity, kind, body]);
    tasks.push({
      id: hash,
      kind,
      targets: members,
      edges: taskEdges,
      body,
      inputHash: hash,
      blocked: Buffer.byteLength(body) > maxInputBytes,
    });
  };
  let members: ReviewTarget[] = [];
  for (const target of targets) {
    const next = [...members, target],
      ids = new Set(next.map((member) => member.fileId));
    const relations = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    if (
      members.length &&
      (ids.size > maxFiles || Buffer.byteLength(taskBody(next, relations, 'group')) > maxInputBytes)
    ) {
      const current = new Set(members.map((member) => member.fileId));
      append(
        members,
        edges.filter((edge) => current.has(edge.from) && current.has(edge.to)),
        'group',
      );
      members = [];
    }
    members.push(target);
  }
  if (members.length) {
    const ids = new Set(members.map((member) => member.fileId));
    append(
      members,
      edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
      'group',
    );
  }
  // Keep cross-partition obligations explicit. Coalesce edges for the same pair;
  // split oversized endpoint context into bounded window pairs without dropping it.
  const relationTargets = (fileId: string, relations: ImpactEdge[]) => {
    const all = targets.filter((target) => target.fileId === fileId);
    // Primary tasks still cover the entire file. Boundary tasks focus on the
    // referenced contract/table and every matching changed window; unresolved
    // symbols conservatively retain the complete endpoint.
    const hints = relations.flatMap((edge) =>
      edge.symbols?.length ? edge.symbols : [edge.evidence],
    );
    const matched = all.filter(
      (target) =>
        target.window &&
        hints.some((hint) =>
          [...target.window!.lines, ...target.window!.comparison.lines].some((line) =>
            line.text.includes(hint),
          ),
        ),
    );
    return matched.length ? matched : all;
  };
  const covered = new Set(
    edges
      .filter((edge) => {
        const required = [
          ...relationTargets(edge.from, [edge]),
          ...relationTargets(edge.to, [edge]),
        ];
        return tasks.some((task) =>
          required.every((target) => task.targets.some((member) => member.id === target.id)),
        );
      })
      .map((edge) => edge.id),
  );
  const boundaryPairs = new Map<string, ImpactEdge[]>();
  for (const edge of edges.filter((edge) => !covered.has(edge.id))) {
    const key = [edge.from, edge.to].sort().join(':');
    const values = boundaryPairs.get(key) ?? [];
    values.push(edge);
    boundaryPairs.set(key, values);
  }
  let boundaryTargets: ReviewTarget[] = [],
    boundaryEdges: ImpactEdge[] = [];
  const addBoundary = (targets: ReviewTarget[], edges: ImpactEdge[]) => {
    const joined = [
      ...new Map([...boundaryTargets, ...targets].map((target) => [target.id, target])).values(),
    ];
    const relations = [
      ...new Map([...boundaryEdges, ...edges].map((edge) => [edge.id, edge])).values(),
    ];
    if (
      boundaryTargets.length &&
      (new Set(joined.map((target) => target.fileId)).size > maxFiles ||
        Buffer.byteLength(taskBody(joined, relations, 'boundary')) > maxInputBytes)
    ) {
      append(boundaryTargets, boundaryEdges, 'boundary');
      boundaryTargets = [];
      boundaryEdges = [];
    }
    boundaryTargets = [
      ...new Map([...boundaryTargets, ...targets].map((target) => [target.id, target])).values(),
    ];
    boundaryEdges = [
      ...new Map([...boundaryEdges, ...edges].map((edge) => [edge.id, edge])).values(),
    ];
  };
  const anchor = (edge: ImpactEdge) =>
    (neighbors.get(edge.from)?.size ?? 0) >= (neighbors.get(edge.to)?.size ?? 0)
      ? edge.from
      : edge.to;
  for (const allEdges of [...boundaryPairs.values()].sort((a, b) =>
    anchor(a[0]!).localeCompare(anchor(b[0]!)),
  )) {
    for (let offset = 0; offset < allEdges.length; offset += 8) {
      const taskEdges = allEdges.slice(offset, offset + 8),
        edge = taskEdges[0]!;
      const left = relationTargets(edge.from, taskEdges),
        right = relationTargets(edge.to, taskEdges);
      if (Buffer.byteLength(taskBody([...left, ...right], taskEdges, 'boundary')) <= maxInputBytes)
        addBoundary([...left, ...right], taskEdges);
      else for (const a of left) for (const b of right) addBoundary([a, b], taskEdges);
    }
  }
  if (boundaryTargets.length) append(boundaryTargets, boundaryEdges, 'boundary');
  const files = input.files.map((file) => ({
    id: file.id,
    path: file.path,
    disposition: input.eligibleIds.has(file.id) ? ('required' as const) : ('excluded' as const),
    reason: input.eligibleIds.has(file.id)
      ? null
      : (input.exclusionReasons?.get(file.id) ?? 'Existing exclusion policy'),
    tasks: tasks
      .filter((task) => task.targets.some((target) => target.fileId === file.id))
      .map((task) => task.id),
  }));
  return {
    version: 1,
    hash: contentHash([input.identity, files, tasks.map((task) => task.inputHash)]),
    files,
    edges,
    tasks,
    maxInputBytes,
  };
}

/** Persist references and hashes, not another copy of source code in PostgreSQL. */
export function describeImpactPlan(plan: ImpactPlan) {
  return {
    version: plan.version,
    hash: plan.hash,
    files: plan.files,
    edges: plan.edges,
    maxInputBytes: plan.maxInputBytes,
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      kind: task.kind,
      inputHash: task.inputHash,
      blocked: task.blocked,
      targets: task.targets.map((target) => ({
        id: target.id,
        fileId: target.fileId,
        path: target.path,
      })),
      edges: task.edges.map((edge) => edge.id),
      inputBytes: Buffer.byteLength(task.body),
    })),
  };
}
