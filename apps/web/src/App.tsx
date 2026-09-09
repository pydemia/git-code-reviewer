import {
  Activity,
  Brain,
  Braces,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  ExternalLink,
  FileCode2,
  Files,
  GitBranch,
  GitPullRequest,
  Maximize2,
  Network,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  TestTube2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { reviewGrades, reviewStatusLabels, pullRequestStateFilterSchema } from '@gcr/contracts';
import {
  loadAnalysisWorkspace,
  loadChatAccounts,
  loadWorklist,
  loadWorkspace,
  loadAnalysisStatus,
  openChatSession,
  refreshPull,
  sendChatMessage,
  waitForSnapshot,
  type ChatMessage,
  type ChatAccountCatalog,
  type ChatSession,
  type WorklistItem,
  type WorkspaceData,
  type User,
  loadCurrentUser,
} from './api.ts';
import { AdminPage } from './AdminPage.tsx';
import { AppHeader } from './AppHeader.tsx';
import { GuidePage } from './GuidePage.tsx';
import { ProductDocumentPage } from './ProductDocumentPage.tsx';
import { LoginPage } from './LoginPage.tsx';
import { ProfilePage } from './ProfilePage.tsx';
import { FileTree } from './FileTree.tsx';
import { ReviewReportPanel } from './ReviewReportPanel.tsx';
import { ReviewGrade } from './ReviewGrade.tsx';
import { PullRequestFilters, PullRequestState } from './PullRequestFilters.tsx';
import { ChatPanel } from './ChatPanel.tsx';
import { ChatRunActivity, SourceEvidenceView } from './ChatRunActivity.tsx';
import { ChatRunHistory } from './ChatRunHistory.tsx';
import { useInteractiveChat } from './use-interactive-chat.ts';
import { sourceEvidenceSchema, type SourceEvidence } from '@gcr/contracts';
import { resolveChatCitation } from './chat-citations.ts';
import { ReviewDiff, type CodeTarget } from './ReviewDiff.tsx';
import { firstChangedLine } from './review-diff.ts';
import { analysisIsPending, analysisProgressLabel } from './analysis-progress.ts';
import { analyzeAddedTests, type AddedTestFile } from './test-analysis.ts';
import { ReviewMemoryPanel } from './ReviewMemoryPanel.tsx';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  WORKSPACE_LAYOUT_LIMITS,
  constrainWorkspaceLayout,
  parseWorkspaceLayout,
  migrateWorkspaceLayout,
  resizeWorkspaceLayout,
  type WorkspaceLayout,
  type WorkspaceResizeHandle,
} from './workspace-layout.ts';

type ReviewMode = 'files' | 'outline' | 'impact';
type MainView = 'code' | 'summary';
type BottomTool = 'comments' | 'graph' | 'impact' | 'tests' | 'memory';
type FindingView = NonNullable<WorkspaceData['report']>['findings'][number];
type ResizeOperation = {
  handle: WorkspaceResizeHandle;
  pointerId: number;
  startX: number;
  startY: number;
  layout: WorkspaceLayout;
};

const WORKSPACE_LAYOUT_STORAGE_KEY = 'git-code-reviewer.workspace-layout.v2';
const WORKLIST_TENANT_STORAGE_KEY = 'git-code-reviewer.worklist-tenant.v1';
const RESPONSIVE_LAYOUT_BREAKPOINT = 820;

function isBottomTool(value: string | null): value is BottomTool {
  return (
    value === 'comments' ||
    value === 'graph' ||
    value === 'impact' ||
    value === 'tests' ||
    value === 'memory'
  );
}

export function App() {
  if (window.location.pathname === '/login') return <LoginPage />;
  if (window.location.pathname === '/introduction')
    return <ProductDocumentPage documentId="introduction" />;
  if (window.location.pathname === '/features')
    return <ProductDocumentPage documentId="features" />;
  if (window.location.pathname === '/guide') return <GuidePage />;
  if (window.location.pathname === '/profile') return <ProfilePage />;
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
  const [pullState, setPullState] = useState(() => {
    const value = pullRequestStateFilterSchema.safeParse(
      new URLSearchParams(window.location.search).get('state'),
    );
    return value.success ? value.data : 'open';
  });
  const [user, setUser] = useState<User | null>(null);
  const [selectedTenantId, setSelectedTenantId] = useState(
    () => window.localStorage.getItem(WORKLIST_TENANT_STORAGE_KEY) ?? '',
  );
  const [state, setState] = useState<{
    status: 'loading' | 'ready' | 'error';
    items: WorklistItem[];
    counts: { open: number; closed: number; all: number } | null;
    syncErrors: number;
    pendingSync: number;
  }>({ status: 'loading', items: [], counts: null, syncErrors: 0, pendingSync: 0 });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading', items: [], counts: null, syncErrors: 0, pendingSync: 0 });
    void loadCurrentUser(controller.signal)
      .then((currentUser) => {
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const tenantId = currentUser.tenants.some((tenant) => tenant.id === selectedTenantId)
          ? selectedTenantId
          : (currentUser.tenants[0]?.id ?? '');
        setUser(currentUser);
        if (tenantId !== selectedTenantId) setSelectedTenantId(tenantId);
        if (tenantId) window.localStorage.setItem(WORKLIST_TENANT_STORAGE_KEY, tenantId);
        return loadWorklist(controller.signal, tenantId || undefined, pullState);
      })
      .then(
        (result) => {
          if (!controller.signal.aborted) setState({ status: 'ready', ...result });
        },
        (error: unknown) => {
          if (!controller.signal.aborted) {
            console.error(error);
            setState({ status: 'error', items: [], counts: null, syncErrors: 0, pendingSync: 0 });
          }
        },
      );
    return () => controller.abort();
  }, [reloadToken, selectedTenantId, pullState]);

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
            <h1>Pull requests</h1>
          </div>
          <button
            className="command-button"
            type="button"
            onClick={() => setReloadToken((value) => value + 1)}
            disabled={state.status === 'loading'}
          >
            <RefreshCw size={15} />
            {state.status === 'loading' ? '불러오는 중' : '새로고침'}
          </button>
        </div>
        <p className="worklist-sync-help" id="closed-filter-help">
          Closed에는 Merged가 포함됩니다. GitHub 상태는 repository polling 주기에 따라 갱신됩니다.
        </p>
        {state.syncErrors > 0 ? (
          <p className="worklist-sync-warning" role="status">
            {state.syncErrors}개 repository의 동기화에 실패해 마지막 수집 상태를 표시합니다.
            관리자에게 연결·Polling 설정 확인을 요청하세요.
          </p>
        ) : null}
        {state.pendingSync > 0 ? (
          <p className="worklist-sync-help" role="status">
            {state.pendingSync}개 repository는 최초 동기화를 기다리고 있습니다.
          </p>
        ) : null}
        <PullRequestFilters
          value={pullState}
          counts={state.counts}
          onChange={(value) => {
            const url = new URL(window.location.href);
            url.searchParams.set('state', value);
            window.history.replaceState(null, '', url);
            setPullState(value);
          }}
        />
        <section
          className="pr-table"
          aria-label="Pull request 목록"
          aria-busy={state.status === 'loading'}
        >
          <div className="pr-table-head">
            <span>Pull request</span>
            <span>PR 상태</span>
            <span>검토 평가</span>
            <span>업데이트</span>
          </div>
          {state.items.map((pr) => (
            <a
              className="pr-row"
              href={
                pr.latestAnalysisId
                  ? `/reviews/${pr.latestAnalysisId}`
                  : pr.state === 'closed'
                    ? pr.htmlUrl
                    : `/repositories/${pr.repository.id}/pulls/${pr.number}`
              }
              target={pr.state === 'closed' && !pr.latestAnalysisId ? '_blank' : undefined}
              rel={
                pr.state === 'closed' && !pr.latestAnalysisId ? 'noopener noreferrer' : undefined
              }
              key={pr.id}
            >
              <span className="pr-primary">
                <span className="pr-title">{pr.title}</span>
                <span className="pr-meta">
                  {pr.repository.owner}/{pr.repository.name} #{pr.number} · {pr.author}
                  {pr.state === 'closed' && !pr.latestAnalysisId ? (
                    <>
                      {' · GitHub에서 보기 '}
                      <ExternalLink size={11} aria-hidden="true" />
                    </>
                  ) : null}
                </span>
              </span>
              <span className="status-cell">
                <PullRequestState
                  state={pr.state}
                  draft={pr.draft}
                  mergedAt={pr.mergedAt ?? null}
                />
              </span>
              <span className="risk-cell">
                {pr.grade ? (
                  <>
                    <ReviewGrade grade={pr.grade} />
                    <span className={pr.attentionCount > 0 ? 'review-attention' : undefined}>
                      P2+ {pr.attentionCount}
                    </span>
                  </>
                ) : pr.analysisState ? (
                  formatAnalysisState(pr.analysisState)
                ) : (
                  '미분석'
                )}
              </span>
              <span className="muted-cell">{formatRelativeTime(pr.updatedAt)}</span>
            </a>
          ))}
          {state.status === 'loading' ? (
            <div className="table-state" role="status">
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
              <GitPullRequest size={16} />{' '}
              {pullState === 'open'
                ? 'Open PR이 없습니다.'
                : pullState === 'closed'
                  ? 'Closed 또는 Merged PR이 없습니다.'
                  : '수집된 PR이 없습니다.'}
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
  if (state === 'queued') return '분석 대기';
  if (state === 'analyzing') return '분석 중';
  if (state === 'completed') return '분석 완료';
  if (state === 'failed') return '분석 실패';
  if (state === 'partial') return '분석 완료 · 제한 있음';
  if (state === 'cancelled') return '분석 취소';
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
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [codeTarget, setCodeTarget] = useState<CodeTarget | null>(null);
  const [reviewMode, setReviewMode] = useState<ReviewMode>('files');
  const [mainView, setMainView] = useState<MainView>('code');
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [bottomTool, setBottomTool] = useState<BottomTool>('comments');
  const [chatSession, setChatSession] = useState<ChatSession | null>(null);
  const [chatAccounts, setChatAccounts] = useState<ChatAccountCatalog | null>(null);
  const [chatAccountsStatus, setChatAccountsStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [chatAccountsRevision, setChatAccountsRevision] = useState(0);
  const [progressError, setProgressError] = useState(false);
  const [chatAccountId, setChatAccountId] = useState('');
  const [chatModelName, setChatModelName] = useState('');
  const [chatEffort, setChatEffort] = useState('');
  const [chatSelectionRevision, setChatSelectionRevision] = useState(0);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const draftKey = user && chatSession ? `gcr.chat-draft:${user.id}:${chatSession.id}` : '';
  const [draftState, setDraftState] = useState({ key: '', content: '' });
  const chatDraft = draftState.key === draftKey ? draftState.content : '';
  const setChatDraft = (content: string) => {
    setDraftState({ key: draftKey, content });
    try {
      if (draftKey) window.sessionStorage.setItem(draftKey, content);
    } catch {
      return;
    }
  };
  useEffect(() => {
    try {
      setDraftState({
        key: draftKey,
        content: draftKey ? (window.sessionStorage.getItem(draftKey) ?? '') : '',
      });
    } catch {
      setDraftState({ key: draftKey, content: '' });
    }
  }, [draftKey]);
  const [chatSending, setChatSending] = useState(false);
  const agentChat = useInteractiveChat(chatSession?.id, setChatMessages);
  const [sourceEvidence, setSourceEvidence] = useState<SourceEvidence | null>(null);
  const [sourceError, setSourceError] = useState('');
  const sourceRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    setSourceEvidence(null);
    setSourceError('');
    return () => sourceRequest.current?.abort();
  }, [chatSession?.id]);
  const [diffMode, setDiffMode] = useState<'split' | 'unified'>(() =>
    window.innerWidth <= 760 ? 'unified' : 'split',
  );
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 760px)');
    const useUnified = () => {
      if (narrow.matches) setDiffMode('unified');
    };
    narrow.addEventListener('change', useUnified);
    return () => narrow.removeEventListener('change', useUnified);
  }, []);
  const [workspaceLayout, setWorkspaceLayout] = useState(() => {
    try {
      const stored = window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
      return stored !== null
        ? parseWorkspaceLayout(stored)
        : migrateWorkspaceLayout(
            window.localStorage.getItem('git-code-reviewer.workspace-layout.v1'),
          );
    } catch {
      return DEFAULT_WORKSPACE_LAYOUT;
    }
  });
  const [leftHidden, setLeftHidden] = useState(false);
  const [layoutBounds, setLayoutBounds] = useState({
    width: window.innerWidth,
    height: window.innerHeight - 86,
  });
  const visibleLayout = constrainWorkspaceLayout(workspaceLayout, layoutBounds, leftHidden);
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
      layout: visibleLayout,
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
      resizeWorkspaceLayout(
        operation.layout,
        operation.handle,
        delta,
        workspaceBounds(),
        leftHidden,
      ),
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
      resizeWorkspaceLayout(
        constrainWorkspaceLayout(current, workspaceBounds(), leftHidden),
        handle,
        delta,
        workspaceBounds(),
        leftHidden,
      ),
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
      // 화면 축소 때문에 사용자의 저장된 크기를 덮어쓰지 않습니다.
      setLayoutBounds({ width: entry.contentRect.width, height: entry.contentRect.height });
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
    setStatus('loading');
    const workspaceRequest = analysisId
      ? loadAnalysisWorkspace(analysisId, controller.signal)
      : repositoryId && pullNumber
        ? loadWorkspace(repositoryId, pullNumber, controller.signal)
        : Promise.reject(new Error('Review target is missing'));
    void Promise.all([loadCurrentUser(controller.signal), workspaceRequest]).then(
      ([currentUser, workspace]) => {
        setUser(currentUser);
        setData(workspace);
        const search = new URLSearchParams(window.location.search);
        const requestedFindingId = search.get('finding');
        const requestedFinding = workspace.report?.findings.find(
          (finding) => finding.id === requestedFindingId,
        );
        setSelectedFindingId(requestedFinding?.id ?? null);
        setCodeTarget(requestedFinding ? { ...requestedFinding.anchor, request: 0 } : null);
        setReviewMode('files');
        setMainView('code');
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
          requestedTool === 'evidence'
            ? 'comments'
            : isBottomTool(requestedTool)
              ? requestedTool
              : requestedObject
                ? 'impact'
                : 'comments',
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

  const currentAnalysisId = data?.analysis?.id;
  const currentAnalysisState = data?.analysis?.state;
  const currentRepositoryId = data?.pull.repositoryId;
  const currentPullNumber = data?.pull.number;
  useEffect(() => {
    if (
      !currentRepositoryId ||
      !currentPullNumber ||
      ['completed', 'partial', 'failed', 'cancelled'].includes(currentAnalysisState ?? '')
    )
      return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (currentAnalysisId) {
          const next = await loadAnalysisStatus(currentAnalysisId, controller.signal);
          if (next.analysis.state === 'completed' || next.analysis.state === 'partial') {
            const workspace = await loadAnalysisWorkspace(currentAnalysisId, controller.signal);
            if (!controller.signal.aborted) setData(workspace);
          } else if (!controller.signal.aborted) {
            setData((current) =>
              current?.analysis?.id === currentAnalysisId
                ? { ...current, analysis: next.analysis }
                : current,
            );
          }
        } else {
          const workspace = await loadWorkspace(
            currentRepositoryId,
            currentPullNumber,
            controller.signal,
          );
          if (!controller.signal.aborted) {
            setData(workspace);
            setSelectedPath((current) => current ?? initialSelectedPath(workspace));
          }
        }
        if (!controller.signal.aborted) setProgressError(false);
      } catch {
        if (!controller.signal.aborted) setProgressError(true);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
      }
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [currentAnalysisId, currentAnalysisState, currentRepositoryId, currentPullNumber]);

  useEffect(() => {
    const refreshAccounts = () => setChatAccountsRevision((value) => value + 1);
    window.addEventListener('focus', refreshAccounts);
    return () => window.removeEventListener('focus', refreshAccounts);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setChatAccountsStatus('loading');
    void loadChatAccounts(controller.signal).then(
      (catalog) => {
        if (controller.signal.aborted) return;
        setChatAccounts(catalog);
        setChatAccountsStatus('ready');
        const account = catalog.items[0];
        const model = account?.models[0];
        setChatAccountId((current) => current || account?.id || '');
        setChatModelName((current) => current || model?.id || '');
        setChatEffort((current) => current || model?.defaultEffort || '');
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          console.error(error);
          setChatAccountsStatus('error');
        }
      },
    );
    return () => controller.abort();
  }, [chatAccountsRevision]);

  useEffect(() => {
    const currentAnalysisId = data?.analysis?.id;
    if (!currentAnalysisId || !data?.report || !chatAccounts) return;
    if (chatAccounts.enabled && (!chatAccountId || !chatModelName || !chatEffort)) {
      setChatSession(null);
      setChatMessages([]);
      return;
    }
    const controller = new AbortController();
    void openChatSession(
      currentAnalysisId,
      chatAccounts.enabled
        ? {
            accountId: chatAccountId,
            modelName: chatModelName,
            reasoningEffort: chatEffort,
            newSession: chatSelectionRevision > 0,
          }
        : {},
      controller.signal,
    ).then(
      ({ session, messages }) => {
        if (controller.signal.aborted) return;
        setChatSession(session);
        setChatMessages(messages);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) console.error(error);
      },
    );
    return () => controller.abort();
  }, [
    chatAccountId,
    chatAccounts,
    chatEffort,
    chatModelName,
    chatSelectionRevision,
    data?.analysis?.id,
    data?.report,
  ]);

  const selectedChatAccount = chatAccounts?.items.find((item) => item.id === chatAccountId);

  const selectChatAccount = (accountId: string) => {
    const account = chatAccounts?.items.find((item) => item.id === accountId);
    const model = account?.models[0];
    setChatAccountId(accountId);
    setChatModelName(model?.id ?? '');
    setChatEffort(model?.defaultEffort ?? '');
    setChatSelectionRevision((value) => value + 1);
  };

  const selectChatModel = (modelName: string) => {
    const model = selectedChatAccount?.models.find((item) => item.id === modelName);
    setChatModelName(modelName);
    setChatEffort(model?.defaultEffort ?? '');
    setChatSelectionRevision((value) => value + 1);
  };

  const selectChatEffort = (effort: string) => {
    setChatEffort(effort);
    setChatSelectionRevision((value) => value + 1);
  };

  const handleRefresh = async () => {
    if (!data) return;
    setRefreshing(true);
    const controller = new AbortController();
    try {
      const refresh = await refreshPull(data.pull.repositoryId, data.pull.number);
      const operation = await waitForSnapshot(refresh.operationId, controller.signal);
      if (operation.state === 'failed') throw new Error('Snapshot failed');
      const workspace = await loadWorkspace(
        data.pull.repositoryId,
        data.pull.number,
        controller.signal,
      );
      if (workspace.analysis)
        window.history.replaceState(null, '', `/reviews/${workspace.analysis.id}`);
      setData(workspace);
      setSelectedPath(initialSelectedPath(workspace));
      setSelectedFindingId(null);
      setCodeTarget(null);
      setMainView('code');
      setStatus('ready');
    } catch (error) {
      console.error(error);
      setStatus('error');
    } finally {
      setRefreshing(false);
    }
  };

  const selectedFile = data?.files.find((file) => file.path === selectedPath) ?? data?.files[0];
  const analysisPending = status !== 'error' && analysisIsPending(data?.analysis ?? null);
  const progressDetail = data?.analysis?.progressDetail;
  const selectedDiff = data?.diff?.files.find((file) => file.path === selectedFile?.path)?.patch;
  const selectedFinding = data?.report?.findings.find(
    (finding) => finding.id === selectedFindingId && finding.anchor.fileId === selectedFile?.id,
  );
  const coveragePercent = data?.report?.coverage.filesChanged
    ? Math.round((data.report.coverage.filesExamined / data.report.coverage.filesChanged) * 100)
    : 0;
  const addedTestFiles = useMemo(() => analyzeAddedTests(data?.diff?.files ?? []), [data?.diff]);

  const selectFile = (path: string) => {
    setSourceEvidence(null);
    setMainView('code');
    setSelectedPath(path);
    setSelectedFindingId(null);
    const file = data?.files.find((item) => item.path === path);
    const patch = data?.diff?.files.find((item) => item.path === path)?.patch ?? '';
    setCodeTarget((current) =>
      file
        ? {
            fileId: file.id,
            side: 'head',
            ...firstChangedLine(patch),
            request: (current?.request ?? 0) + 1,
          }
        : null,
    );
    const url = new URL(window.location.href);
    url.search = '';
    window.history.replaceState(null, '', url);
  };

  const selectFinding = (finding: FindingView) => {
    setSourceEvidence(null);
    setSelectedFindingId(finding.id);
    setMainView('code');
    setBottomTool('comments');
    setCodeTarget((current) => ({ ...finding.anchor, request: (current?.request ?? 0) + 1 }));
    const file = data?.files.find((item) => item.id === finding.anchor.fileId);
    if (file) setSelectedPath(file.path);
    const link = finding.links.find((item) => item.rel === 'finding');
    if (link) window.history.replaceState(null, '', link.href);
  };

  const selectObject = (objectId: string) => {
    setSourceEvidence(null);
    setMainView('code');
    const anchor = data?.objects.find((item) => item.id === objectId)?.definition;
    const file = data?.files.find((item) => item.id === anchor?.fileId);
    if (file && anchor) {
      setSelectedPath(file.path);
      setSelectedFindingId(null);
      setCodeTarget((current) => ({ ...anchor, request: (current?.request ?? 0) + 1 }));
    }
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
      if (agentChat.enabled) {
        await agentChat.submit(content, {
          ...(selectedFinding ? { findingId: selectedFinding.id } : {}),
          ...(selectedFile ? { fileId: selectedFile.id } : {}),
        });
        return;
      }
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
      <AppHeader compact user={user} />
      <div className="review-context">
        <div className="pr-context">
          <a href="/">{data ? `${data.pull.owner} / ${data.pull.name}` : 'Repository'}</a>
          <ChevronRight size={13} />
          <strong>#{data?.pull.number ?? pullNumber ?? '-'}</strong>
          <span className="context-title">{data?.pull.title ?? 'Pull request'}</span>
        </div>
        <div className="review-actions">
          <span
            className={`analysis-state${data?.report?.analysis ? ` analysis-${data.report.analysis.status}` : data?.analysis?.state ? ` analysis-${data.analysis.state}` : ''}`}
          >
            {data?.report?.analysis && data.report.analysis.status !== 'pass' ? (
              <CircleAlert size={14} />
            ) : data?.report || data?.analysis?.state === 'completed' ? (
              <CircleCheck size={14} />
            ) : data?.analysis?.state === 'failed' || data?.analysis?.state === 'cancelled' ? (
              <CircleAlert size={14} />
            ) : (
              <Clock3 size={14} />
            )}
            {refreshing
              ? 'Snapshot 준비 중'
              : data?.report
                ? data.report.analysis
                  ? reviewStatusLabels[data.report.analysis.status]
                  : data.report.versions.model?.startsWith('fixture')
                    ? '데모 분석'
                    : data.report.versions.review === 'failed'
                      ? 'AI review 실패'
                      : data.report.versions.model === 'disabled' ||
                          data.report.versions.review === 'unavailable'
                        ? 'AI review 미수행'
                        : `${reviewGrades[data.report.grade].label} · P2+ ${data.report.findings.filter((finding) => finding.priority === 'P2' || finding.priority === 'P3').length}`
                : data?.analysis
                  ? formatAnalysisState(data.analysis.state)
                  : status === 'loading'
                    ? '분석 상태 확인 중'
                    : status === 'error'
                      ? '분석 상태 확인 실패'
                      : '코드 준비 중'}
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
            '--left-panel-width': `${leftHidden ? 0 : visibleLayout.leftWidth}px`,
            '--chat-panel-width': `${visibleLayout.chatWidth}px`,
            '--bottom-panel-height': `${visibleLayout.bottomHeight}px`,
          } as CSSProperties
        }
      >
        <ReviewSidebar
          hidden={leftHidden}
          data={data}
          status={status}
          mode={reviewMode}
          selectedFileId={selectedFile?.id ?? null}
          selectedObjectId={selectedObjectId}
          coveragePercent={coveragePercent}
          onModeChange={setReviewMode}
          onFileSelect={selectFile}
          onObjectSelect={selectObject}
        />

        <section className="diff-panel" aria-label="Review content">
          <div className="diff-toolbar">
            <button
              type="button"
              className="icon-button sidebar-toggle"
              aria-label={leftHidden ? '왼쪽 탐색 패널 표시' : '왼쪽 탐색 패널 숨기기'}
              title={leftHidden ? '왼쪽 탐색 패널 표시' : '왼쪽 탐색 패널 숨기기'}
              aria-expanded={!leftHidden}
              aria-controls="review-sidebar"
              onClick={() => setLeftHidden((current) => !current)}
            >
              {leftHidden ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
            <div className="main-view-tabs" role="tablist" aria-label="Review content">
              <button
                className={mainView === 'code' && !sourceEvidence ? 'active' : ''}
                type="button"
                role="tab"
                aria-selected={mainView === 'code' && !sourceEvidence}
                onClick={() => {
                  setSourceEvidence(null);
                  setMainView('code');
                }}
              >
                Code
              </button>
              <button
                className={mainView === 'summary' && !sourceEvidence ? 'active' : ''}
                type="button"
                role="tab"
                aria-selected={mainView === 'summary' && !sourceEvidence}
                disabled={!data?.report}
                onClick={() => {
                  setSourceEvidence(null);
                  setMainView('summary');
                }}
              >
                Summary
              </button>
              {sourceEvidence ? (
                <button type="button" role="tab" aria-selected="true" className="active">
                  코드 근거
                </button>
              ) : null}
            </div>
            {mainView === 'code' ? (
              <>
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
                <button
                  className="icon-button small"
                  type="button"
                  title="최대화"
                  aria-label="최대화"
                >
                  <Maximize2 size={14} />
                </button>
              </>
            ) : null}
          </div>
          {analysisPending ? (
            <div className="analysis-progress-banner" role="status" aria-live="polite">
              <div className="analysis-progress-heading">
                <RefreshCw size={16} className="spin" />
                <strong>
                  {status === 'loading'
                    ? '분석 상태 확인 중'
                    : analysisProgressLabel(data?.analysis ?? null)}
                </strong>
                {progressDetail ? (
                  <span>
                    {progressDetail.filesProcessed}/{progressDetail.filesTotal} 파일 처리
                  </span>
                ) : null}
                <span>{data?.analysis?.progress ?? 0}%</span>
              </div>
              <progress aria-label="분석 진행률" max={100} value={data?.analysis?.progress ?? 0} />
              {progressDetail ? (
                <small>
                  검토 완료 {progressDetail.filesReviewed} · 미검토 {progressDetail.filesSkipped}
                  {progressDetail.currentFile ? ` · ${progressDetail.currentFile}` : ''}
                </small>
              ) : null}
              <small>
                {progressError
                  ? '진행 상태를 다시 확인하고 있습니다.'
                  : '코드 diff를 먼저 확인하세요. 분석이 끝나면 줄별 검토 의견이 자동으로 표시됩니다.'}
              </small>
            </div>
          ) : null}
          {sourceEvidence ? (
            <SourceEvidenceView source={sourceEvidence} onClose={() => setSourceEvidence(null)} />
          ) : mainView === 'code' ? (
            <div className="review-diff-host">
              {data?.diff && selectedFile ? (
                <ReviewDiff
                  patch={selectedDiff ?? ''}
                  fileId={selectedFile!.id}
                  mode={diffMode}
                  target={codeTarget}
                  finding={selectedFinding}
                  findings={data?.report?.findings ?? []}
                />
              ) : (
                <div className="diff-empty">
                  <GitPullRequest size={20} />
                  <span>
                    {status === 'error'
                      ? 'Snapshot을 불러오지 못했습니다.'
                      : '코드 diff를 준비하고 있습니다.'}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className="main-report-host">
              {data?.report ? (
                <ReviewReportPanel
                  report={data.report}
                  files={data.files}
                  section={mainView}
                  selectedFindingId={selectedFindingId}
                  onFindingSelect={selectFinding}
                  onFileSelect={selectFile}
                />
              ) : (
                <div className="panel-empty">아직 publish된 report가 없습니다.</div>
              )}
            </div>
          )}
        </section>

        <section className="bottom-panel" aria-label="검토 의견과 분석 도구">
          <nav className="bottom-tabs" role="tablist" aria-label="Review tools">
            <button
              className={bottomTool === 'comments' ? 'active' : ''}
              type="button"
              role="tab"
              aria-selected={bottomTool === 'comments'}
              onClick={() => selectBottomTool('comments')}
            >
              <MessageSquare size={14} /> Comments <span>{data?.report?.findings.length ?? 0}</span>
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
              className={bottomTool === 'memory' ? 'active' : ''}
              type="button"
              role="tab"
              aria-selected={bottomTool === 'memory'}
              onClick={() => selectBottomTool('memory')}
            >
              <Brain size={14} /> Memory
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
          {bottomTool === 'comments' ? (
            <div className="bottom-comments-host">
              {data?.report ? (
                <ReviewReportPanel
                  report={data.report}
                  files={data.files}
                  section="comments"
                  selectedFindingId={selectedFindingId}
                  onFindingSelect={selectFinding}
                  onFileSelect={selectFile}
                />
              ) : (
                <div className="panel-empty">
                  {status === 'error'
                    ? 'Report를 불러오지 못했습니다. 새로고침하여 다시 확인하세요.'
                    : '분석이 완료되면 검토 의견이 여기에 표시됩니다.'}
                </div>
              )}
            </div>
          ) : null}
          {bottomTool === 'graph' ? <GitGraphPanel data={data} /> : null}
          {bottomTool === 'memory' && data ? (
            <ReviewMemoryPanel data={data} chatMessages={chatMessages} />
          ) : null}
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
        <ChatPanel
          activity={
            agentChat.enabled ? (
              <>
                {chatSession ? (
                  <ChatRunHistory
                    key={chatSession.id}
                    sessionId={chatSession.id}
                    latestRunId={agentChat.run?.id}
                    onSelect={() => {
                      sourceRequest.current?.abort();
                      setSourceEvidence(null);
                      setSourceError('');
                    }}
                    onEvidence={(runId, unitId) => {
                      sourceRequest.current?.abort();
                      const controller = new AbortController();
                      sourceRequest.current = controller;
                      setSourceError('');
                      void fetch(`/api/v1/chat-runs/${runId}/context/${unitId}`, {
                        signal: controller.signal,
                      })
                        .then(async (response) => {
                          if (!response.ok) throw Error('source_unavailable');
                          const source = sourceEvidenceSchema.parse(await response.json());
                          if (!controller.signal.aborted) setSourceEvidence(source);
                        })
                        .catch(() => {
                          if (!controller.signal.aborted)
                            setSourceError(
                              '이전 코드 근거에 접근할 수 없습니다. 권한 또는 보존 기간을 확인해 주세요.',
                            );
                        });
                    }}
                  />
                ) : null}
                <ChatRunActivity
                  key={agentChat.run?.id}
                  run={agentChat.run}
                  error={agentChat.error || sourceError}
                  sending={agentChat.sending}
                  onAnswer={(answer) => agentChat.submit(answer, {})}
                  onCancel={agentChat.cancel}
                  onEvidence={(unitId) => {
                    sourceRequest.current?.abort();
                    const controller = new AbortController();
                    sourceRequest.current = controller;
                    setSourceError('');
                    if (agentChat.run)
                      void fetch(`/api/v1/chat-runs/${agentChat.run.id}/context/${unitId}`, {
                        signal: controller.signal,
                      })
                        .then(async (response) => {
                          if (!response.ok) throw Error('source_unavailable');
                          const source = sourceEvidenceSchema.parse(await response.json());
                          if (!controller.signal.aborted) setSourceEvidence(source);
                        })
                        .catch(() => {
                          if (!controller.signal.aborted)
                            setSourceError('코드 근거를 불러오지 못했습니다. 다시 선택해 주세요.');
                        });
                  }}
                />
              </>
            ) : undefined
          }
          revision={data?.analysis?.revision}
          headSha={data?.pull.headSha}
          selectedFinding={selectedFinding}
          selectedFile={selectedFile?.path}
          model={chatSession?.model ?? null}
          accountCatalog={chatAccounts}
          accountStatus={chatAccountsStatus}
          reportReady={Boolean(data?.report)}
          analysisPending={analysisPending}
          onRetryAccounts={() => setChatAccountsRevision((value) => value + 1)}
          accountId={chatAccountId}
          modelName={chatModelName}
          reasoningEffort={chatEffort}
          messages={
            agentChat.enabled
              ? chatMessages.filter((message) => message.id !== agentChat.run?.assistantMessageId)
              : chatMessages
          }
          draft={chatDraft}
          sending={chatSending}
          onDraftChange={setChatDraft}
          onAccountChange={selectChatAccount}
          onModelChange={selectChatModel}
          onEffortChange={selectChatEffort}
          onSend={() => void handleChatSubmit()}
          files={data?.files ?? []}
          findings={data?.report?.findings ?? []}
          onCitationSelect={(citation) => {
            const target = resolveChatCitation(
              citation,
              data?.files ?? [],
              data?.report?.findings ?? [],
            );
            if (!target) return;
            setMainView('code');
            setSelectedPath(target.path);
            setSelectedFindingId(target.findingId);
            setCodeTarget((current) => ({
              ...target.anchor,
              request: (current?.request ?? 0) + 1,
            }));
          }}
        />
        {!leftHidden ? (
          <WorkspaceResizeHandle
            name="left"
            label="탐색 패널 크기 조절"
            value={visibleLayout.leftWidth}
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
        ) : null}
        <WorkspaceResizeHandle
          name="chat"
          label="채팅 패널 크기 조절"
          value={visibleLayout.chatWidth}
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
          value={visibleLayout.bottomHeight}
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
  hidden,
  data,
  status,
  mode,
  selectedFileId,
  selectedObjectId,
  coveragePercent,
  onModeChange,
  onFileSelect,
  onObjectSelect,
}: {
  hidden: boolean;
  data: WorkspaceData | null;
  status: 'loading' | 'ready' | 'error';
  mode: ReviewMode;
  selectedFileId: string | null;
  selectedObjectId: string | null;
  coveragePercent: number;
  onModeChange: (mode: ReviewMode) => void;
  onFileSelect: (path: string) => void;
  onObjectSelect: (objectId: string) => void;
}) {
  const report = data?.report;
  const selectedObjects =
    data?.objects.filter((object) => object.definition?.fileId === selectedFileId) ?? [];

  return (
    <aside id="review-sidebar" className="left-panel" aria-label="검토 탐색" hidden={hidden}>
      <nav className="side-tabs" aria-label="검토 보기">
        <button
          className={`side-tab ${mode === 'files' ? 'active' : ''}`}
          type="button"
          onClick={() => onModeChange('files')}
        >
          <Files size={15} /> Files
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
            {data?.files.length ? (
              <FileTree
                files={data.files}
                selectedPath={data.files.find((file) => file.id === selectedFileId)?.path ?? ''}
                onSelect={onFileSelect}
              />
            ) : null}
            {status === 'loading' ? (
              <div className="panel-empty">Snapshot을 확인하는 중...</div>
            ) : null}
            {status === 'ready' && !data?.files.length ? (
              <div className="panel-empty">새로고침하여 snapshot을 준비하세요.</div>
            ) : null}
          </div>
        </>
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

function initialSelectedPath(workspace: WorkspaceData): string | null {
  return (
    workspace.diff?.files.find((file) => file.patch.includes('@@'))?.path ??
    workspace.files[0]?.path ??
    null
  );
}
