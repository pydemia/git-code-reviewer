import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { GitHubMessageProvenance } from './GitHubMessageEvidence.tsx';
const base = {
  provider: 'github-rest' as const,
  reviewState: null,
  reviewGithubId: null,
  originalCommitSha: null,
  originalLine: null,
  startLine: null,
  originalStartLine: null,
  startSide: null,
  subjectType: null,
  diffHunk: null,
  threadResolved: null,
  threadOutdated: null,
};
const source = {
  path: 'a.ts',
  line: 1,
  commitSha: null,
  inReplyToGithubId: null,
  provenance: base,
};
describe('thread evidence display', () => {
  it('distinguishes observed unresolved/resolved threads without claiming a fixed defect', () => {
    const resolved = renderToStaticMarkup(
      <GitHubMessageProvenance
        source={{
          ...source,
          provenance: {
            ...base,
            threadObservation: 'observed',
            threadId: 'T',
            threadResolved: true,
            threadOutdated: true,
          },
        }}
      />,
    );
    expect(resolved).toContain('해결됨');
    expect(resolved).toContain('이전 변경에 대한 논의');
    expect(resolved).toContain('결함 수정 여부는 별도 검증 필요');
    const open = renderToStaticMarkup(
      <GitHubMessageProvenance
        source={{
          ...source,
          provenance: {
            ...base,
            threadObservation: 'observed',
            threadId: 'T',
            threadResolved: false,
            threadOutdated: false,
          },
        }}
      />,
    );
    expect(open).toContain('미해결');
    expect(open).toContain('outdated 아님');
  });
  it('shows unsuccessful and partial observations as unknown', () => {
    for (const threadObservation of [
      'unavailable',
      'partial',
      'unsupported',
      'not-observed',
    ] as const) {
      const html = renderToStaticMarkup(
        <GitHubMessageProvenance
          source={{ ...source, provenance: { ...base, threadObservation } }}
        />,
      );
      expect(html).toContain('미확인');
      expect(html).not.toContain('스레드: 해결됨');
    }
  });
});
