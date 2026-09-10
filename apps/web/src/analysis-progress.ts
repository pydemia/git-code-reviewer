import type { WorkspaceData } from './api.ts';

export function analysisIsPending(analysis: WorkspaceData['analysis']) {
  return (
    !analysis ||
    analysis.state === null ||
    analysis.state === 'queued' ||
    analysis.state === 'analyzing'
  );
}

export function analysisProgressLabel(analysis: WorkspaceData['analysis']) {
  if (!analysis?.id) return '코드 준비 중';
  if (analysis.state === 'queued') return '분석 대기 중';
  const labels: Record<string, string> = {
    deterministic: '코드 구조 확인 중',
    review: '파일 검토 준비 중',
    'unit-comment-block': '코드 검토 중',
    'overall-summary': '파일 요약 중',
    'file-review': '파일 검토 중',
    'total-summary': '전체 요약 중',
    persisting: '분석 결과 저장 중',
  };
  return labels[analysis.stage ?? ''] ?? '분석 중';
}
