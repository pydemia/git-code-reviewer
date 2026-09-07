import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen } from 'lucide-react';
import { ancestorPaths, buildFileTree, visibleFileTree, type TreeFile } from './file-tree.ts';

export function FileTree({
  files,
  selectedPath,
  onSelect,
}: {
  files: TreeFile[];
  selectedPath: string;
  onSelect: (path: string) => void;
}) {
  const nodes = useMemo(() => buildFileTree(files), [files]);
  // 접은 경로만 기억하므로 새로 수집된 파일·폴더도 기본으로 펼쳐집니다.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const directories = useMemo(
    () => new Set(files.flatMap((file) => ancestorPaths(file.path))),
    [files],
  );
  const expanded = useMemo(
    () => new Set([...directories].filter((path) => !collapsed.has(path))),
    [directories, collapsed],
  );
  const [focused, setFocused] = useState(selectedPath);
  const tree = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setCollapsed((current) => {
      const next = new Set(current);
      for (const path of ancestorPaths(selectedPath)) next.delete(path);
      return next;
    });
    setFocused(selectedPath);
  }, [selectedPath]);
  const rows = useMemo(() => visibleFileTree(nodes, expanded), [nodes, expanded]);
  const tabStop = rows.some(({ node }) => node.path === focused) ? focused : rows[0]?.node.path;
  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const focus = (path: string | undefined) => {
    if (!path) return;
    setFocused(path);
    const index = rows.findIndex(({ node }) => node.path === path);
    tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]')[index]?.focus();
  };
  const onKey = (event: KeyboardEvent, index: number) => {
    const row = rows[index]!;
    switch (event.key) {
      case 'ArrowDown':
        focus(rows[Math.min(rows.length - 1, index + 1)]?.node.path);
        break;
      case 'ArrowUp':
        focus(rows[Math.max(0, index - 1)]?.node.path);
        break;
      case 'Home':
        focus(rows[0]?.node.path);
        break;
      case 'End':
        focus(rows.at(-1)?.node.path);
        break;
      case 'ArrowRight':
        if (!row.node.file && !expanded.has(row.node.path)) toggle(row.node.path);
        else if (!row.node.file) focus(rows[index + 1]?.node.path);
        break;
      case 'ArrowLeft':
        if (!row.node.file && expanded.has(row.node.path)) toggle(row.node.path);
        else focus(row.parent);
        break;
      default:
        return;
    }
    event.preventDefault();
  };
  return (
    <div className="repository-tree">
      <div className="tree-controls">
        <button type="button" onClick={() => setCollapsed(new Set())}>
          모두 펼치기
        </button>
        <button type="button" onClick={() => setCollapsed(new Set(directories))}>
          모두 접기
        </button>
      </div>
      <div role="tree" aria-label="변경 파일" ref={tree}>
        {rows.map(({ node, level, position, size }, index) => (
          <button
            type="button"
            role="treeitem"
            key={node.path}
            aria-level={level}
            aria-posinset={position}
            aria-setsize={size}
            aria-expanded={node.file ? undefined : expanded.has(node.path)}
            aria-selected={node.path === selectedPath}
            tabIndex={node.path === tabStop ? 0 : -1}
            className={`repository-tree-row${node.path === selectedPath ? ' active' : ''}`}
            style={{ paddingLeft: 8 + (level - 1) * 14 }}
            title={node.path}
            onFocus={() => setFocused(node.path)}
            onKeyDown={(event) => onKey(event, index)}
            onClick={() => (node.file ? onSelect(node.path) : toggle(node.path))}
          >
            {node.file ? (
              <span className="tree-disclosure-space" />
            ) : expanded.has(node.path) ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )}
            {node.file ? (
              <FileCode2 size={14} />
            ) : expanded.has(node.path) ? (
              <FolderOpen size={14} />
            ) : (
              <Folder size={14} />
            )}
            <span className="tree-name">{node.name}</span>
            <span className="change-counts">
              <span className="additions">+{node.additions ?? '—'}</span>
              <span className="deletions">−{node.deletions ?? '—'}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
