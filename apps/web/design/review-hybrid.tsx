import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import {
  FileCode2,
  FolderTree,
  GitPullRequest,
  MessageSquare,
  ArrowLeft,
  History,
} from 'lucide-react';
import { ReviewDiff, type CodeTarget } from '../src/ReviewDiff.tsx';
import { ReviewReportPanel } from '../src/ReviewReportPanel.tsx';
import type { WorkspaceData } from '../src/api.ts';
import palettes from '../../../docs/design/review-ui-proposals-2026-09-27/palettes.json';
import '../src/styles.css';
import './review-hybrid.css';

type Report = NonNullable<WorkspaceData['report']>;
type Finding = Report['findings'][number];
const params = new URLSearchParams(location.search);
const palette =
  palettes.palettes.find((entry) => entry.id === (params.get('palette') || 'C5')) ??
  palettes.palettes[4]!;
const contentState = params.get('state') || 'normal';
const sourcePath = 'samples/filter_pool_by_block.py';
const testPath = 'samples/test_filter_pool_by_block.py';
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const sourcePatch = [
  '@@ -8,10 +8,10 @@',
  ' def filter_pool_by_block(',
  '     candidates: dict[str, dict],',
  '     intent: str,',
  '-    extracted_entities: dict,',
  '+    extracted_entities: dict | None = None,',
  ' ) -> dict:',
  '     """Filter candidate blocks."""',
  '     if intent == "multi_candidate_recommendation":',
  '         ignored = extracted_entities.get("ignored_candidates", [])',
  '         return {key: value for key, value in candidates.items() if key not in ignored}',
  '     return candidates',
].join('\n');
const testPatch = [
  '@@ -1,5 +1,6 @@',
  ' def test_multi_candidate_recommendation():',
  '     result = filter_pool_by_block(',
  '         candidates={"sample": {}},',
  '+        extracted_entities={},',
  '         intent="multi_candidate_recommendation",',
  '     )',
].join('\n');
const coverage = {
  filesExamined: 2,
  filesChanged: 2,
  objectsExamined: 0,
  relationsExamined: 0,
  limitations: [],
  truncated: false,
};
const common = {
  priority: 'P2' as const,
  category: 'correctness' as const,
  source: { kind: 'model' as const, producer: 'design-fixture-no-model-call' },
  confidence: 'high' as const,
  verification: { status: 'verified' as const, checks: [], originalPriority: 'P2' as const },
  evidence: [],
  links: [],
};
const normalFindings: Finding[] = [
  {
    ...common,
    id: 'preview-optional',
    fingerprint: 'preview-optional',
    title: 'optional `extracted_entities`를 함수 진입 시 정규화하세요',
    problem:
      '`extracted_entities`의 기본값은 `None`이지만, 아래 분기에서 `.get()`을 직접 호출합니다. 인자를 생략하고 multi-candidate 경로를 실행하면 `AttributeError`가 발생합니다.\n\n이 시안의 합성 patch와 연결된 의견입니다. 실제 저장소의 현재 결함 판정은 아닙니다.',
    impact:
      '인자를 생략한 호출이 블록 필터 단계에서 중단됩니다. 모든 접근 전에 정규화된다면 이 지적은 적용되지 않습니다.',
    recommendation:
      '함수 진입 시 `extracted_entities = extracted_entities or {}`로 정규화하고, 생략·`None`·빈 dict 호출을 확인하세요.',
    anchor: {
      id: 'preview-anchor',
      fileId: 'preview-source',
      side: 'head',
      startLine: 11,
      endLine: 11,
      artifactType: 'diff',
      commitOid: headSha,
    },
  },
  {
    ...common,
    id: 'preview-test',
    fingerprint: 'preview-test',
    title: '인자를 생략하는 호출도 테스트에 포함하세요',
    problem:
      '수정된 테스트는 `{}`를 명시적으로 전달합니다. 이 경우 optional 기본값인 `None`으로 실행되는 경로는 검증하지 못합니다.',
    impact: 'API가 허용한 생략 호출에서 발생하는 오류를 회귀 테스트가 놓칠 수 있습니다.',
    recommendation: '인자 생략, 명시적 `None`, 빈 dict를 각각 테스트하고 기대 결과를 기록하세요.',
    anchor: {
      id: 'preview-test-anchor',
      fileId: 'preview-test-file',
      side: 'head',
      startLine: 4,
      endLine: 4,
      artifactType: 'diff',
      commitOid: headSha,
    },
  },
];
const findings = ['empty', 'error', 'loading'].includes(contentState)
  ? []
  : normalFindings.map((finding) =>
      contentState === 'long'
        ? {
            ...finding,
            problem:
              finding.problem +
              '\n\n| 호출 조건 | 확인할 근거 | 판단 |\n| --- | --- | --- |\n| 인자 생략 | 기본값과 정규화 위치 | 접근 전 None 처리 필요 |\n| 수정된 호출부 | 정규화가 모든 접근을 지배 | 과거 지적 반복하지 않음 |\n\n```python\n' +
              'ignored_candidates = '.repeat(16) +
              '\n```',
          }
        : finding,
    );
const files = [
  { id: 'preview-source', path: sourcePath, previousPath: null },
  { id: 'preview-test-file', path: testPath, previousPath: null },
] as WorkspaceData['files'];
const diff: NonNullable<WorkspaceData['diff']> = {
  schemaVersion: 1,
  patch: sourcePatch + '\n' + testPatch,
  files: [
    {
      path: sourcePath,
      previousPath: null,
      status: 'modified',
      additions: 1,
      deletions: 1,
      patch: sourcePatch,
    },
    {
      path: testPath,
      previousPath: null,
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: testPatch,
    },
  ],
};
const report: Report = {
  schemaVersion: 1,
  analysisRevisionId: 'design-fixture',
  snapshotId: 'design-fixture',
  hasCriticalFindings: false,
  context: {
    repositoryId: 'design-fixture',
    owner: 'design',
    name: 'samples',
    pullNumber: 0,
    pullTitle: 'Design fixture',
    snapshotId: 'design-fixture',
    baseSha,
    mergeBaseSha: baseSha,
    headSha,
  },
  impact: { summary: '', affectedAreas: [], coverage, confidence: 'low' },
  summary: '합성 시안 자료',
  grade: 'adequate',
  durationMs: 0,
  coverage,
  versions: { model: 'fixture' },
  perFileSummaries: [],
  findings,
  links: [],
};

export function HybridPreview() {
  const [fileId, setFileId] = useState(files[0]!.id);
  const [selected, setSelected] = useState<Finding | undefined>();
  const [target, setTarget] = useState<CodeTarget | null>(null);
  const [mode, setMode] = useState<'split' | 'unified'>(() =>
    window.matchMedia('(max-width: 760px)').matches ? 'unified' : 'split',
  );
  const [pane, setPane] = useState<'both' | 'code' | 'comments'>('both');
  const [sidebar, setSidebar] = useState(true);
  const [inline, setInline] = useState(false);
  const [codeHeight, setCodeHeight] = useState(320);
  const [maxCodeHeight, setMaxCodeHeight] = useState(680);
  const main = useRef<HTMLElement>(null);
  const request = useRef(0);
  const file = files.find((entry) => entry.id === fileId)!;
  const patch = diff.files.find((entry) => entry.path === file.path)!.patch;
  const fileReport = {
    ...report,
    findings: findings.filter((item) => item.anchor.fileId === fileId),
  };
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 760px)');
    const update = () => setMode(narrow.matches ? 'unified' : 'split');
    narrow.addEventListener('change', update);
    return () => narrow.removeEventListener('change', update);
  }, []);
  function selectFinding(finding: Finding) {
    setFileId(finding.anchor.fileId);
    setSelected(finding);
    setTarget({ ...finding.anchor, request: ++request.current });
    if (pane === 'comments') setPane('both');
  }
  useEffect(() => {
    const area = main.current;
    if (!area) return;
    const update = () => {
      const maximum = Math.max(180, area.clientHeight - 250);
      setMaxCodeHeight(maximum);
      setCodeHeight((height) => Math.min(height, maximum));
    };
    const observer = new ResizeObserver(update);
    observer.observe(area);
    update();
    return () => observer.disconnect();
  }, []);
  function selectFile(id: string) {
    setFileId(id);
    setSelected(undefined);
    setTarget(null);
  }
  function resize(event: PointerEvent<HTMLDivElement>) {
    const area = main.current;
    if (!area) return;
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !main.current) return;
    const box = main.current.getBoundingClientRect();
    setCodeHeight(Math.max(180, Math.min(maxCodeHeight, event.clientY - box.top)));
  }
  return (
    <div
      className="hybrid-preview"
      style={
        Object.fromEntries(
          Object.entries(palette.tokens).map(([key, value]) => [`--${key}`, value]),
        ) as CSSProperties
      }
    >
      <header className="hybrid-brand">
        <strong>
          <GitPullRequest size={18} /> Git Code Reviewer
        </strong>
        <span>{palette.id} · U1 + U2</span>
        <a href="../?palette=C5&ui=U1%2BU2" target="_top">
          <ArrowLeft size={14} /> 비교 보드
        </a>
      </header>
      <div className="hybrid-context">
        <div>
          <span className="hybrid-eyebrow">REVIEW WORKSPACE</span>
          <h1>코드와 리뷰를 함께 검토</h1>
        </div>
        <p>실제 GCR renderer · 합성 patch / 의견 {findings.length}건 · API·모델 호출 없음</p>
      </div>
      <div className={`hybrid-shell${sidebar ? '' : ' sidebar-hidden'}`}>
        <nav className="hybrid-rail" aria-label="작업 영역">
          <button type="button" onClick={() => setPane('both')} aria-pressed={pane === 'both'}>
            <GitPullRequest size={19} />
            <span>전체</span>
          </button>
          <button type="button" onClick={() => setPane('code')} aria-pressed={pane === 'code'}>
            <FileCode2 size={19} />
            <span>Diff</span>
          </button>
          <button
            type="button"
            onClick={() => setPane('comments')}
            aria-pressed={pane === 'comments'}
          >
            <MessageSquare size={19} />
            <span>리뷰</span>
          </button>
          <a href="../hybrid-decision.md" target="_top">
            <History size={18} />
            <span>기록</span>
          </a>
        </nav>
        {sidebar ? (
          <aside className="hybrid-files" aria-label="변경 파일">
            <header>
              <FolderTree size={15} />
              <strong>변경 파일</strong>
              <span>2</span>
            </header>
            <p>samples /</p>
            {files.map((entry) => (
              <button
                type="button"
                key={entry.id}
                aria-pressed={entry.id === fileId}
                onClick={() => selectFile(entry.id)}
              >
                <FileCode2 size={15} />
                <span>
                  {entry.path.split('/').at(-1)}
                  <small>
                    의견 {findings.filter((item) => item.anchor.fileId === entry.id).length}건 ·{' '}
                    {entry.id === 'preview-source' ? '+1 −1' : '+1'}
                  </small>
                </span>
              </button>
            ))}
            <div className="hybrid-file-note">
              <p>U2 파일 탐색 + 작업 영역</p>
              <p>U1 코드·코멘트 스레드</p>
              <p>기존 Split / Unified diff</p>
            </div>
          </aside>
        ) : null}
        <main
          className={`hybrid-workarea pane-${pane}`}
          ref={main}
          style={{ '--diff-height': `${codeHeight}px` } as CSSProperties}
        >
          {pane !== 'comments' ? (
            <section className="hybrid-code" aria-label="코드 검토">
              <header className="hybrid-toolbar">
                <button
                  type="button"
                  className="hybrid-icon-button"
                  aria-label={sidebar ? '파일 탐색 숨기기' : '파일 탐색 표시'}
                  onClick={() => setSidebar(!sidebar)}
                >
                  <FolderTree size={16} />
                </button>
                <strong>Code diff</strong>
                <span className="hybrid-path">{file.path}</span>
                <div className="hybrid-diff-controls">
                  <button
                    type="button"
                    aria-pressed={mode === 'split'}
                    onClick={() => setMode('split')}
                  >
                    Split
                  </button>
                  <button
                    type="button"
                    aria-pressed={mode === 'unified'}
                    onClick={() => setMode('unified')}
                  >
                    Unified
                  </button>
                </div>
              </header>
              <div className="hybrid-code-meta">
                <span>
                  합성 snapshot · {baseSha.slice(0, 8)} → {headSha.slice(0, 8)}
                </span>
                <label>
                  <input
                    type="checkbox"
                    checked={inline}
                    onChange={(event) => setInline(event.target.checked)}
                  />
                  인라인 의견
                </label>
              </div>
              <div className="review-diff-host">
                <ReviewDiff
                  patch={patch}
                  fileId={fileId}
                  mode={mode}
                  target={target}
                  finding={inline ? selected : undefined}
                  findings={inline ? findings : []}
                />
              </div>
            </section>
          ) : null}
          {pane === 'both' ? (
            <div
              className="hybrid-resize"
              role="separator"
              tabIndex={0}
              aria-label="코드·리뷰 영역 높이 조절"
              aria-orientation="horizontal"
              aria-valuemin={180}
              aria-valuemax={maxCodeHeight}
              aria-valuenow={codeHeight}
              onPointerDown={resize}
              onPointerMove={move}
              onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                  event.preventDefault();
                  setCodeHeight((height) =>
                    Math.max(
                      180,
                      Math.min(maxCodeHeight, height + (event.key === 'ArrowUp' ? -20 : 20)),
                    ),
                  );
                }
              }}
            />
          ) : null}
          {pane !== 'code' ? (
            <section className="hybrid-comments" aria-label="리뷰 스레드">
              <header className="hybrid-toolbar">
                <MessageSquare size={15} />
                <strong>Comments</strong>
                <span>현재 파일 · {fileReport.findings.length}건</span>
                {pane === 'comments' ? (
                  <button type="button" onClick={() => setSidebar(!sidebar)}>
                    {sidebar ? '파일 탐색 숨기기' : '파일 탐색 표시'}
                  </button>
                ) : null}
              </header>
              <div className="bottom-comments-host">
                {contentState === 'error' || contentState === 'loading' ? (
                  <p className="hybrid-state" role={contentState === 'error' ? 'alert' : 'status'}>
                    {contentState === 'error'
                      ? '리뷰 원문을 불러오지 못했습니다. (상태 표시용 합성 사례)'
                      : '리뷰 원문을 불러오는 중입니다. (상태 표시용 합성 사례)'}
                  </p>
                ) : (
                  <ReviewReportPanel
                    report={fileReport}
                    files={files}
                    diff={diff}
                    section="comments"
                    selectedFindingId={selected?.id ?? null}
                    onFindingSelect={selectFinding}
                    onFileSelect={(path) => {
                      const entry = files.find((item) => item.path === path);
                      if (entry) selectFile(entry.id);
                    }}
                  />
                )}
              </div>
            </section>
          ) : null}
        </main>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<HybridPreview />);
