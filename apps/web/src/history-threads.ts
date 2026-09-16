import type { ReviewHistoryMessageSummary } from '@gcr/contracts';

// Only group relationships present in the loaded page; never invent missing parents.
export function historyThreads(items: ReviewHistoryMessageSummary[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const groups = new Map<string, ReviewHistoryMessageSummary[]>();
  for (const item of items) {
    let root = item;
    const seen = new Set([item.id]);
    while (root.parentId && byId.has(root.parentId) && !seen.has(root.parentId)) {
      seen.add(root.parentId);
      root = byId.get(root.parentId)!;
    }
    const group = groups.get(root.id) ?? [];
    group.push(item);
    groups.set(root.id, group);
  }
  return [...groups].map(([id, messages]) => ({
    id,
    messages: [...messages].sort((a, b) =>
      a.id === id ? -1 : b.id === id ? 1 : a.githubCreatedAt.localeCompare(b.githubCreatedAt),
    ),
  }));
}
