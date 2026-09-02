import {
  Activity,
  Bot,
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
  GitCommitHorizontal,
  GitPullRequest,
  History,
  Link2,
  ListFilter,
  Maximize2,
  Network,
  PanelBottom,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  TestTube2,
  Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { loadWorklist, type WorklistItem } from './api.ts';

export function App() {
  const workspace = window.location.pathname !== '/';
  return workspace ? <ReviewWorkspace /> : <Worklist />;
}

function AppHeader({ compact = false }: { compact?: boolean }) {
  return (
    <header className="app-header">
      <div className="brand-row">
        <a className="brand" href="/" aria-label="Git Code Reviewer 홈">
          <ShieldCheck size={19} strokeWidth={2.2} />
          <span>Git Code Reviewer</span>
        </a>
        {!compact ? (
          <div className="header-actions">
            <button className="icon-button" type="button" title="검색" aria-label="검색">
              <Search size={17} />
            </button>
            <span className="avatar" aria-label="Local Reviewer">
              LR
            </span>
          </div>
        ) : null}
      </div>
    </header>
  );
}

function Worklist() {
  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<{
    status: 'loading' | 'ready' | 'error';
    items: WorklistItem[];
  }>({ status: 'loading', items: [] });

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, status: 'loading' }));
    void loadWorklist(controller.signal).then(
      (items) => setState({ status: 'ready', items }),
      (error: unknown) => {
        if (!controller.signal.aborted) {
          console.error(error);
          setState({ status: 'error', items: [] });
        }
      },
    );
    return () => controller.abort();
  }, [reloadToken]);

  return (
    <div className="worklist-page">
      <AppHeader />
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
              href={`/repositories/${pr.repository.id}/pulls/${pr.number}`}
              key={pr.id}
            >
              <span className="pr-primary">
                <span className="pr-title">{pr.title}</span>
                <span className="pr-meta">
                  {pr.repository.owner}/{pr.repository.name} #{pr.number} · {pr.author}
                </span>
              </span>
              <span className="status-cell">
                <Clock3 size={14} />
                {pr.draft ? '초안' : '분석 대기'}
              </span>
              <span className="risk-cell">미분석</span>
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

function ReviewWorkspace() {
  return (
    <div className="review-page">
      <AppHeader compact />
      <div className="review-context">
        <div className="pr-context">
          <a href="/">platform / reviewer-api</a>
          <ChevronRight size={13} />
          <strong>#184</strong>
          <span className="context-title">Harden session rotation and token exchange</span>
        </div>
        <div className="review-actions">
          <span className="analysis-state">
            <CircleCheck size={14} /> 분석 완료
          </span>
          <button className="revision-button" type="button">
            Revision 3 <ChevronDown size={13} />
          </button>
          <button className="icon-button" type="button" title="새로고침" aria-label="새로고침">
            <RefreshCw size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            title="GHES에서 열기"
            aria-label="GHES에서 열기"
          >
            <ExternalLink size={16} />
          </button>
        </div>
      </div>
      <main className="workspace-grid">
        <aside className="left-panel" aria-label="검토 탐색">
          <nav className="side-tabs" aria-label="검토 보기">
            <button className="side-tab active" type="button">
              <Files size={15} /> Files
            </button>
            <button className="side-tab" type="button">
              <ShieldCheck size={15} /> Findings <span>2</span>
            </button>
            <button className="side-tab" type="button">
              <Braces size={15} /> Outline
            </button>
            <button className="side-tab" type="button">
              <Network size={15} /> Impact
            </button>
          </nav>
          <div className="panel-heading">
            <span>CHANGED FILES</span>
            <span>4</span>
          </div>
          <div className="file-tree">
            <button className="tree-row folder" type="button">
              <ChevronDown size={14} /> src
            </button>
            <button className="tree-row folder nested" type="button">
              <ChevronDown size={14} /> auth
            </button>
            <button className="tree-row file active" type="button">
              <FileCode2 size={14} /> session.ts <span>+31 −8</span>
            </button>
            <button className="tree-row file" type="button">
              <FileCode2 size={14} /> token.ts <span>+18 −4</span>
            </button>
            <button className="tree-row file top-file" type="button">
              <TestTube2 size={14} /> session.test.ts <span>+42</span>
            </button>
            <button className="tree-row file top-file" type="button">
              <FileCode2 size={14} /> package.json <span>+1 −1</span>
            </button>
          </div>
          <div className="coverage-strip">
            <span>Coverage</span>
            <strong>94%</strong>
            <div>
              <i style={{ width: '94%' }} />
            </div>
          </div>
        </aside>

        <section className="diff-panel" aria-label="코드 차이">
          <div className="diff-toolbar">
            <div className="file-path">
              <FileCode2 size={15} /> src/auth/session.ts
            </div>
            <span className="sha-label">base a13f2c8</span>
            <span className="sha-arrow">→</span>
            <span className="sha-label head">head d91b7a4</span>
            <div className="toolbar-spacer" />
            <div className="segmented" aria-label="Diff 형식">
              <button className="active" type="button">
                Split
              </button>
              <button type="button">Unified</button>
            </div>
            <button className="icon-button small" type="button" title="최대화" aria-label="최대화">
              <Maximize2 size={14} />
            </button>
          </div>
          <div className="diff-columns">
            <CodePane side="base" />
            <CodePane side="head" />
          </div>
        </section>

        <aside className="chat-panel" aria-label="분석 Chat">
          <div className="chat-heading">
            <span>
              <Sparkles size={15} /> Analysis Chat
            </span>
            <button
              className="icon-button small"
              type="button"
              title="Chat 닫기"
              aria-label="Chat 닫기"
            >
              <ChevronRight size={15} />
            </button>
          </div>
          <div className="revision-lock">
            <Link2 size={13} /> Revision 3 · d91b7a4에 고정
          </div>
          <div className="chat-messages">
            <div className="assistant-message">
              <span className="message-author">
                <Bot size={14} /> Reviewer
              </span>
              <p>세션 교체 흐름에서 이전 refresh token이 짧은 시간 동안 다시 사용될 수 있습니다.</p>
              <button className="citation" type="button">
                session.ts:118–132
              </button>
            </div>
            <div className="user-message">
              <p>동시 요청일 때 실제 영향 경로를 보여줘.</p>
            </div>
            <div className="assistant-message">
              <span className="message-author">
                <Bot size={14} /> Reviewer
              </span>
              <p>
                <code>rotateSession</code>을 호출하는 API 두 곳이 같은 token row를 읽습니다. Impact
                탭에서 직접 의존성 2개를 확인할 수 있습니다.
              </p>
            </div>
          </div>
          <form className="chat-composer">
            <textarea aria-label="분석에 질문" placeholder="이 revision에 대해 질문..." rows={3} />
            <div className="composer-actions">
              <span>Report + selected file</span>
              <button className="send-button" type="submit" title="보내기" aria-label="보내기">
                <Send size={15} />
              </button>
            </div>
          </form>
        </aside>

        <section className="bottom-panel" aria-label="분석 근거">
          <nav className="bottom-tabs">
            <button className="active" type="button">
              <PanelBottom size={14} /> Evidence
            </button>
            <button type="button">
              <GitBranch size={14} /> Git graph
            </button>
            <button type="button">
              <History size={14} /> History
            </button>
            <button type="button">
              <Users size={14} /> Ownership
            </button>
            <button type="button">
              <Network size={14} /> Relationships
            </button>
            <button type="button">
              <Activity size={14} /> Impact
            </button>
            <button type="button">
              <TestTube2 size={14} /> Tests
            </button>
          </nav>
          <div className="evidence-content">
            <div className="severity-mark">P2</div>
            <div>
              <strong>Token rotation is not atomic</strong>
              <p>
                두 request가 동일한 이전 token 상태를 통과할 수 있습니다. Transaction 안에서
                compare-and-swap을 적용하세요.
              </p>
            </div>
            <div className="evidence-facts">
              <span>
                <GitCommitHorizontal size={13} /> d91b7a4
              </span>
              <span>
                <CircleCheck size={13} /> 직접 근거
              </span>
              <span>신뢰도 높음</span>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

const oldLines = [
  'export async function rotateSession(token: string) {',
  '  const current = await sessions.findByToken(token);',
  '  if (!current || current.revokedAt) return null;',
  '',
  '  await sessions.revoke(current.id);',
  '  return sessions.create(current.userId);',
  '}',
];

const newLines = [
  'export async function rotateSession(token: string) {',
  '  return database.transaction(async (tx) => {',
  '    const current = await sessions.findByToken(token, tx);',
  '    if (!current || current.revokedAt) return null;',
  '',
  '    await sessions.revoke(current.id, tx);',
  '    return sessions.create(current.userId, tx);',
  '  });',
  '}',
];

function CodePane({ side }: { side: 'base' | 'head' }) {
  const lines = side === 'base' ? oldLines : newLines;
  return (
    <div className={`code-pane ${side}`}>
      <div className="pane-label">{side === 'base' ? 'BASE' : 'HEAD'}</div>
      <pre>
        {lines.map((line, index) => (
          <span
            className={
              side === 'base' && index >= 4
                ? 'removed'
                : side === 'head' && (index === 1 || index >= 5)
                  ? 'added'
                  : ''
            }
            key={`${side}-${index}`}
          >
            <i>{112 + index}</i>
            <code>{line || ' '}</code>
          </span>
        ))}
      </pre>
    </div>
  );
}
