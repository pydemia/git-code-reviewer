import { GitPullRequest, MessageSquare, Search, ExternalLink } from 'lucide-react';
import { ReviewMarkdown } from './ReviewMarkdown.tsx';
import { historyThreads } from './history-threads.ts';
import { HistoryGuidancePanel } from './HistoryGuidancePanel.tsx';
import { useEffect, useState } from 'react';
import type {
  ReviewHistoryMessage,
  ReviewHistoryMessageSummary,
  ReviewHistoryPull,
} from '@gcr/contracts';
import { AppHeader } from './AppHeader.tsx';
import { GitHubMessageProvenance } from './GitHubMessageEvidence.tsx';
import { loadCriteriaRepositories, loadCurrentUser, type User } from './api.ts';
import {
  collectHistory,
  loadHistoryCollection,
  loadHistoryMessage,
  loadHistoryMessages,
  loadHistoryObservations,
  loadHistoryBodyVersions,
  loadHistoryPulls,
  loadHistoryPullByNumber,
  retryHistoryCollection,
  type HistoryCollection,
} from './history-api.ts';
import './review-criteria.css';
import './review-history.css';
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : '리뷰 이력을 불러오지 못했습니다.';
const kinds = { review: '리뷰', 'review-comment': 'inline 코멘트', 'issue-comment': '일반 코멘트' };
const pullNumber = (text: string) => {
  const n = Number(text.trim().replace(/^#/, ''));
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : null;
};
export function ReviewHistoryPage() {
  const [user, setUser] = useState<User | null>(null),
    [repos, setRepos] = useState<Awaited<ReturnType<typeof loadCriteriaRepositories>>>([]),
    [repo, setRepo] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    const c = new AbortController();
    void Promise.all([loadCurrentUser(c.signal), loadCriteriaRepositories(c.signal)])
      .then(([u, r]) => {
        if (c.signal.aborted) return;
        setUser(u);
        setRepos(r);
        const requested = new URLSearchParams(location.search).get('repositoryId');
        setRepo(r.find((x) => x.id === requested)?.id ?? r[0]?.id ?? '');
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(errorMessage(e));
      });
    return () => c.abort();
  }, []);
  return (
    <>
      <AppHeader user={user} />
      <main className="criteria-page history-page">
        <header className="history-page-heading">
          <div>
            <p className="history-eyebrow">REVIEW ARCHIVE</p>
            <h1>리뷰 이력</h1>
            <p>PR의 대화와 코드에 남긴 피드백을 한곳에서 확인하세요.</p>
          </div>
          <a className="history-guide-link" href="/guide#history-guidance">
            지침 작성 가이드 <ExternalLink size={14} />
          </a>
        </header>
        {error ? <p role="alert">{error}</p> : null}
        <label>
          저장소
          <select
            value={repo}
            onChange={(e) => {
              setRepo(e.target.value);
              const url = new URL(location.href);
              url.searchParams.set('repositoryId', e.target.value);
              url.searchParams.delete('pullNumber');
              window.history.replaceState(null, '', url);
            }}
          >
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.owner}/{r.name}
              </option>
            ))}
          </select>
        </label>
        {repo ? <HistoryRepository key={repo} repositoryId={repo} /> : null}
      </main>
    </>
  );
}
function HistoryRepository({ repositoryId: repo }: { repositoryId: string }) {
  const [pulls, setPulls] = useState<ReviewHistoryPull[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [selected, setSelected] = useState<number | null>(null),
    [manage, setManage] = useState(false),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [reload, setReload] = useState(0),
    [query, setQuery] = useState('');
  const [numbers, setNumbers] = useState(''),
    [collection, setCollection] = useState<HistoryCollection | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    setError('');
    const requested = pullNumber(new URLSearchParams(location.search).get('pullNumber') ?? '');
    void Promise.all([
      loadHistoryPulls(repo, c.signal),
      requested ? loadHistoryPullByNumber(repo, requested, c.signal) : Promise.resolve(null),
    ])
      .then(([r, target]) => {
        if (c.signal.aborted) return;
        const extra = target?.items ?? [];
        setPulls([...extra, ...r.items.filter((p) => !extra.some((x) => x.id === p.id))]);
        setCursor(r.nextCursor);
        setManage(r.capabilities.manage);
        setSelected((n) => n ?? extra[0]?.number ?? r.items[0]?.number ?? null);
        if (requested && !extra.length) setError(`저장된 PR #${requested} 이력이 없습니다.`);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(errorMessage(e));
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [repo, reload]);
  useEffect(() => {
    if (!collection || collection.state !== 'running') return;
    const c = new AbortController();
    const timer = setTimeout(() => {
      void loadHistoryCollection(repo, collection.id, c.signal)
        .then((next) => {
          if (c.signal.aborted) return;
          setCollection(next);
          if (next.state !== 'running') setReload((n) => n + 1);
        })
        .catch((e) => {
          if (!c.signal.aborted) setError(errorMessage(e));
        });
    }, 2000);
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [repo, collection]);
  const choose = (number: number) => {
    setSelected(number);
    const url = new URL(location.href);
    url.searchParams.set('repositoryId', repo);
    url.searchParams.set('pullNumber', String(number));
    window.history.replaceState(null, '', url);
  };
  const openNumber = async () => {
    const number = pullNumber(query);
    if (!number || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await loadHistoryPullByNumber(repo, number, new AbortController().signal);
      if (!r.items.length) throw Error(`저장된 PR #${number} 이력이 없습니다.`);
      setPulls((p) => [...r.items, ...p.filter((x) => !r.items.some((item) => item.id === x.id))]);
      setQuery(String(number));
      choose(number);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const values = numbers
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number);
      if (
        !values.length ||
        values.length > 20 ||
        values.some((n) => !Number.isSafeInteger(n) || n < 1)
      )
        throw Error('PR 번호를 1개부터 20개까지 입력해 주세요.');
      setCollection(await collectHistory(repo, values));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const more = async () => {
    if (!cursor) return;
    setBusy(true);
    try {
      const next = await loadHistoryPulls(repo, new AbortController().signal, cursor);
      setPulls((p) => [...p, ...next.items.filter((x) => !p.some((old) => old.id === x.id))]);
      setCursor(next.nextCursor);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {manage ? (
        <details className="history-collection">
          <summary>기존 PR 이력 다시 수집</summary>
          <p>지정한 PR의 대화만 조회합니다. PR 생성이나 리뷰 분석은 실행하지 않습니다.</p>
          <label>
            PR 번호 (쉼표로 구분, 최대 20개)
            <input
              value={numbers}
              onChange={(e) => setNumbers(e.target.value)}
              placeholder="917, 915"
            />
          </label>
          <button disabled={busy} onClick={() => void start()}>
            지정한 PR 수집
          </button>
          {collection ? (
            <div role="status">
              수집 완료 {collection.completed}/{collection.total}
              {collection.items.map((i) => (
                <p key={i.number}>
                  #{i.number} · {i.state} · 시도 {i.attempts}
                  {i.errorCode ? ` · ${i.errorCode}` : ''}
                </p>
              ))}
              {collection.state === 'partial' ? (
                <button
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void retryHistoryCollection(repo, collection.id)
                      .then(setCollection)
                      .catch((e) => setError(errorMessage(e)))
                      .finally(() => setBusy(false));
                  }}
                >
                  미완료 PR 재시도
                </button>
              ) : null}
            </div>
          ) : null}
        </details>
      ) : null}
      {error ? (
        <p role="alert">
          {error} <button onClick={() => setReload((n) => n + 1)}>처음부터 새로고침</button>
        </p>
      ) : null}
      {loading ? <p role="status">이력을 불러오는 중입니다.</p> : null}
      <div className="history-layout">
        <aside aria-label="PR 이력 목록">
          <div className="history-list-heading">
            <h2>Pull requests</h2>
            <span>
              {pulls.length}
              {cursor ? '+' : ''}
            </span>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void openNumber();
            }}
          >
            <label className="history-search">
              <Search size={16} aria-hidden="true" />
              <input
                aria-label="불러온 PR 검색"
                placeholder="PR 번호 또는 제목 검색"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            {pullNumber(query) ? (
              <button className="history-number-open" type="submit" disabled={busy}>
                PR 번호로 열기
              </button>
            ) : null}
          </form>
          <p className="history-search-scope">
            제목은 불러온 {pulls.length}개에서 검색 · PR 번호로 전체 저장 이력 조회
          </p>
          {pulls
            .filter((p) =>
              `${p.number} ${p.title}`
                .toLowerCase()
                .includes(query.trim().replace(/^#/, '').toLowerCase()),
            )
            .map((p) => (
              <button
                className="history-pull"
                key={p.id}
                aria-pressed={selected === p.number}
                onClick={() => choose(p.number)}
              >
                <span className="history-pull-top">
                  <GitPullRequest size={17} aria-hidden="true" />
                  <span>#{p.number}</span>
                  <span className={`history-state ${p.state}`}>
                    {p.state === 'closed' ? '닫힘' : '열림'}
                  </span>
                </span>
                <strong>{p.title}</strong>
                <span>
                  코멘트 {p.messageCount} · 답글 {p.replyCount}
                </span>
                <span>{coverageLabel(p)}</span>
              </button>
            ))}
          {query &&
          !pulls.some((p) =>
            `${p.number} ${p.title}`
              .toLowerCase()
              .includes(query.trim().replace(/^#/, '').toLowerCase()),
          ) ? (
            <p className="history-empty">
              일치하는 PR이 없습니다. 검색어를 바꾸거나 이전 PR을 더 불러오세요.
            </p>
          ) : null}
          {!loading && !pulls.length ? (
            <p>
              저장된 PR 이력이 없습니다. 선택한 저장소와 수집 범위를 확인하세요. 추가 과거 수집은
              관리자가 PR 번호와 한도를 지정해 요청합니다.
            </p>
          ) : null}
          {cursor ? (
            <button disabled={busy} onClick={() => void more()}>
              이전 PR 더 보기
            </button>
          ) : null}
        </aside>
        {selected ? (
          <HistoryPull
            key={`${repo}:${selected}:${reload}`}
            repositoryId={repo}
            number={selected}
            manage={manage}
          />
        ) : (
          <p>PR을 선택해 주세요.</p>
        )}
      </div>
    </>
  );
}
function coverageLabel(p: ReviewHistoryPull) {
  return {
    uncollected: '전체 수집 범위 미확인',
    collected: p.coverage.observedCount === 0 ? '최근 전체 조회에 코멘트 없음' : '전체 조회 완료',
    failed: '최근 수집 실패',
    collecting: '수집 대기 또는 진행 중',
  }[p.coverage.state];
}
function HistoryPull({
  repositoryId: repo,
  number,
  manage,
}: {
  repositoryId: string;
  number: number;
  manage: boolean;
}) {
  const [pull, setPull] = useState<ReviewHistoryPull | null>(null),
    [items, setItems] = useState<ReviewHistoryMessageSummary[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [source, setSource] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    void loadHistoryMessages(repo, number, c.signal)
      .then((r) => {
        if (c.signal.aborted) return;
        setPull(r.pull);
        setItems(r.items);
        setCursor(r.nextCursor);
        setSource(r.items[0]?.id ?? null);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(errorMessage(e));
      });
    return () => c.abort();
  }, [repo, number]);
  const more = async () => {
    if (!cursor) return;
    setBusy(true);
    try {
      const r = await loadHistoryMessages(repo, number, new AbortController().signal, cursor);
      setItems((old) => [...old, ...r.items]);
      setCursor(r.nextCursor);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="history-conversation" aria-label={`PR #${number} 대화`}>
      <header className="history-conversation-heading">
        <span className="history-eyebrow">PULL REQUEST #{number}</span>
        <h2>{pull?.title ?? '대화를 불러오는 중입니다'}</h2>
        {pull ? (
          <p>
            <span className={`history-state ${pull.state}`}>
              {pull.state === 'closed' ? '닫힘' : '열림'}
            </span>{' '}
            <MessageSquare size={14} aria-hidden="true" /> 저장 코멘트 {pull.messageCount} · 답글{' '}
            {pull.replyCount}
          </p>
        ) : null}
      </header>
      {pull ? (
        <>
          <a className="history-original-link" href={pull.htmlUrl} target="_blank" rel="noreferrer">
            GitHub에서 PR 열기 <ExternalLink size={14} />
          </a>
          <p>
            {coverageLabel(pull)}
            {pull.coverage.lastCompleteAt
              ? ` · ${new Date(pull.coverage.lastCompleteAt).toLocaleString()}`
              : ''}
          </p>
          {pull.notReturnedCount ? (
            <p>
              보관 중인 코멘트 {pull.notReturnedCount}건이 최근 전체 조회에서 반환되지 않았습니다.
              원문은 남아 있으며 삭제 여부는 확정되지 않았습니다.
            </p>
          ) : null}
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <p className="history-context-note">
        저장 시점의 대화입니다. 스레드 해결·답글·PR 병합은 현재 코드의 수정 여부와 구분해
        확인하세요.
      </p>
      {!pull && !error ? <p role="status">대화를 불러오는 중입니다.</p> : null}
      <div className="history-messages">
        {historyThreads(items).map((thread) => (
          <div className="history-thread" key={thread.id}>
            {thread.messages.map((item) => (
              <article
                className={`history-comment ${item.parentId && items.some((p) => p.id === item.parentId) ? 'is-reply' : ''}`}
                id={`comment-${item.id}`}
                key={item.id}
              >
                <div className="history-avatar" aria-hidden="true">
                  {item.authorLogin.slice(0, 2).toUpperCase()}
                </div>
                <div className="history-comment-card">
                  <header className="history-comment-header">
                    <strong>{item.authorLogin}</strong>
                    <time dateTime={item.githubCreatedAt}>
                      {new Date(item.githubCreatedAt).toLocaleString()}
                    </time>
                    <span className="history-kind">{kinds[item.kind]}</span>
                  </header>
                  {item.path ? (
                    <div className="history-file">
                      <code>
                        {item.path}
                        {item.line ? `:${item.line}` : ''}
                      </code>
                      {item.commitSha ? <span>{item.commitSha.slice(0, 8)}</span> : null}
                    </div>
                  ) : null}
                  {item.inReplyToGithubId ? (
                    <p className="history-reply-context">
                      ↳ 코멘트 #{item.inReplyToGithubId}에 답글{' '}
                      {item.parentId ? (
                        <button
                          onClick={() => {
                            setSource(item.parentId);
                            document
                              .getElementById(`comment-${item.parentId}`)
                              ?.scrollIntoView({ block: 'nearest' });
                          }}
                        >
                          상위 코멘트
                        </button>
                      ) : (
                        <span>· 상위 원문 미수집</span>
                      )}
                    </p>
                  ) : null}
                  {item.upstreamState === 'not-returned' ? (
                    <p className="history-context-note">
                      최근 전체 조회에 없음 · 삭제 여부는 미확인
                    </p>
                  ) : null}
                  {source !== item.id ? (
                    <div className="history-comment-preview">
                      <ReviewMarkdown text={item.excerpt || '(본문 없음)'} />
                      {item.bodyCharacters > item.excerpt.length ? (
                        <small>본문 일부 · 전체 {item.bodyCharacters.toLocaleString()}자</small>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="history-comment-actions">
                    <button
                      id={`toggle-${item.id}`}
                      aria-expanded={source === item.id}
                      aria-controls={`source-${item.id}`}
                      onClick={() => setSource(source === item.id ? null : item.id)}
                    >
                      {source === item.id ? '원문 접기' : '원문·변경 이력 보기'}
                    </button>
                    <a href={item.htmlUrl} target="_blank" rel="noreferrer">
                      GitHub 원문 <ExternalLink size={12} />
                    </a>
                  </div>
                  {source === item.id ? (
                    <div id={`source-${item.id}`}>
                      <HistorySource
                        repositoryId={repo}
                        number={number}
                        sourceId={item.id}
                        manage={manage}
                        onClose={() => {
                          setSource(null);
                          document.getElementById(`toggle-${item.id}`)?.focus();
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        ))}
      </div>
      {cursor ? (
        <button disabled={busy} onClick={() => void more()}>
          코멘트 더 보기
        </button>
      ) : null}
      {pull && !items.length ? (
        <p>
          {pull.coverage.state === 'collected'
            ? '최근 전체 조회에 코멘트가 없습니다.'
            : '아직 저장된 코멘트가 없습니다. 수집 범위를 확인해 주세요.'}
        </p>
      ) : null}
      {source && !items.some((item) => item.id === source) ? (
        <HistorySource
          key={source}
          repositoryId={repo}
          number={number}
          sourceId={source}
          manage={manage}
          onClose={() => setSource(null)}
        />
      ) : null}
    </section>
  );
}
export function HistorySource({
  repositoryId: repo,
  number,
  sourceId,
  onClose,
  manage,
}: {
  repositoryId: string;
  number: number;
  sourceId: string;
  onClose: () => void;
  manage: boolean;
}) {
  const [versions, setVersions] = useState<Awaited<
    ReturnType<typeof loadHistoryBodyVersions>
  > | null>(null);
  const [item, setItem] = useState<ReviewHistoryMessage | null>(null),
    [history, setHistory] = useState<Awaited<ReturnType<typeof loadHistoryObservations>> | null>(
      null,
    ),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    void Promise.all([
      loadHistoryMessage(repo, number, sourceId, c.signal),
      loadHistoryObservations(repo, number, sourceId, c.signal),
      loadHistoryBodyVersions(repo, number, sourceId, c.signal),
    ])
      .then(([s, h, v]) => {
        if (c.signal.aborted) return;
        setItem(s.item);
        setHistory(h);
        setVersions(v);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(errorMessage(e));
      });
    return () => c.abort();
  }, [repo, number, sourceId]);
  const more = async () => {
    if (!history?.nextCursor) return;
    setBusy(true);
    try {
      const next = await loadHistoryObservations(
        repo,
        number,
        sourceId,
        new AbortController().signal,
        history.nextCursor,
      );
      setHistory((h) => (h ? { ...next, items: [...h.items, ...next.items] } : next));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="history-source" aria-label="코멘트 원문">
      <header>
        <h3>원문과 변경 이력</h3>
        <button onClick={onClose}>닫기</button>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {item ? (
        <>
          <a href={item.htmlUrl} target="_blank" rel="noreferrer">
            GitHub 원문
          </a>
          <p>
            {item.authorLogin} · {kinds[item.kind]} ·{' '}
            {item.upstreamState === 'present' ? '수집된 원문' : '최근 전체 조회에서 반환되지 않음'}
          </p>
          <ReviewMarkdown text={item.body || '(본문 없음)'} />
          <details className="history-raw">
            <summary>Markdown 원문 텍스트</summary>
            <pre className="history-body">{item.body || '(본문 없음)'}</pre>
          </details>
          <GitHubMessageProvenance source={item} />
          <details className="history-evidence">
            <summary>수정·관측 이력 확인</summary>
            <h4>저장된 본문 버전</h4>
            <p>
              본문 버전에는 저장 당시 확인된 본문과 위치만 표시합니다. 당시의 스레드 상태는 추정하지
              않습니다.
            </p>
            {versions?.items.map((v) => (
              <details key={v.id}>
                <summary>{new Date(v.observedAt).toLocaleString()} · 본문 버전</summary>
                <ReviewMarkdown text={v.body || '(본문 없음)'} />
                <p>
                  {v.path ?? '파일 위치 미확인'}
                  {v.line ? `:${v.line}` : ''}
                  {v.side ? ` · ${v.side}` : ''}
                </p>
                {v.commitSha ? <p>commit {v.commitSha}</p> : null}
              </details>
            ))}
            {versions?.nextCursor ? (
              <button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void loadHistoryBodyVersions(
                    repo,
                    number,
                    sourceId,
                    new AbortController().signal,
                    versions.nextCursor,
                  )
                    .then((next) =>
                      setVersions((v) =>
                        v ? { ...next, items: [...v.items, ...next.items] } : next,
                      ),
                    )
                    .catch((e) => setError(errorMessage(e)))
                    .finally(() => setBusy(false));
                }}
              >
                이전 본문 버전 더 보기
              </button>
            ) : null}
            <h4>수집 이후의 관측 이력</h4>
            <p>수집 이전에 수정·삭제된 내용은 복원된 것으로 표시하지 않습니다.</p>
            {history?.items.map((h) => (
              <details key={h.id}>
                <summary>
                  {new Date(h.observedAt).toLocaleString()} ·{' '}
                  {h.snapshot.upstreamState === 'not-returned' ? '최근 조회에 없음' : '원문 관측'}
                </summary>
                <ReviewMarkdown text={h.snapshot.body || '(본문 없음)'} />
                <GitHubMessageProvenance source={h.snapshot} />
              </details>
            ))}
            {history && !history.items.length ? (
              <p>이전 저장 원문만 있으며 상세 관측 이력은 없습니다.</p>
            ) : null}
            {history?.nextCursor ? (
              <button disabled={busy} onClick={() => void more()}>
                이전 관측 더 보기
              </button>
            ) : null}
          </details>
          <details className="history-evidence">
            <summary>이 원문에 연결된 지침</summary>
            <HistoryGuidancePanel repositoryId={repo} source={item} manage={manage} />
          </details>
        </>
      ) : !error ? (
        <p role="status">원문을 불러오는 중입니다.</p>
      ) : null}
    </section>
  );
}
