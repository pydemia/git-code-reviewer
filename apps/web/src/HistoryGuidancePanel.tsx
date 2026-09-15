import { useEffect, useState } from 'react';
import type { ReviewHistoryMessage } from '@gcr/contracts';
import {
  loadHistoryGuidance,
  createHistoryGuidance,
  changeHistoryGuidance,
  type HistoryGuidance,
} from './history-api.ts';
const lines = (text: string) =>
  text
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
export function HistoryGuidancePanel({
  repositoryId: repo,
  source,
  manage,
}: {
  repositoryId: string;
  source: ReviewHistoryMessage;
  manage: boolean;
}) {
  const [items, setItems] = useState<HistoryGuidance[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false);
  const [summary, setSummary] = useState(''),
    [detail, setDetail] = useState(''),
    [recommendation, setRecommendation] = useState(''),
    [paths, setPaths] = useState(source.path ?? ''),
    [conditions, setConditions] = useState(''),
    [counter, setCounter] = useState('');
  useEffect(() => {
    const c = new AbortController();
    void loadHistoryGuidance(repo, source.id, c.signal)
      .then((v) => {
        if (!c.signal.aborted) {
          setItems(v.items);
          setCursor(v.nextCursor);
          setReady(true);
        }
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(e instanceof Error ? e.message : '지침을 불러오지 못했습니다.');
      });
    return () => c.abort();
  }, [repo, source.id]);
  const run = async (op: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await op();
    } catch (e) {
      setError(e instanceof Error ? e.message : '요청을 처리하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="출처 지침" className="history-guidance">
      <h4>이 원문에 연결된 지침</h4>
      <p>
        지침은 원문과 적용 조건을 확인한 관리자가 활성화하며, 중앙에서 클라이언트가 읽을 수 있도록
        발행합니다. 원문 읽기에는 승인이 필요하지 않으며 이 지침은 개인 메모리의 집단 승격과
        별도입니다.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {ready && !items.length ? <p>등록된 지침이 없습니다.</p> : null}
      {items.map((item) => (
        <article key={item.id}>
          <h5>{item.content.summary}</h5>
          <p>
            {item.state === 'active'
              ? '활성'
              : item.state === 'candidate'
                ? '초안'
                : item.state === 'retired'
                  ? '비활성'
                  : item.state}
            {item.needsReview ? ' · 원문·지침 재검토 필요' : ''}
          </p>
          <p className="history-excerpt">{item.content.detail}</p>
          <p className="history-excerpt">{item.content.recommendation}</p>
          <dl>
            <dt>적용 조건</dt>
            <dd>
              {Object.entries(item.content.appliesTo)
                .filter(([, v]) => v.length)
                .map(([k, v]) => (
                  <p key={k}>
                    {
                      (
                        {
                          languages: '언어',
                          filePaths: '파일',
                          symbols: '심볼',
                          contracts: '조건',
                          branches: '브랜치',
                        } as Record<string, string>
                      )[k]
                    }
                    : {v.join(', ')}
                  </p>
                ))}
            </dd>
            <dt>반증 지침</dt>
            <dd>
              <ul>
                {item.content.counterEvidence.map((text, i) => (
                  <li key={i}>{text}</li>
                ))}
              </ul>
            </dd>
          </dl>
          <a href={item.source.htmlUrl} target="_blank" rel="noreferrer">
            PR #{item.source.pullNumber} 출처
          </a>
          {item.publicationRequested ? (
            <p>
              발행을 요청했습니다.{' '}
              <a href={`/review-criteria?repositoryId=${repo}`}>리뷰 지식 배포 상태 확인</a>
            </p>
          ) : null}
          {manage && item.state === 'candidate' && !item.needsReview ? (
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const next = await changeHistoryGuidance(repo, item, 'activate');
                  setItems((xs) => xs.map((x) => (x.id === next.id ? next : x)));
                  setNotice('지침을 활성화하고 발행을 요청했습니다.');
                })
              }
            >
              활성화·발행
            </button>
          ) : null}
          {manage && ['candidate', 'active'].includes(item.state) ? (
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const next = await changeHistoryGuidance(repo, item, 'retire');
                  setItems((xs) => xs.map((x) => (x.id === next.id ? next : x)));
                })
              }
            >
              지침 비활성화
            </button>
          ) : null}
        </article>
      ))}
      {cursor ? (
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const next = await loadHistoryGuidance(
                repo,
                source.id,
                new AbortController().signal,
                cursor,
              );
              setItems((xs) => [...xs, ...next.items]);
              setCursor(next.nextCursor);
            })
          }
        >
          지침 더 보기
        </button>
      ) : null}
      {manage && source.upstreamState === 'present' ? (
        <details>
          <summary>원문을 바탕으로 지침 작성</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const next = await createHistoryGuidance(repo, source, {
                  summary,
                  detail,
                  recommendation,
                  categories: [],
                  appliesTo: {
                    languages: [],
                    filePaths: lines(paths),
                    symbols: [],
                    contracts: lines(conditions),
                    branches: [],
                  },
                  counterEvidence: lines(counter),
                  expiresAt: null,
                });
                setItems((xs) => [next, ...xs.filter((x) => x.id !== next.id)]);
                setNotice('초안을 저장했습니다. 내용과 출처를 확인한 뒤 활성화해 주세요.');
              });
            }}
          >
            <label>
              지침 요약
              <input
                required
                maxLength={500}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
              />
            </label>
            <label>
              출처 해석
              <textarea
                maxLength={4000}
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
              />
            </label>
            <label>
              검토 지침
              <textarea
                required
                maxLength={2000}
                value={recommendation}
                onChange={(e) => setRecommendation(e.target.value)}
              />
            </label>
            <label>
              적용 파일 · 한 줄에 하나
              <textarea
                value={paths}
                onChange={(e) => setPaths(e.target.value)}
                placeholder="예: **/schema.py"
              />
            </label>
            <label>
              적용 조건 · 한 줄에 하나
              <textarea
                required
                placeholder="예: 요청 필드만으로 검증 여부를 결정할 수 있는 경우"
                value={conditions}
                onChange={(e) => setConditions(e.target.value)}
              />
            </label>
            <label>
              반증 지침 · 한 줄에 하나
              <textarea
                placeholder="예: 이미 validator가 검증하거나 DB 상태 조회가 필요한 경우에는 적용하지 않음"
                required
                value={counter}
                onChange={(e) => setCounter(e.target.value)}
              />
            </label>
            <p>
              resolved·merged 여부만으로 수정이 검증됐다고 판단하지 않습니다. 기존 지침을 바꾸려면
              비활성화 후 현재 원문에서 새 초안을 작성해 주세요.
            </p>
            <button disabled={busy} type="submit">
              지침 초안 저장
            </button>
          </form>
        </details>
      ) : null}
    </section>
  );
}
