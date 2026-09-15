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
  loadHistoryPulls,
  retryHistoryCollection,
  type HistoryCollection,
} from './history-api.ts';
import './review-criteria.css';
import './review-history.css';
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : '리뷰 이력을 불러오지 못했습니다.';
const kinds = { review: '리뷰', 'review-comment': 'inline 코멘트', 'issue-comment': '일반 코멘트' };
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
        <h1>리뷰 이력</h1>
        <p>
          PR 코멘트 원문과 답글, 수집 이후의 변경 이력을 조회합니다. 분석 결과나 메모리 승인 없이
          읽을 수 있습니다.
        </p>
        {error ? <p role="alert">{error}</p> : null}
        <label>
          저장소
          <select value={repo} onChange={(e) => setRepo(e.target.value)}>
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
    [reload, setReload] = useState(0);
  const [numbers, setNumbers] = useState(''),
    [collection, setCollection] = useState<HistoryCollection | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    setError('');
    void loadHistoryPulls(repo, c.signal)
      .then((r) => {
        if (c.signal.aborted) return;
        setPulls(r.items);
        setCursor(r.nextCursor);
        setManage(r.capabilities.manage);
        setSelected((n) => n ?? r.items[0]?.number ?? null);
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
      setPulls((p) => [...p, ...next.items]);
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
          {pulls.map((p) => (
            <button
              className="history-pull"
              key={p.id}
              aria-pressed={selected === p.number}
              onClick={() => setSelected(p.number)}
            >
              <strong>
                #{p.number} {p.title}
              </strong>
              <span>
                {p.state === 'closed' ? '닫힘' : '열림'} · 저장 코멘트 {p.messageCount} · 답글{' '}
                {p.replyCount}
              </span>
              <span>{coverageLabel(p)}</span>
            </button>
          ))}
          {!loading && !pulls.length ? <p>조회할 PR이 없습니다.</p> : null}
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
    <section aria-label={`PR #${number} 대화`}>
      <h2>
        PR #{number} {pull?.title}
      </h2>
      {pull ? (
        <>
          <a href={pull.htmlUrl} target="_blank" rel="noreferrer">
            원본 PR 열기
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
      <div className="history-messages">
        {items.map((item) => (
          <article key={item.id}>
            <small>
              {kinds[item.kind]} · {item.authorLogin} ·{' '}
              {new Date(item.githubCreatedAt).toLocaleString()}
            </small>
            <p className="history-excerpt">{item.excerpt || '(본문 없음)'}</p>
            {item.upstreamState === 'not-returned' ? <p>최근 전체 조회에 없음</p> : null}
            {item.inReplyToGithubId ? (
              <p>
                코멘트 #{item.inReplyToGithubId}의 답글{' '}
                {item.parentId ? (
                  <button onClick={() => setSource(item.parentId)}>상위 코멘트</button>
                ) : (
                  <span>· 상위 원문 미수집</span>
                )}
              </p>
            ) : null}
            <button onClick={() => setSource(item.id)}>원문·변경 이력 보기</button>
          </article>
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
      {source ? (
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
    ])
      .then(([s, h]) => {
        if (c.signal.aborted) return;
        setItem(s.item);
        setHistory(h);
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
          <pre className="history-body">{item.body || '(본문 없음)'}</pre>
          <GitHubMessageProvenance source={item} />
          <h4>수집 이후의 관측 이력</h4>
          <p>수집 이전에 수정·삭제된 내용은 복원된 것으로 표시하지 않습니다.</p>
          {history?.items.map((h) => (
            <details key={h.id}>
              <summary>
                {new Date(h.observedAt).toLocaleString()} ·{' '}
                {h.snapshot.upstreamState === 'not-returned' ? '최근 조회에 없음' : '원문 관측'}
              </summary>
              <pre className="history-body">{h.snapshot.body || '(본문 없음)'}</pre>
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
          <div data-history-guidance-source={item.id} data-can-manage={manage} />
        </>
      ) : (
        <p role="status">원문을 불러오는 중입니다.</p>
      )}
    </section>
  );
}
