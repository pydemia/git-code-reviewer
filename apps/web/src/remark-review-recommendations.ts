interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName: string; hProperties: { className: string[] } };
}

const text = (node: MarkdownNode): string => node.value ?? node.children?.map(text).join('') ?? '';
const label = (node: MarkdownNode) =>
  node.type === 'heading' ||
  (node.type === 'paragraph' && node.children?.length === 1 && node.children[0]?.type === 'strong');
const boundary = (node: MarkdownNode) =>
  label(node) ||
  node.type === 'thematicBreak' ||
  (node.type === 'paragraph' &&
    node.children?.length === 1 &&
    node.children[0]?.type === 'link' &&
    ['관련 코드 보기', 'GitHub 원문'].includes(text(node)));

// Only explicit Markdown section labels are highlighted; source text is unchanged.
export function remarkReviewRecommendations() {
  return function transform(node: MarkdownNode) {
    if (!node.children) return;
    node.children.forEach(transform);
    const children: MarkdownNode[] = [];
    for (let index = 0; index < node.children.length; index++) {
      const current = node.children[index]!;
      if (label(current) && text(current).replace(/\s/g, '') === '수정제안') {
        let end = index + 1;
        while (end < node.children.length && !boundary(node.children[end]!)) end++;
        if (end > index + 1) {
          children.push({
            type: 'blockquote',
            data: {
              hName: 'div',
              hProperties: { className: ['review-recommendation-box'] },
            },
            children: node.children.slice(index, end),
          });
          index = end - 1;
          continue;
        }
      }
      children.push(current);
    }
    node.children = children;
  };
}
