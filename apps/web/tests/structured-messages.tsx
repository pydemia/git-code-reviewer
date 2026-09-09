// Browser 검증 전용 합성 데이터. 실제 모델·GitHub·사용자 API를 호출하지 않는다.
import { createRoot } from 'react-dom/client';
import { ReviewReportPanel } from '../src/ReviewReportPanel';
import type { WorkspaceData } from '../src/api';
import '@fontsource-variable/noto-sans-kr';
import '../src/styles.css';

const coverage = {
  filesExamined: 1,
  filesChanged: 2,
  objectsExamined: 0,
  relationsExamined: 0,
  limitations: [
    '생성 파일은 검토 범위에서 제외했습니다.',
    '호출부 일부는 제공된 source 범위에 없어 실제 동작을 확인하지 못했습니다.',
  ],
  truncated: true,
};
const report: NonNullable<WorkspaceData['report']> = {
  schemaVersion: 1,
  analysisRevisionId: 'synthetic',
  snapshotId: 'synthetic',
  context: {
    repositoryId: 'synthetic',
    owner: 'org-name',
    name: 'repo-name',
    pullNumber: 1,
    pullTitle: '입력 검증과 오류 처리 변경 · 합성 데이터',
    snapshotId: 'synthetic',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
  },
  summary:
    '입력 검증을 보완한 변경이며 오류 처리 순서를 추가로 확인해야 합니다.\n\n## 주요 변경\n\n- **입력 검증**: 빈 문자열과 누락된 값을 구분합니다.\n- **오류 처리**: 실패한 요청은 별도 응답으로 반환합니다.\n\n## 검토 의견\n\n- **실패 경로**: 검증 이전의 상태 변경을 방지해야 합니다.\n\n기존 흐름은 상태를 먼저 갱신한 뒤 검증 결과를 확인합니다. 이 순서가 유지되면 실패 응답을 반환하더라도 이미 변경한 상태는 남을 수 있습니다. 호출부에서 transaction 경계를 보장하는지 확인한 후 변경 순서를 결정하세요.',
  grade: 'adequate',
  hasCriticalFindings: false,
  durationMs: 127000,
  coverage,
  impact: { summary: '실패 요청의 상태에 영향', affectedAreas: [], coverage, confidence: 'medium' },
  versions: { model: 'synthetic', review: 'model' },
  perFileSummaries: [
    {
      fileId: 'file',
      summary:
        '검증 이전의 상태 변경을 확인하세요.\n\n- **발생 조건**: 빈 값으로 요청한 경우\n- **조치**: 검증을 상태 변경보다 먼저 수행',
      priority: 'P2',
      grade: 'adequate',
    },
  ],
  findings: [],
  links: [],
};
createRoot(document.getElementById('root')!).render(
  <main style={{ maxWidth: 1000, margin: '0 auto', padding: 16 }}>
    <p>표시 검증 전용 · 합성 데이터</p>
    <ReviewReportPanel
      report={report}
      files={
        [
          { id: 'file', path: 'packages/validation/very-long-path/input-validation-service.ts' },
        ] as WorkspaceData['files']
      }
      section="summary"
      selectedFindingId={null}
      onFileSelect={() => {}}
      onFindingSelect={() => {}}
    />
  </main>,
);
