export type TreeFile = {
  id: string;
  path: string;
  additions: number | null;
  deletions: number | null;
};
export type FileTreeNode = {
  path: string;
  name: string;
  file?: TreeFile;
  children: FileTreeNode[];
  additions: number | null;
  deletions: number | null;
};

export function buildFileTree(files: TreeFile[]): FileTreeNode[] {
  const root: FileTreeNode = { path: '', name: '', children: [], additions: 0, deletions: 0 };
  for (const file of files) {
    let parent = root;
    const parts = file.path.split('/');
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join('/');
      let child = parent.children.find((item) => item.path === path);
      if (!child) {
        child = { path, name, children: [], additions: 0, deletions: 0 };
        parent.children.push(child);
      }
      child.additions =
        child.additions === null || file.additions === null
          ? null
          : child.additions + file.additions;
      child.deletions =
        child.deletions === null || file.deletions === null
          ? null
          : child.deletions + file.deletions;
      if (index === parts.length - 1) child.file = file;
      parent = child;
    });
  }
  const sort = (nodes: FileTreeNode[]) => {
    nodes.sort(
      (a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name),
    );
    nodes.forEach((node) => sort(node.children));
  };
  sort(root.children);
  return root.children;
}

export function ancestorPaths(path: string) {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

export function visibleFileTree(
  nodes: FileTreeNode[],
  expanded: Set<string>,
  level = 1,
  parent = '',
): Array<{ node: FileTreeNode; level: number; parent: string; position: number; size: number }> {
  return nodes.flatMap((node, index) => [
    { node, level, parent, position: index + 1, size: nodes.length },
    ...(expanded.has(node.path)
      ? visibleFileTree(node.children, expanded, level + 1, node.path)
      : []),
  ]);
}
