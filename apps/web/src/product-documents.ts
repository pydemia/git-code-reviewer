import introduction from '../../../docs/product/introduction.md?raw';
import features from '../../../docs/product/features.md?raw';

export function documentHeadingId(title: string) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function documentContent(markdown: string) {
  const [heading, ...lines] = markdown.trim().split('\n');
  return {
    title: heading!.replace(/^# /, ''),
    body: lines.join('\n').trim(),
    sections: [...markdown.matchAll(/^## (.+)$/gm)].map((match) => ({
      id: documentHeadingId(match[1]!),
      title: match[1]!,
    })),
  };
}

export const productDocuments = {
  introduction: {
    path: '/introduction',
    label: 'Introduction',
    ...documentContent(introduction),
  },
  features: {
    path: '/features',
    label: '기능 목록',
    ...documentContent(features),
  },
};
