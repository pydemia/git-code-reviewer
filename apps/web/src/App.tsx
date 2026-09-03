import {
  Activity,
  Bot,
  Braces,
  ChevronDown,
  ChevronRight,
  Clipboard,
  CircleAlert,
  CircleCheck,
  Clock3,
  ExternalLink,
  Download,
  FileCode2,
  Files,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Link2,
  ListFilter,
  Maximize2,
  Network,
  PanelBottom,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  TestTube2,
  ThumbsUp,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import {
  loadAnalysisWorkspace,
  loadWorklist,
  loadWorkspace,
  openChatSession,
  refreshPull,
  sendChatMessage,
  waitForSnapshot,
  type ChatMessage,
  type ChatSession,
  type WorklistItem,
  type WorkspaceData,
  type User,
  loadCurrentUser,
} from './api.ts';
import { AdminPage } from './AdminPage.tsx';
import { AppHeader } from './AppHeader.tsx';
import { analyzeAddedTests, type AddedTestFile } from './test-analysis.ts';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  WORKSPACE_LAYOUT_LIMITS,
  constrainWorkspaceLayout,
  parseWorkspaceLayout,
  resizeWorkspaceLayout,
  type WorkspaceLayout,
  type WorkspaceResizeHandle,
} from './workspace-layout.ts';

type ReviewMode = 'files' | 'findings' | 'outline' | 'impact';
type BottomTool = 'evidence' | 'graph' | 'impact' | 'tests';
type FindingView = NonNullable<WorkspaceData['report']>['findings'][number];
type ResizeOperation = {
  handle: WorkspaceResizeHandle;
  pointerId: number;
  startX: number;
  startY: number;
  layout: WorkspaceLayout;
};

const WORKSPACE_LAYOUT_STORAGE_KEY = 'git-code-reviewer.workspace-layout.v1';
const WORKLIST_TENANT_STORAGE_KEY = 'git-code-reviewer.worklist-tenant.v1';
const RESPONSIVE_LAYOUT_BREAKPOINT = 820;

function isBottomTool(value: string | null): value is BottomTool {
  return value === 'evidence' || value === 'graph' || value === 'impact' || value === 'tests';
}

export function App() {
  if (window.location.pathname === '/admin') return <AdminPage />;
  const analysisMatch = window.location.pathname.match(/^\/reviews\/([^/]+)$/);
  if (analysisMatch) return <ReviewWorkspace analysisId={analysisMatch[1]!} />;
  const pullMatch = window.location.pathname.match(/^\/repositories\/([^/]+)\/pulls\/(\d+)$/);
  if (pullMatch) {
    return <ReviewWorkspace repositoryId={pullMatch[1]!} pullNumber={Number(pullMatch[2])} />;
  }
  return <Worklist />;
}

function Worklist() {
  const [reloadToken, setReloadToken] = useState(0);
  const [user, setUser] = useState<User | null>(null);
  const [selectedTenantId, setSelectedTenantId] = useState(
    () => window.localStorage.getItem(WORKLIST_TENANT_STORAGE_KEY) ?? '',
  );
  const [state, setState] = useState<{
    status: 'loading' | 'ready' | 'error';
    items: WorklistItem[];
  }>({ status: 'loading', items: [] });

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, status: 'loading' }));
    void loadCurrentUser(controller.signal)
      .then((currentUser) => {
        const tenantId = currentUser.tenants.some((tenant) => tenant.id === selectedTenantId)
          ? selectedTenantId
          : (currentUser.tenants[0]?.id ?? '');
        setUser(currentUser);
        if (tenantId !== selectedTenantId) setSelectedTenantId(tenantId);
        if (tenantId) window.localStorage.setItem(WORKLIST_TENANT_STORAGE_KEY, tenantId);
        return loadWorklist(controller.signal, tenantId || undefined);
      })
      .then(
        (items) => setState({ status: 'ready', items }),
        (error: unknown) => {
          if (!controller.signal.aborted) {
            console.error(error);
            setState({ status: 'error', items: [] });
          }
        },
      );
    return () => controller.abort();
  }, [reloadToken, selectedTenantId]);

  const selectTenant = (tenantId: string) => {
    window.localStorage.setItem(WORKLIST_TENANT_STORAGE_KEY, tenantId);
    setSelectedTenantId(tenantId);
  };

  return (
    <div className="worklist-page">
      <AppHeader user={user} selectedTenantId={selectedTenantId} onTenantChange={selectTenant} />
      <main className="worklist-main">
        <div className="worklist-title-row">
          <div>
            <p className="eyebrow">Review queue</p>
            <h1>Pull requests</h1>
          </div>
          <button
            className="command-button"
            type="button"
            onClick={() => setReloadToken((value) => value + 1)}
            disabled={state.status === 'loading'}
          >
            <RefreshCw size={15} />
            {state.status === 'loading' ? '불러오는 중' : '동기화'}
          </button>
        </div>
        <div className="filter-bar" aria-label="Pull request 필터">
          <button className="filter-button active" type="button">
            <GitPullRequest size={15} /> 열림 <span>{state.items.length}</span>
          </button>
          <button className="filter-button" type="button">
            <CircleAlert size={15} /> 확인 필요 <span>0</span>
          </button>
          <div className="filter-spacer" />
          <button className="icon-button" type="button" title="필터" aria-label="필터">
            <ListFilter size={16} />
          </button>
        </div>
        <section className="pr-table" aria-label="Pull request 목록">
          <div className="pr-table-head">
            <span>Pull request</span>
            <span>상태</span>
            <span>위험</span>
            <span>업데이트</span>
          </div>
          {state.items.map((pr) => (
            <a
              className="pr-row"
              href={
                pr.latestAnalysisId
                  ? `/reviews/${pr.latestAnalysisId}`
                  : `/repositories/${pr.repository.id}/pulls/${pr.number}`
              }
              key={pr.id}
            >
              <span className="pr-primary">
                <span className="pr-title">{pr.title}</span>
                <span className="pr-meta">
                  {pr.repository.owner}/{pr.repository.name} #{pr.number} · {pr.author}
                </span>
              </span>
              <span className="status-cell">
                {pr.grade ? <CircleCheck size={14} /> : <Clock3 size={14} />}
                {pr.draft ? '초안' : pr.grade ? '분석 완료' : formatAnalysisState(pr.analysisState)}
              </span>
              <span className={`risk-cell ${pr.grade ?? 'unreviewed'}`}>
                {pr.grade ? `${pr.grade} · P2+ ${pr.attentionCount}` : '미분석'}
              </span>
              <span className="muted-cell">{formatRelativeTime(pr.updatedAt)}</span>
            </a>
          ))}
          {state.status === 'loading' ? (
            <div className="table-state">
              <RefreshCw size={16} className="spin" /> PR을 불러오는 중입니다.
            </div>
          ) : null}
          {state.status === 'error' ? (
            <div className="table-state error">
              <CircleAlert size={16} /> PR 목록을 불러오지 못했습니다.
            </div>
          ) : null}
          {state.status === 'ready' && state.items.length === 0 ? (
            <div className="table-state">
              <GitPullRequest size={16} /> 등록된 open PR이 없습니다.
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}

function formatRelativeTime(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return '방금 전';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

function formatAnalysisState(state: string | null): string {
  if (state === 'analyzing') return '분석 중';
  if (state === 'failed') return '분석 실패';
  if (state === 'partial') return '부분 완료';
  return '분석 대기';
}

function ReviewWorkspace({
  repositoryId,
  pullNumber,
  analysisId,
}: {
  repositoryId?: string;
  pullNumber?: number;
  analysisId?: string;
}) {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState<ReviewMode>('files');
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [bottomTool, setBottomTool] = useState<BottomTool>('evidence');
  const [chatSession, setChatSession] = useState<ChatSession | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const [diffMode, setDiffMode] = useState<'split' | 'unified'>('split');
  const [workspaceLayout, setWorkspaceLayout] = useState(() => {
    try {
      return parseWorkspaceLayout(window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY));
    } catch {
      return DEFAULT_WORKSPACE_LAYOUT;
    }
  });
  const [resizing, setResizing] = useState<WorkspaceResizeHandle | null>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const resizeOperationRef = useRef<ResizeOperation | null>(null);

  const workspaceBounds = () => {
    const rect = workspaceRef.current?.getBoundingClientRect();
    return { width: rect?.width ?? window.innerWidth, height: rect?.height ?? window.innerHeight };
  };

  const startResize = (handle: WorkspaceResizeHandle, event: PointerEvent<HTMLDivElement>) => {
    if (workspaceBounds().width <= RESPONSIVE_LAYOUT_BREAKPOINT) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeOperationRef.current = {
      handle,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      layout: workspaceLayout,
    };
    setResizing(handle);
  };

  const continueResize = (event: PointerEvent<HTMLDivElement>) => {
    const operation = resizeOperationRef.current;
    if (!operation || operation.pointerId !== event.pointerId) return;
    const delta =
      operation.handle === 'bottom'
        ? event.clientY - operation.startY
        : event.clientX - operation.startX;
    setWorkspaceLayout(
      resizeWorkspaceLayout(operation.layout, operation.handle, delta, workspaceBounds()),
    );
  };

  const finishResize = (event: PointerEvent<HTMLDivElement>) => {
    const operation = resizeOperationRef.current;
    if (!operation || operation.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeOperationRef.current = null;
    setResizing(null);
  };

  const resizeWithKeyboard = (handle: WorkspaceResizeHandle, delta: number) => {
    setWorkspaceLayout((current) =>
      resizeWorkspaceLayout(current, handle, delta, workspaceBounds()),
    );
  };

  useEffect(() => {
    try {
      window.localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify(workspaceLayout));
    } catch {
      // Browser storage can be unavailable in restricted contexts; resizing still works in memory.
    }
  }, [workspaceLayout]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width <= RESPONSIVE_LAYOUT_BREAKPOINT) return;
      setWorkspaceLayout((current) =>
        constrainWorkspaceLayout(current, {
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        }),
      );
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    document.body.classList.toggle('workspace-resizing', resizing !== null);
    return () => document.body.classList.remove('workspace-resizing');
  }, [resizing]);

  useEffect(() => {
    const controller = new AbortController();
    const workspaceRequest = analysisId
      ? loadAnalysisWorkspace(analysisId, controller.signal)
      : repositoryId && pullNumber
        ? loadWorkspace(repositoryId, pullNumber, controller.signal)
        : Promise.reject(new Error('Review target is missing'));
    void workspaceRequest.then(
      (workspace) => {
        setData(workspace);
        const search = new URLSearchParams(window.location.search);
        const requestedFindingId = search.get('finding');
        const requestedFinding = workspace.report?.findings.find(
          (finding) => finding.id === requestedFindingId,
        );
        setSelectedFindingId(requestedFinding?.id ?? null);
        setReviewMode(requestedFinding ? 'findings' : 'files');
        const requestedObjectId = search.get('symbol');
        const requestedObject = workspace.objects.find((object) => object.id === requestedObjectId);
        setSelectedObjectId(
          requestedObject?.id ??
            workspace.objects.find((object) => object.kind === 'function')?.id ??
            workspace.objects[0]?.id ??
            null,
        );
        const requestedTool = search.get('tool');
        setBottomTool(
          isBottomTool(requestedTool) ? requestedTool : requestedObject ? 'impact' : 'evidence',
        );
        setSelectedPath(
          requestedFinding
            ? (workspace.files.find((file) => file.id === requestedFinding.anchor.fileId)?.path ??
                initialSelectedPath(workspace))
            : initialSelectedPath(workspace),
        );
        setStatus('ready');
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          console.error(error);
          setStatus('error');
        }
      },
    );
    return () => controller.abort();
  }, [analysisId, repositoryId, pullNumber]);

  useEffect(() => {
    const currentAnalysisId = data?.analysis?.id;
    if (!currentAnalysisId || !data?.report) return;
    const controller = new AbortController();
    void openChatSession(currentAnalysisId, {}, controller.signal).then(
      ({ session, messages }) => {
        setChatSession(session);
        setChatMessages(messages);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) console.error(error);
      },
    );
    return () => controller.abort();
  }, [data?.analysis?.id, data?.report]);

  const handleRefresh = async () => {
    if (!data) return;
    setRefreshing(true);
    const controller = new AbortController();
    try {
      const refresh = await refreshPull(data.pull.repositoryId, data.pull.number);
      const operation = await waitForSnapshot(refresh.operationId, controller.signal);
      if (operation.state === 'failed') throw new Error('Snapshot failed');
      const workspace = analysisId
        ? await loadAnalysisWorkspace(analysisId, controller.signal)
        : await loadWorkspace(data.pull.repositoryId, data.pull.number, controller.signal);
      setData(workspace);
      setSelectedPath(initialSelectedPath(workspace));
      setSelectedFindingId(null);
      setStatus('ready');
    } catch (error) {
      console.error(error);
      setStatus('error');
    } finally {
      setRefreshing(false);
    }
  };

  const selectedFile = data?.files.find((file) => file.path === selectedPath) ?? data?.files[0];
  const selectedDiff = data?.diff?.files.find((file) => file.path === selectedFile?.path)?.patch;
  const selectedFinding =
    data?.report?.findings.find((finding) => finding.id === selectedFindingId) ??
    data?.report?.findings.find((finding) => finding.priority !== 'P0') ??
    data?.report?.findings[0];
  const coveragePercent = data?.report?.coverage.filesChanged
    ? Math.round((data.report.coverage.filesExamined / data.report.coverage.filesChanged) * 100)
    : 0;
  const addedTestFiles = useMemo(() => analyzeAddedTests(data?.diff?.files ?? []), [data?.diff]);

  const selectFile = (path: string) => {
    setSelectedPath(path);
    setSelectedFindingId(null);
    const url = new URL(window.location.href);
    url.search = '';
    window.history.replaceState(null, '', url);
  };

  const selectFinding = (finding: FindingView) => {
    setSelectedFindingId(finding.id);
    setReviewMode('findings');
    const file = data?.files.find((item) => item.id === finding.anchor.fileId);
    if (file) setSelectedPath(file.path);
    const link = finding.links.find((item) => item.rel === 'finding');
    if (link) window.history.replaceState(null, '', link.href);
  };

  const selectObject = (objectId: string) => {
    setSelectedObjectId(objectId);
    setBottomTool('impact');
    const currentAnalysisId = data?.analysis?.id;
    if (!currentAnalysisId) return;
    const url = new URL(`/reviews/${currentAnalysisId}`, window.location.origin);
    url.searchParams.set('symbol', objectId);
    url.searchParams.set('tool', 'impact');
    window.history.replaceState(null, '', url);
  };

  const selectBottomTool = (tool: BottomTool) => {
    setBottomTool(tool);
    const url = new URL(window.location.href);
    url.searchParams.set('tool', tool);
    window.history.replaceState(null, '', url);
  };

  const handleChatSubmit = async () => {
    if (!chatSession?.model.available || !chatDraft.trim() || chatSending) return;
    const content = chatDraft.trim();
    setChatDraft('');
    setChatSending(true);
    try {
      const response = await sendChatMessage(chatSession.id, content, {
        ...(selectedFinding ? { findingId: selectedFinding.id } : {}),
        ...(selectedFile ? { fileId: selectedFile.id } : {}),
        ...(selectedObjectId ? { symbolId: selectedObjectId } : {}),
      });
      setChatMessages((messages) => [...messages, response.userMessage, response.assistantMessage]);
    } catch (error) {
      console.error(error);
      setChatDraft(content);
    } finally {
      setChatSending(false);
    }
  };
  return (
    <div className="review-page">
      <AppHeader compact />
      <div className="review-context">
        <div className="pr-context">
          <a href="/">{data ? `${data.pull.owner} / ${data.pull.name}` : 'Repository'}</a>
          <ChevronRight size={13} />
          <strong>#{data?.pull.number ?? pullNumber ?? '-'}</strong>
          <span className="context-title">{data?.pull.title ?? 'Pull request'}</span>
        </div>
        <div className="review-actions">
          <span className="analysis-state">
            {data?.report ? <CircleCheck size={14} /> : <Clock3 size={14} />}
            {refreshing
              ? 'Snapshot 준비 중'
              : data?.report
                ? `${data.report.grade} · P2+ ${data.report.findings.filter((finding) => finding.priority === 'P2' || finding.priority === 'P3').length}`
                : data?.analysis
                  ? data.analysis.state === 'queued'
                    ? '분석 대기'
                    : data.analysis.state
                  : '분석 없음'}
          </span>
          <button className="revision-button" type="button">
            Revision {data?.analysis?.revision ?? '-'} <ChevronDown size={13} />
          </button>
          <button
            className="icon-button"
            type="button"
            title="새로고침"
            aria-label="새로고침"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
          >
            <RefreshCw size={16} className={refreshing ? 'spin' : undefined} />
          </button>
          <a
            className={`icon-button${data ? '' : ' disabled'}`}
            title="GHES에서 열기"
            aria-label="GHES에서 열기"
            href={data?.pull.htmlUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={16} />
          </a>
        </div>
      </div>
      <main
        className={`workspace-grid${resizing ? ` is-resizing resize-${resizing}` : ''}`}
        ref={workspaceRef}
        style={
          {
            '--left-panel-width': `${workspaceLayout.leftWidth}px`,
            '--chat-panel-width': `${workspaceLayout.chatWidth}px`,
            '--bottom-panel-height': `${workspaceLayout.bottomHeight}px`,
          } as CSSProperties
        }
      >
        <ReviewSidebar
          data={data}
          status={status}
          mode={reviewMode}
          selectedFileId={selectedFile?.id ?? null}
          selectedFindingId={selectedFindingId}
          selectedObjectId={selectedObjectId}
          coveragePercent={coveragePercent}
          onModeChange={setReviewMode}
          onFileSelect={selectFile}
          onFindingSelect={selectFinding}
          onObjectSelect={selectObject}
        />

        <section className="diff-panel" aria-label="코드 차이">
          <div className="diff-toolbar">
            <div className="file-path">
              <FileCode2 size={15} /> {selectedFile?.path ?? 'Snapshot diff'}
            </div>
            <span className="sha-label">
              merge-base {data?.analysis?.mergeBaseSha?.slice(0, 7) ?? '-------'}
            </span>
            <span className="sha-arrow">→</span>
            <span className="sha-label head">
              head {data?.analysis?.headSha.slice(0, 7) ?? '-------'}
            </span>
            <div className="toolbar-spacer" />
            <div className="segmented" aria-label="Diff 형식">
              <button
                className={diffMode === 'split' ? 'active' : ''}
                type="button"
                onClick={() => setDiffMode('split')}
              >
                Split
              </button>
              <button
                className={diffMode === 'unified' ? 'active' : ''}
                type="button"
                onClick={() => setDiffMode('unified')}
              >
                Unified
              </button>
            </div>
            <button className="icon-button small" type="button" title="최대화" aria-label="최대화">
              <Maximize2 size={14} />
            </button>
          </div>
          <div className={`diff-columns ${diffMode}`}>
            {selectedDiff ? (
              <>
                <CodePane side="base" patch={selectedDiff} />
                <CodePane side="head" patch={selectedDiff} />
              </>
            ) : (
              <div className="diff-empty">
                <GitPullRequest size={20} />
                <span>
                  {status === 'error'
                    ? 'Snapshot을 불러오지 못했습니다.'
                    : '아직 materialized snapshot이 없습니다.'}
                </span>
              </div>
            )}
          </div>
        </section>

        <ChatPanel
          revision={data?.analysis?.revision}
          headSha={data?.pull.headSha}
          selectedFinding={selectedFinding}
          selectedFile={selectedFile?.path}
          model={chatSession?.model ?? null}
          messages={chatMessages}
          draft={chatDraft}
          sending={chatSending}
          onDraftChange={setChatDraft}
          onSend={() => void handleChatSubmit()}
          onCitationSelect={(findingId) => {
            const finding = data?.report?.findings.find((item) => item.id === findingId);
            if (finding) selectFinding(finding);
          }}
        />

        <section className="bottom-panel" aria-label="분석 근거">
          <nav className="bottom-tabs" role="tablist" aria-label="Review tools">
            <button
              className={bottomTool === 'evidence' ? 'active' : ''}
              type="button"
              role="tab"
              aria-selected={bottomTool === 'evidence'}
              onClick={() => selectBottomTool('evidence')}
            >
              <PanelBottom size={14} /> Evidence
            </button>
            <button
              className={bottomTool === 'graph' ? 'active' : ''}
              type="button"
              role="tab"
              aria-selected={bottomTool === 'graph'}
              onClick={() => selectBottomTool('graph')}
            >
              <GitBranch size={14} /> Git graph
            </button>
            <button
              className={bottomTool === 'impact' ? 'active' : ''}
              type="button"
              role="tab"
              aria-selected={bottomTool === 'impact'}
              onClick={() => selectBottomTool('impact')}
            >
              <Activity size={14} /> Impact
            </button>
            <button
              className={bottomTool === 'tests' ? 'active' : ''}
              type="button"
              role="tab"
              aria-selected={bottomTool === 'tests'}
              onClick={() => selectBottomTool('tests')}
            >
              <TestTube2 size={14} /> Tests
            </button>
          </nav>
          {bottomTool === 'evidence' ? (
            <EvidenceContent finding={selectedFinding} headSha={data?.analysis?.headSha} />
          ) : null}
          {bottomTool === 'graph' ? <GitGraphPanel data={data} /> : null}
          {bottomTool === 'impact' ? (
            <ImpactPanel
              data={data}
              selectedObjectId={selectedObjectId}
              onObjectSelect={selectObject}
            />
          ) : null}
          {bottomTool === 'tests' ? (
            <TestsPanel files={addedTestFiles} onFileSelect={selectFile} />
          ) : null}
        </section>
        <WorkspaceResizeHandle
          name="left"
          label="탐색 패널 크기 조절"
          value={workspaceLayout.leftWidth}
          minimum={WORKSPACE_LAYOUT_LIMITS.leftMin}
          maximum={WORKSPACE_LAYOUT_LIMITS.leftMax}
          onPointerDown={startResize}
          onPointerMove={continueResize}
          onPointerEnd={finishResize}
          onKeyboardResize={resizeWithKeyboard}
          onReset={() =>
            setWorkspaceLayout((current) => ({
              ...current,
              leftWidth: DEFAULT_WORKSPACE_LAYOUT.leftWidth,
            }))
          }
        />
        <WorkspaceResizeHandle
          name="chat"
          label="채팅 패널 크기 조절"
          value={workspaceLayout.chatWidth}
          minimum={WORKSPACE_LAYOUT_LIMITS.chatMin}
          maximum={WORKSPACE_LAYOUT_LIMITS.chatMax}
          onPointerDown={startResize}
          onPointerMove={continueResize}
          onPointerEnd={finishResize}
          onKeyboardResize={resizeWithKeyboard}
          onReset={() =>
            setWorkspaceLayout((current) => ({
              ...current,
              chatWidth: DEFAULT_WORKSPACE_LAYOUT.chatWidth,
            }))
          }
        />
        <WorkspaceResizeHandle
          name="bottom"
          label="하단 패널 크기 조절"
          value={workspaceLayout.bottomHeight}
          minimum={WORKSPACE_LAYOUT_LIMITS.bottomMin}
          maximum={Math.max(
            WORKSPACE_LAYOUT_LIMITS.bottomMin,
            workspaceBounds().height - WORKSPACE_LAYOUT_LIMITS.topMin,
          )}
          onPointerDown={startResize}
          onPointerMove={continueResize}
          onPointerEnd={finishResize}
          onKeyboardResize={resizeWithKeyboard}
          onReset={() =>
            setWorkspaceLayout((current) => ({
              ...current,
              bottomHeight: DEFAULT_WORKSPACE_LAYOUT.bottomHeight,
            }))
          }
        />
      </main>
    </div>
  );
}

function WorkspaceResizeHandle({
  name,
  label,
  value,
  minimum,
  maximum,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  onKeyboardResize,
  onReset,
}: {
  name: WorkspaceResizeHandle;
  label: string;
  value: number;
  minimum: number;
  maximum: number;
  onPointerDown: (name: WorkspaceResizeHandle, event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerEnd: (event: PointerEvent<HTMLDivElement>) => void;
  onKeyboardResize: (name: WorkspaceResizeHandle, delta: number) => void;
  onReset: () => void;
}) {
  const horizontal = name === 'bottom';
  return (
    <div
      className={`workspace-resize-handle ${name}`}
      role="separator"
      tabIndex={0}
      title={`${label} (더블클릭으로 초기화)`}
      aria-label={label}
      aria-orientation={horizontal ? 'horizontal' : 'vertical'}
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={value}
      onPointerDown={(event) => onPointerDown(name, event)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const decreaseKey = horizontal ? 'ArrowUp' : 'ArrowLeft';
        const increaseKey = horizontal ? 'ArrowDown' : 'ArrowRight';
        if (event.key === 'Home') {
          event.preventDefault();
          onReset();
        } else if (event.key === decreaseKey || event.key === increaseKey) {
          event.preventDefault();
          const direction = event.key === decreaseKey ? -1 : 1;
          onKeyboardResize(name, direction * (event.shiftKey ? 48 : 16));
        }
      }}
    />
  );
}

function ReviewSidebar({
  data,
  status,
  mode,
  selectedFileId,
  selectedFindingId,
  selectedObjectId,
  coveragePercent,
  onModeChange,
  onFileSelect,
  onFindingSelect,
  onObjectSelect,
}: {
  data: WorkspaceData | null;
  status: 'loading' | 'ready' | 'error';
  mode: ReviewMode;
  selectedFileId: string | null;
  selectedFindingId: string | null;
  selectedObjectId: string | null;
  coveragePercent: number;
  onModeChange: (mode: ReviewMode) => void;
  onFileSelect: (path: string) => void;
  onFindingSelect: (finding: FindingView) => void;
  onObjectSelect: (objectId: string) => void;
}) {
  const report = data?.report;
  const issueFindings = report?.findings.filter((finding) => finding.priority !== 'P0') ?? [];
  const positiveFindings = report?.findings.filter((finding) => finding.priority === 'P0') ?? [];
  const selectedObjects =
    data?.objects.filter((object) => object.definition?.fileId === selectedFileId) ?? [];
  const selfLink = report?.links.find((link) => link.rel === 'self')?.href;
  const markdownLink = report?.links.find((link) => link.rel === 'markdown')?.href;

  return (
    <aside className="left-panel" aria-label="검토 탐색">
      <nav className="side-tabs" aria-label="검토 보기">
        <button
          className={`side-tab ${mode === 'files' ? 'active' : ''}`}
          type="button"
          onClick={() => onModeChange('files')}
        >
          <Files size={15} /> Files
        </button>
        <button
          className={`side-tab ${mode === 'findings' ? 'active' : ''}`}
          type="button"
          onClick={() => onModeChange('findings')}
        >
          <ShieldCheck size={15} /> Findings <span>{issueFindings.length}</span>
        </button>
        <button
          className={`side-tab ${mode === 'outline' ? 'active' : ''}`}
          type="button"
          onClick={() => onModeChange('outline')}
        >
          <Braces size={15} /> Outline
        </button>
        <button
          className={`side-tab ${mode === 'impact' ? 'active' : ''}`}
          type="button"
          onClick={() => onModeChange('impact')}
        >
          <Network size={15} /> Impact
        </button>
      </nav>

      {mode === 'files' ? (
        <>
          <div className="panel-heading">
            <span>CHANGED FILES</span>
            <span>{data?.files.length ?? 0}</span>
          </div>
          <div className="file-tree">
            {data?.files.map((file) => (
              <button
                className={`tree-row file top-file ${file.id === selectedFileId ? 'active' : ''}`}
                type="button"
                key={file.id}
                onClick={() => onFileSelect(file.path)}
              >
                {file.path.includes('test') ? <TestTube2 size={14} /> : <FileCode2 size={14} />}
                {file.path}
                <span>
                  +{file.additions ?? '-'} −{file.deletions ?? '-'}
                </span>
              </button>
            ))}
            {status === 'loading' ? (
              <div className="panel-empty">Snapshot을 확인하는 중...</div>
            ) : null}
            {status === 'ready' && !data?.files.length ? (
              <div className="panel-empty">새로고침하여 snapshot을 준비하세요.</div>
            ) : null}
          </div>
        </>
      ) : null}

      {mode === 'findings' ? (
        <div className="review-list">
          <div className="panel-heading review-list-heading">
            <span>REPORT</span>
            <span className="panel-actions">
              <button
                className="icon-button small"
                type="button"
                title="Report 링크 복사"
                aria-label="Report 링크 복사"
                disabled={!selfLink}
                onClick={() => selfLink && void navigator.clipboard.writeText(selfLink)}
              >
                <Clipboard size={13} />
              </button>
              <a
                className={`icon-button small${markdownLink ? '' : ' disabled'}`}
                href={markdownLink}
                title="Markdown 다운로드"
                aria-label="Markdown 다운로드"
              >
                <Download size={13} />
              </a>
            </span>
          </div>
          {report ? (
            <>
              <div className="report-summary">
                <strong>{report.grade}</strong>
                <p>{report.summary}</p>
                <span>
                  {report.coverage.filesExamined}/{report.coverage.filesChanged} files ·{' '}
                  {report.durationMs}ms
                </span>
              </div>
              <div className="per-file-list">
                {report.perFileSummaries.map((summary) => {
                  const file = data?.files.find((item) => item.id === summary.fileId);
                  return (
                    <button
                      type="button"
                      key={summary.fileId}
                      onClick={() => file && onFileSelect(file.path)}
                    >
                      <b>{summary.priority}</b>
                      <span>{file?.path ?? 'file'}</span>
                      <small>{summary.summary}</small>
                    </button>
                  );
                })}
              </div>
              <div className="panel-heading">
                <span>ACTIONABLE</span>
                <span>{issueFindings.length}</span>
              </div>
              {issueFindings.map((finding) => (
                <FindingRow
                  key={finding.id}
                  finding={finding}
                  path={data?.files.find((file) => file.id === finding.anchor.fileId)?.path}
                  active={finding.id === selectedFindingId}
                  onSelect={onFindingSelect}
                />
              ))}
              {positiveFindings.length ? (
                <div className="panel-heading positive-heading">
                  <span>좋았던 점</span>
                  <ThumbsUp size={12} />
                </div>
              ) : null}
              {positiveFindings.map((finding) => (
                <FindingRow
                  key={finding.id}
                  finding={finding}
                  path={data?.files.find((file) => file.id === finding.anchor.fileId)?.path}
                  active={finding.id === selectedFindingId}
                  onSelect={onFindingSelect}
                />
              ))}
            </>
          ) : (
            <div className="panel-empty">아직 publish된 report가 없습니다.</div>
          )}
        </div>
      ) : null}

      {mode === 'outline' ? (
        <div className="review-list">
          <div className="panel-heading">
            <span>CODE OBJECTS</span>
            <span>{selectedObjects.length}</span>
          </div>
          {selectedObjects.map((object) => (
            <button
              className={`object-row ${object.id === selectedObjectId ? 'active' : ''}`}
              type="button"
              key={object.id}
              onClick={() => onObjectSelect(object.id)}
            >
              <Braces size={13} />
              <span>{object.qualifiedName.split('#').at(-1)}</span>
              <small>{object.kind}</small>
            </button>
          ))}
          {!selectedObjects.length ? (
            <div className="panel-empty">선택한 file에서 확인된 symbol이 없습니다.</div>
          ) : null}
        </div>
      ) : null}

      {mode === 'impact' ? (
        <div className="review-list">
          <div className="panel-heading">
            <span>DIRECT IMPACT</span>
            <span>{report?.impact.affectedAreas.length ?? 0}</span>
          </div>
          <p className="impact-summary">{report?.impact.summary ?? 'Impact 분석 대기 중'}</p>
          {report?.impact.affectedAreas.map((area) => {
            const object = data?.objects.find((item) => item.id === area.objectId);
            return (
              <button
                className={`impact-row ${area.objectId === selectedObjectId ? 'active' : ''}`}
                type="button"
                key={area.objectId}
                onClick={() => onObjectSelect(area.objectId)}
              >
                <Network size={13} />
                <span>{object?.qualifiedName ?? 'Code object'}</span>
                <small>{area.risk}</small>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="coverage-strip">
        <span>Coverage</span>
        <strong>{coveragePercent}%</strong>
        <div>
          <i style={{ width: `${coveragePercent}%` }} />
        </div>
      </div>
    </aside>
  );
}

function FindingRow({
  finding,
  path,
  active,
  onSelect,
}: {
  finding: FindingView;
  path: string | undefined;
  active: boolean;
  onSelect: (finding: FindingView) => void;
}) {
  return (
    <button
      className={`finding-row ${active ? 'active' : ''} ${finding.priority === 'P0' ? 'positive' : ''}`}
      type="button"
      onClick={() => onSelect(finding)}
    >
      <b>{finding.priority}</b>
      <span>{finding.title}</span>
      <small>
        {path ?? 'file'}:{finding.anchor.startLine ?? 1} · {finding.category}
      </small>
    </button>
  );
}

function ChatPanel({
  revision,
  headSha,
  selectedFinding,
  selectedFile,
  model,
  messages,
  draft,
  sending,
  onDraftChange,
  onSend,
  onCitationSelect,
}: {
  revision: number | null | undefined;
  headSha: string | undefined;
  selectedFinding: FindingView | undefined;
  selectedFile: string | undefined;
  model: ChatSession['model'] | null;
  messages: ChatMessage[];
  draft: string;
  sending: boolean;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onCitationSelect: (findingId: string) => void;
}) {
  return (
    <aside className="chat-panel" aria-label="분석 대화">
      <div className="chat-heading">
        <span>
          <Bot size={15} /> Review chat
        </span>
        <span className="chat-revision">R{revision ?? '-'} locked</span>
      </div>
      <div className="chat-scope" title={selectedFinding?.title ?? selectedFile}>
        <Link2 size={12} />
        <span>{selectedFinding?.title ?? selectedFile ?? '전체 report'}</span>
        <code>{headSha?.slice(0, 7) ?? '-------'}</code>
      </div>
      <div className="chat-messages" aria-live="polite">
        {!model ? (
          <div className="chat-message-empty">Chat 연결 상태를 확인하는 중입니다.</div>
        ) : null}
        {model && !model.available ? (
          <div className="chat-unavailable">
            <Bot size={22} />
            <strong>Chat 모델이 연결되지 않았습니다.</strong>
            <span>이 revision의 report와 evidence는 계속 확인할 수 있습니다.</span>
          </div>
        ) : null}
        {model?.available && messages.length === 0 ? (
          <div className="chat-message-empty">아직 대화가 없습니다.</div>
        ) : null}
        {model?.available
          ? messages.map((message) => (
              <article className={`chat-message ${message.role}`} key={message.id}>
                <div className="message-author">
                  {message.role === 'assistant' ? <Sparkles size={12} /> : null}
                  <strong>{message.role === 'assistant' ? 'Review assistant' : 'You'}</strong>
                  {message.status !== 'completed' ? <small>{message.status}</small> : null}
                </div>
                <div className="chat-message-content">{message.content}</div>
                {message.citations.length > 0 ? (
                  <div className="chat-citations" aria-label="답변 근거">
                    {message.citations.map((citation) => (
                      <button
                        type="button"
                        key={citation.evidenceId}
                        disabled={!citation.findingId}
                        onClick={() => citation.findingId && onCitationSelect(citation.findingId)}
                      >
                        <Link2 size={11} /> {citation.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </article>
            ))
          : null}
        {model?.available && sending ? (
          <div className="chat-pending">
            <RefreshCw size={13} className="spin" /> 답변을 생성하는 중입니다.
          </div>
        ) : null}
      </div>
      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <textarea
          rows={3}
          value={draft}
          maxLength={4_000}
          placeholder={
            model?.available
              ? '현재 리비전에 대해 질문'
              : 'Chat 모델을 연결한 후 질문할 수 있습니다.'
          }
          aria-label="질문"
          disabled={!model?.available}
          onChange={(event) => onDraftChange(event.target.value)}
        />
        <div className="composer-actions">
          <span>{draft.length}/4000</span>
          <button
            className="send-button"
            type="submit"
            title="질문 보내기"
            aria-label="질문 보내기"
            disabled={!model?.available || !draft.trim() || sending}
          >
            <Send size={14} />
          </button>
        </div>
      </form>
    </aside>
  );
}

function GitGraphPanel({ data }: { data: WorkspaceData | null }) {
  if (!data?.analysis) {
    return <div className="panel-empty bottom-tool-empty">표시할 snapshot commit이 없습니다.</div>;
  }
  const commits = [...data.commits].reverse();
  const mergeBase = data.analysis.mergeBaseSha;
  const baseDiverged = Boolean(mergeBase && data.pull.baseSha !== mergeBase);
  return (
    <div className="bottom-tool-content git-graph-panel">
      <div className="tool-summary-row">
        <strong>Revision graph</strong>
        <span>
          {data.pull.baseRef} → {data.pull.headRef} · PR commit {commits.length}개
        </span>
      </div>
      <div className="git-graph-list" aria-label="Pull request Git graph">
        <div className="git-graph-row base-node">
          <span className="graph-rail">
            <i />
          </span>
          <code>{mergeBase?.slice(0, 7) ?? '-------'}</code>
          <span className="graph-commit-copy">
            <strong>merge-base</strong>
            <small>
              {data.pull.baseRef}와 {data.pull.headRef}의 공통 기준
            </small>
          </span>
        </div>
        {baseDiverged ? (
          <div className="git-graph-row base-tip">
            <span className="graph-rail">
              <i />
            </span>
            <code>{data.pull.baseSha.slice(0, 7)}</code>
            <span className="graph-commit-copy">
              <strong>{data.pull.baseRef}</strong>
              <small>관측된 base tip</small>
            </span>
          </div>
        ) : null}
        {commits.map((commit, index) => (
          <div className="git-graph-row head-node" key={commit.sha}>
            <span className="graph-rail">
              <i />
            </span>
            <code>{commit.sha.slice(0, 7)}</code>
            <span className="graph-commit-copy">
              <strong>{commit.subject}</strong>
              <small>
                {commit.author}
                {index === commits.length - 1 ? ` · ${data.pull.headRef} HEAD` : ''}
              </small>
            </span>
          </div>
        ))}
        {commits.length === 0 ? (
          <div className="git-graph-row head-node">
            <span className="graph-rail">
              <i />
            </span>
            <code>{data.pull.headSha.slice(0, 7)}</code>
            <span className="graph-commit-copy">
              <strong>{data.pull.headRef} HEAD</strong>
              <small>commit metadata가 없는 snapshot</small>
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ImpactPanel({
  data,
  selectedObjectId,
  onObjectSelect,
}: {
  data: WorkspaceData | null;
  selectedObjectId: string | null;
  onObjectSelect: (objectId: string) => void;
}) {
  const impact = data?.report?.impact;
  if (!impact) {
    return <div className="panel-empty bottom-tool-empty">표시할 impact 분석이 없습니다.</div>;
  }
  return (
    <div className="bottom-tool-content impact-panel-content">
      <div className="tool-summary-row">
        <strong>{impact.summary}</strong>
        <span>
          confidence {impact.confidence} · coverage {impact.coverage.objectsExamined} objects
        </span>
      </div>
      <div className="impact-list">
        {impact.affectedAreas.map((area) => {
          const object = data.objects.find((item) => item.id === area.objectId);
          return (
            <button
              className={area.objectId === selectedObjectId ? 'active' : ''}
              type="button"
              key={area.objectId}
              onClick={() => onObjectSelect(area.objectId)}
            >
              <span className={`risk-label risk-${area.risk}`}>{area.risk}</span>
              <span>
                <strong>{object?.qualifiedName ?? 'Unknown object'}</strong>
                <small>{area.reason}</small>
              </span>
              <span className="impact-meta">
                {object?.kind ?? 'object'} · evidence {area.evidence.length}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TestsPanel({
  files,
  onFileSelect,
}: {
  files: AddedTestFile[];
  onFileSelect: (path: string) => void;
}) {
  if (files.length === 0) {
    return <div className="panel-empty bottom-tool-empty">추가된 test 코드를 찾지 못했습니다.</div>;
  }
  const caseCount = files.reduce((total, file) => total + file.cases.length, 0);
  const assertionCount = files.reduce(
    (total, file) =>
      total + file.cases.reduce((caseTotal, testCase) => caseTotal + testCase.assertionCount, 0),
    0,
  );
  return (
    <div className="bottom-tool-content tests-panel-content">
      <div className="tool-summary-row">
        <strong>추가된 test 파일 {files.length}개</strong>
        <span>
          test case {caseCount}개 · 기대 조건 {assertionCount}개
        </span>
      </div>
      <div className="test-file-list">
        {files.map((file) => (
          <section className="test-file" key={file.path}>
            <button
              className="test-file-heading"
              type="button"
              onClick={() => onFileSelect(file.path)}
            >
              <TestTube2 size={14} />
              <span>
                <strong>{file.path}</strong>
                <small>{file.summary}</small>
              </span>
              <code>+{file.additions}</code>
            </button>
            {file.cases.map((testCase) => (
              <button
                className="test-case-row"
                type="button"
                key={`${file.path}:${testCase.line}:${testCase.title}`}
                onClick={() => onFileSelect(file.path)}
              >
                <span className="test-case-line">L{testCase.line}</span>
                <span>
                  <strong>{testCase.title}</strong>
                  <small>{testCase.explanation}</small>
                </span>
                {testCase.suite ? <span className="test-suite">{testCase.suite}</span> : null}
              </button>
            ))}
            {!file.patchAvailable ? (
              <div className="test-patch-missing">
                상세 patch가 없는 immutable snapshot이라 case 단위 설명을 만들 수 없습니다.
              </div>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );
}

function EvidenceContent({
  finding,
  headSha,
}: {
  finding: FindingView | undefined;
  headSha: string | undefined;
}) {
  if (!finding) {
    return <div className="panel-empty evidence-empty">표시할 verified evidence가 없습니다.</div>;
  }
  const ghesLink = finding.links.find((link) => link.rel === 'ghes' && link.available);
  return (
    <div className="evidence-content">
      <div className={`severity-mark priority-${finding.priority.toLowerCase()}`}>
        {finding.priority}
      </div>
      <div>
        <strong>{finding.title}</strong>
        <p>{finding.problem}</p>
        <p className="recommendation">{finding.recommendation}</p>
      </div>
      <div className="evidence-facts">
        <span>
          <GitCommitHorizontal size={13} /> {headSha?.slice(0, 7) ?? '-------'}
        </span>
        <span>
          <CircleCheck size={13} />
          {finding.verification.status === 'verified' ? '직접 근거' : '제한된 근거'}
        </span>
        <span>신뢰도 {finding.confidence}</span>
        {ghesLink ? (
          <a href={ghesLink.href} target="_blank" rel="noreferrer">
            <ExternalLink size={12} /> GHES
          </a>
        ) : null}
      </div>
    </div>
  );
}

type DiffLine = {
  content: string;
  kind: 'context' | 'added' | 'removed' | 'placeholder' | 'hunk';
  number: number | null;
};

function CodePane({ side, patch }: { side: 'base' | 'head'; patch: string }) {
  const lines = splitPatch(patch)[side];
  return (
    <div className={`code-pane ${side}`}>
      <div className="pane-label">{side === 'base' ? 'MERGE BASE' : 'HEAD'}</div>
      <pre>
        {lines.map((line, index) => (
          <span className={line.kind} key={`${side}-${index}`}>
            <i>{line.number ?? ''}</i>
            <code>{line.content || ' '}</code>
          </span>
        ))}
      </pre>
    </div>
  );
}

function splitPatch(patch: string): { base: DiffLine[]; head: DiffLine[] } {
  const base: DiffLine[] = [];
  const head: DiffLine[] = [];
  const source = patch.split('\n');
  let baseLine = 0;
  let headLine = 0;

  for (let index = 0; index < source.length; index += 1) {
    const line = source[index] ?? '';
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      baseLine = Number(hunk[1]);
      headLine = Number(hunk[2]);
      const entry = { content: line, kind: 'hunk' as const, number: null };
      base.push(entry);
      head.push(entry);
      continue;
    }
    if (baseLine === 0 && headLine === 0) continue;

    if (line.startsWith('-')) {
      const removed: string[] = [];
      while ((source[index] ?? '').startsWith('-')) {
        removed.push((source[index] ?? '').slice(1));
        index += 1;
      }
      const added: string[] = [];
      while ((source[index] ?? '').startsWith('+')) {
        added.push((source[index] ?? '').slice(1));
        index += 1;
      }
      index -= 1;
      const rowCount = Math.max(removed.length, added.length);
      for (let row = 0; row < rowCount; row += 1) {
        base.push(
          removed[row] === undefined
            ? { content: '', kind: 'placeholder', number: null }
            : { content: removed[row]!, kind: 'removed', number: baseLine++ },
        );
        head.push(
          added[row] === undefined
            ? { content: '', kind: 'placeholder', number: null }
            : { content: added[row]!, kind: 'added', number: headLine++ },
        );
      }
      continue;
    }
    if (line.startsWith('+')) {
      base.push({ content: '', kind: 'placeholder', number: null });
      head.push({ content: line.slice(1), kind: 'added', number: headLine++ });
      continue;
    }
    if (line.startsWith(' ') || line === '') {
      const content = line.startsWith(' ') ? line.slice(1) : '';
      base.push({ content, kind: 'context', number: baseLine++ });
      head.push({ content, kind: 'context', number: headLine++ });
    }
  }
  if (base.length === 0) {
    const empty = { content: 'No textual diff available', kind: 'hunk' as const, number: null };
    base.push(empty);
    head.push(empty);
  }
  return { base, head };
}

function initialSelectedPath(workspace: WorkspaceData): string | null {
  return (
    workspace.diff?.files.find((file) => file.patch.includes('@@'))?.path ??
    workspace.files[0]?.path ??
    null
  );
}
