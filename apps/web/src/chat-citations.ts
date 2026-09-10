import type { ChatCitation } from '@gcr/contracts';
import type { WorkspaceData } from './api.ts';

type Finding = NonNullable<WorkspaceData['report']>['findings'][number];

// 현재 revision의 report locator를 다시 확인한다. Citation의 문자열로 위치를 추측하지 않는다.
export function resolveChatCitation(
  citation: ChatCitation,
  files: Pick<WorkspaceData['files'][number], 'id' | 'path'>[],
  findings: Finding[],
) {
  const file = files.find((item) => item.id === citation.fileId);
  if (!file) return null;
  for (const finding of findings) {
    if (citation.findingId && finding.id !== citation.findingId) continue;
    const anchor = [finding.anchor, ...finding.evidence].find(
      (item) =>
        item.id === citation.evidenceId &&
        ['snapshot-diff', 'diff'].includes(item.artifactType) &&
        item.fileId === citation.fileId &&
        (!citation.side || item.side === citation.side) &&
        (citation.line === undefined || item.startLine === citation.line) &&
        (citation.endLine === undefined || item.endLine === citation.endLine),
    );
    if (!anchor) continue;
    if (anchor.endLine && (!anchor.startLine || anchor.endLine < anchor.startLine)) return null;
    const range = anchor.startLine
      ? `L${anchor.startLine}${anchor.endLine && anchor.endLine !== anchor.startLine ? `–${anchor.endLine}` : ''}`
      : '파일 전체';
    return {
      anchor,
      path: file.path,
      findingId: finding.id,
      label: `${file.path} · ${range} · ${anchor.side === 'mergeBase' ? '이전 코드' : '변경 코드'}`,
    };
  }
  return null;
}
