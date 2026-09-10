import { describe, expect, it } from 'vitest';
import type { WorkspaceData } from './api.ts';
import { resolveChatCitation } from './chat-citations.ts';

type Finding = NonNullable<WorkspaceData['report']>['findings'][number];
const anchor = {
  id: 'primary',
  fileId: 'file-a',
  side: 'head' as const,
  startLine: 10,
  endLine: 15,
  artifactType: 'snapshot-diff',
};
const evidence = {
  id: 'secondary',
  fileId: 'file-b',
  side: 'mergeBase' as const,
  startLine: 40,
  endLine: 48,
  artifactType: 'snapshot-diff',
};
const findings = [{ id: 'finding', anchor, evidence: [evidence] }] as Finding[];
const files = [
  { id: 'file-a', path: 'src/a.ts' },
  { id: 'file-b', path: 'src/b.ts' },
];

describe('chat citation navigation', () => {
  it('navigates to each evidence range instead of the finding representative anchor', () => {
    const target = resolveChatCitation(
      {
        findingId: 'finding',
        evidenceId: 'secondary',
        fileId: 'file-b',
        line: 40,
        endLine: 48,
        side: 'mergeBase',
        label: '',
      },
      files,
      findings,
    );
    expect(target?.anchor).toEqual(evidence);
    expect(target?.label).toBe('src/b.ts · L40–48 · 이전 코드');
    expect(target?.path).toBe('src/b.ts');
  });
  it('recovers the side, path and full range for old messages without changing storage', () => {
    const legacy = {
      findingId: 'finding',
      evidenceId: 'secondary',
      fileId: 'file-b',
      line: 40,
      label: 'line 40',
    };
    expect(resolveChatCitation(legacy, files, findings)?.anchor).toEqual(evidence);
    expect(legacy.label).toBe('line 40');
  });
  it('supports citations without findingId and file-level locations', () => {
    const fileAnchor = {
      id: 'file-evidence',
      fileId: 'file-b',
      side: 'head' as const,
      artifactType: 'snapshot-diff',
    };
    const target = resolveChatCitation(
      { evidenceId: 'file-evidence', fileId: 'file-b', label: '' },
      files,
      [{ ...findings[0]!, evidence: [fileAnchor] }],
    );
    expect(target?.anchor.startLine).toBeUndefined();
    expect(target?.label).toBe('src/b.ts · 파일 전체 · 변경 코드');
  });
  it.each([
    { fileId: 'foreign-file' },
    { evidenceId: 'foreign-revision-evidence' },
    { findingId: 'foreign-finding' },
    { line: 999 },
    { endLine: 999 },
    { side: 'head' as const },
  ])('does not substitute another finding/line when the citation mismatches %j', (patch) => {
    expect(
      resolveChatCitation(
        {
          findingId: 'finding',
          evidenceId: 'secondary',
          fileId: 'file-b',
          line: 40,
          label: '',
          ...patch,
        },
        files,
        findings,
      ),
    ).toBeNull();
  });
});
