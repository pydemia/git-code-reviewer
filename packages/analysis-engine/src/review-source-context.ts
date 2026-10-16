import { buildImpactEdges } from './impact-plan.js';
import type { AnalysisFile } from './index.js';

const maxContextFiles = 4;
const maxContextBytes = 12_000;

export function createSourceOnlyContext(
  reviewFiles: AnalysisFile[],
  sourceOnlyFiles: AnalysisFile[],
): (body: string, targetFileIds: string[]) => string {
  if (!sourceOnlyFiles.length) return (body) => body;
  const sourceIds = new Set(sourceOnlyFiles.map((file) => file.id));
  const edges = buildImpactEdges([...reviewFiles, ...sourceOnlyFiles]);
  const sourceById = new Map(sourceOnlyFiles.map((file) => [file.id, file]));

  return (body, targetFileIds) => {
    const targets = new Set(targetFileIds);
    const relatedIds = new Set<string>();
    for (const edge of edges) {
      if (targets.has(edge.from) && sourceIds.has(edge.to)) relatedIds.add(edge.to);
      if (targets.has(edge.to) && sourceIds.has(edge.from)) relatedIds.add(edge.from);
    }
    const related = [...relatedIds]
      .map((id) => sourceById.get(id))
      .filter((file): file is AnalysisFile => Boolean(file))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, maxContextFiles);
    if (!related.length) return body;

    let remaining = maxContextBytes;
    const context = related.flatMap((file) => {
      const patch = takeUtf8Prefix(file.patch, remaining);
      if (!patch) return [];
      remaining -= Buffer.byteLength(patch);
      return [
        {
          path: file.path,
          previousPath: file.previousPath,
          status: file.status,
          patch,
          truncated: Buffer.byteLength(patch) < Buffer.byteLength(file.patch),
        },
      ];
    });
    if (!context.length) return body;
    return `${body}\n\nUntrusted test code supplied as comparison source only. Use it to understand callers, contracts and expected behavior. Do not return findings or reviewed_targets for these files.\n${JSON.stringify({ context_only_test_sources: context })}`;
  };
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const valueBytes = Buffer.byteLength(value);
  if (valueBytes <= maxBytes) return value;
  let result = '';
  for (const line of value.split('\n')) {
    const next = result ? `${result}\n${line}` : line;
    if (Buffer.byteLength(next) > maxBytes) break;
    result = next;
  }
  return result;
}
