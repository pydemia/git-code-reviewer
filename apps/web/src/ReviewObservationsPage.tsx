import { useEffect, useState } from 'react';
import { reviewObservationsSchema, type ReviewObservations } from '@gcr/contracts';
import { AppHeader } from './AppHeader.tsx';
import { fetchJson, loadCurrentUser, loadCriteriaRepositories, type User } from './api.ts';
import './review-observations.css';
const states: Record<string, string> = {
  model: '모델 검토',
  fixture: '데모',
  unknown: '검토 출처 미기록',
  queued: '대기',
  analyzing: '분석 중',
  completed: '완료',
  partial: '부분 완료',
  failed: '실패',
  cancelled: '취소',
  reserved: '예약',
  sent: '전송',
  interrupted: '중단',
  published: '발행 완료',
  pending: '발행 대기',
  unpublished: '미발행',
  unavailable: '조회 불가',
  draft: '후보',
  evaluated: '평가 통과',
  shadow: '관찰 중',
  active: '활성',
  retired: '퇴역',
};
const outcomes: Record<string, string> = {
  defect: '결함 판단',
  'false-positive': '오탐 판단',
  'accepted-exception': '예외 판단',
  'design-decision': '설계 결정',
  'open-question': '미해결 질문',
};
export function ReviewObservations({ value: v }: { value: ReviewObservations }) {
  const risks = v.pulls.findings.P2 + v.pulls.findings.P3;
  const maximum = Math.max(1, ...Object.values(v.pulls.states));
  return (
    <div className="review-observation-content">
      <div className="observation-period">
        <span>
          {new Date(v.window.from).toLocaleDateString()} —{' '}
          {new Date(v.observedAt).toLocaleDateString()}
        </span>
        <span>마지막 관측 {new Date(v.observedAt).toLocaleTimeString()}</span>
      </div>
      {v.window.truncated ? (
        <p className="observation-notice" role="status">
          최신 분석 {v.window.runLimit}건으로 제한한 표본입니다. 저장소 전체 집계가 아닙니다.
        </p>
      ) : null}
      <dl className="observation-metrics">
        <div>
          <dt>리뷰한 PR</dt>
          <dd>
            {v.pulls.included.toLocaleString()}
            <small>개</small>
          </dd>
          <p>PR별 최신 공용 분석</p>
        </div>
        <div>
          <dt>P2·P3 지적</dt>
          <dd>
            {risks.toLocaleString()}
            <small>개</small>
          </dd>
          <p>P2·P3 지적 {risks}개 · 데모 제외</p>
        </div>
        <div>
          <dt>재관측된 지적</dt>
          <dd>
            {v.pulls.recurrence.repeated.toLocaleString()}
            <small>개</small>
          </dd>
          <p>코드·설명에서 다시 확인</p>
        </div>
        <div>
          <dt>모델 호출 예약·시도</dt>
          <dd>
            {v.effort.ledgerAttempts.toLocaleString()}
            <small>건</small>
          </dd>
          <p>기간 내 분석·재시도 포함</p>
        </div>
      </dl>
      <div className="observation-primary-grid">
        <section className="observation-panel">
          <header>
            <h2>PR별 최신 리뷰</h2>
            <span>PR {v.pulls.included}개</span>
          </header>
          <p className="observation-caption">분석 완료는 결함 해결을 뜻하지 않습니다.</p>
          <div className="observation-status-list">
            {Object.entries(v.pulls.states).map(([state, count]) => (
              <div className="observation-status-row" key={state}>
                <span>{states[state] ?? state}</span>
                <div className="observation-bar" aria-hidden="true">
                  <i data-state={state} style={{ width: `${(count / maximum) * 100}%` }} />
                </div>
                <strong>
                  {count}
                  <small>건</small>
                </strong>
              </div>
            ))}
          </div>
          {!Object.keys(v.pulls.states).length ? (
            <p className="observation-empty">선택 기간에 분석한 PR이 없습니다.</p>
          ) : null}
          <div className="observation-facts">
            <span>
              현재 관측 head와 일치 <strong>{v.pulls.latestAtObservedHead}</strong>
            </span>
            <span>
              다른 head <strong>{v.pulls.latestAtOtherHead}</strong>
            </span>
            <span>
              보고서 없음 <strong>{v.pulls.included - v.pulls.reports}</strong>
            </span>
          </div>
          <details>
            <summary>보고서 범위와 비교 근거</summary>
            <p>
              기간 안에 생성한 분석 중 PR마다 최신 공용 분석 한 건을 셉니다. 공용 분석{' '}
              {v.window.includedRuns}건 · PR {v.pulls.included}개
            </p>
            <p>
              검토 출처:{' '}
              {Object.entries(v.pulls.reviewStatuses)
                .map(([state, count]) => `${states[state] ?? state} ${count}건`)
                .join(' · ') || '기록 없음'}
              . 데모 보고서 {v.pulls.fixtureReports}건은 지적·판단 합계에서 제외합니다.
            </p>
            <p>
              보고서 {v.pulls.reports}건 중 관측 기록 {v.pulls.recordedReports}건 · 미기록{' '}
              {v.pulls.unrecordedReports}건
            </p>
            <p>
              이전 보고서 비교 {v.pulls.recurrence.comparedReports}건 · 비교 불가·기준 없음·미기록{' '}
              {v.pulls.recurrence.unavailableReports}건 · 재확인하지 못한 이전 지적{' '}
              {v.pulls.recurrence.unconfirmedPrevious}개
            </p>
          </details>
        </section>
        <section className="observation-panel">
          <header>
            <h2>모델의 기준 판단</h2>
            <span>지적별 기준 연결</span>
          </header>
          <dl className="observation-criteria">
            <div>
              <dt>
                <span className="observation-dot warning" />
                위반 가능성
              </dt>
              <dd>{v.pulls.criteria.violation}</dd>
            </div>
            <div>
              <dt>
                <span className="observation-dot positive" />
                충족 판단
              </dt>
              <dd>{v.pulls.criteria.satisfied}</dd>
            </div>
            <div>
              <dt>
                <span className="observation-dot" />
                판단 미완료
              </dt>
              <dd>{v.pulls.criteria.uncertain}</dd>
            </div>
          </dl>
          <div className="observation-facts">
            <span>
              기준 판단 미보고 <strong>{v.pulls.criteria.notReported}개</strong>
            </span>
            <span>
              연결 불가 <strong>{v.pulls.criteria.unavailable}개</strong>
            </span>
          </div>
          <p className="observation-caption">미보고·미완료를 통과로 세지 않습니다.</p>
          <p className="observation-caption">실제 오탐률과 사고 감소율은 확인되지 않았습니다.</p>
        </section>
      </div>
      <section className="observation-panel">
        <header>
          <h2>분석 호출과 소요 시간</h2>
          <span>전체 분석·재시도</span>
        </header>
        <p className="observation-caption">
          기간 내 분석과 재시도를 모두 포함합니다. PR별 최신 리뷰 집계와 분모가 다릅니다.
        </p>
        <div className="observation-effort">
          <div>
            <span>기록된 분석 시간 합계</span>
            <strong>
              {(v.effort.totalReportedDurationMs / 1000).toLocaleString()}
              <small>초</small>
            </strong>
            <p>보고서 {v.effort.recordedDurations}개 · 병렬 실행 시간 합산</p>
          </div>
          <div>
            <span>기록된 요청 입력</span>
            <strong>
              {v.effort.inputBytes.toLocaleString()}
              <small>bytes</small>
            </strong>
            <p>토큰 사용량·청구 금액 미관측</p>
          </div>
        </div>
        <div className="observation-facts">
          <span>
            호출 기록 있는 분석 <strong>{v.effort.runsWithLedger}건</strong>
          </span>
          <span>
            호출 기록 없는 분석 <strong>{v.effort.runsWithoutLedger}건</strong>
          </span>
        </div>
        <details>
          <summary>호출 상태와 집계 한계</summary>
          <ul>
            {Object.entries(v.effort.ledgerStates).map(([state, count]) => (
              <li key={state}>
                {states[state] ?? state}: {count}건
              </li>
            ))}
          </ul>
          <p>
            시간 미기록 분석 {v.effort.unrecordedDurations}건 · 제외한 데모 시간{' '}
            {v.effort.fixtureDurations}건. 시간 합계는 경과 시간과 다를 수 있습니다. 기록이 없다는
            사실은 호출하지 않았다는 뜻이 아닙니다.
          </p>
        </details>
      </section>
      <section className="observation-panel">
        <header>
          <h2>공용 기준과 발행</h2>
          <span>현재 revision</span>
        </header>
        <p className="observation-caption">
          현재 기준 revision의 판단이며 현재 PR 지적의 정답·오답 판정 수가 아닙니다.
        </p>
        {v.decisions.length ? (
          <div className="observation-tags">
            {v.decisions.map((d) => (
              <span key={d.state + ':' + d.outcome}>
                {states[d.state] ?? d.state} · {outcomes[d.outcome] ?? d.outcome}{' '}
                <strong>{d.count}</strong>
              </span>
            ))}
          </div>
        ) : (
          <p className="observation-empty">등록된 판단이 없습니다.</p>
        )}
        {v.publication.length ? (
          <div className="observation-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>발행 대상</th>
                  <th>상태</th>
                  <th>버전</th>
                  <th>기간 내 발행</th>
                </tr>
              </thead>
              <tbody>
                {v.publication.map((p) => (
                  <tr key={p.component}>
                    <td>{p.component === 'policy' ? '공용 policy' : '공용 collective'}</td>
                    <td>{states[p.state] ?? p.state}</td>
                    <td>sequence {p.releaseSequence}</td>
                    <td>{p.publishedInWindow}건</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="observation-empty">공용 발행 기록이 없습니다.</p>
        )}
      </section>
      <section className="observation-panel">
        <header>
          <h2>중앙 다운로드 응답</h2>
          <span>manifest · bundle</span>
        </header>
        {v.downloads.responses.length ? (
          <div className="observation-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>요청</th>
                  <th>HTTP</th>
                  <th>응답 수</th>
                  <th>평균 응답 시간</th>
                </tr>
              </thead>
              <tbody>
                {v.downloads.responses.map((r) => (
                  <tr key={r.route + ':' + r.status}>
                    <td>{r.route}</td>
                    <td>
                      <code>{r.status}</code>
                    </td>
                    <td>{r.count}</td>
                    <td>{r.count ? Math.round(r.totalDurationMs / r.count) : 0} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="observation-empty">
            기록된 응답이 없습니다. 실제 요청이 없었다는 뜻은 아닙니다.
          </p>
        )}
        <details>
          <summary>다운로드 집계 범위</summary>
          <p>
            기록 시작: {v.downloads.since ? new Date(v.downloads.since).toLocaleString() : '미확인'}
            . 선택 기간이 걸치는 UTC 날짜 단위로 집계합니다. 저장소 인가를 통과한 manifest·bundle
            GET 응답만 기록하며 장애·과부하·프로세스 종료로 누락될 수 있습니다.
          </p>
        </details>
      </section>
      <p className="observation-local-note">
        로컬 실행 여부: 알 수 없음 · 로컬 적용 여부: 알 수 없음. 로컬 모델 호출·시간·리뷰 결과는
        로컬에만 보관합니다.
      </p>
    </div>
  );
}
function RepositoryObservations({
  repositoryId,
  days,
}: {
  repositoryId: string;
  days: 7 | 30 | 90;
}) {
  const [value, setValue] = useState<ReviewObservations | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    const c = new AbortController();
    void fetchJson(
      `/api/v1/repositories/${repositoryId}/review-observations?days=${days}`,
      c.signal,
    )
      .then((raw) => {
        if (!c.signal.aborted) setValue(reviewObservationsSchema.parse(raw));
      })
      .catch(() => {
        if (!c.signal.aborted)
          setError('관측 기록을 불러오지 못했습니다. 저장소 권한과 연결 상태를 확인해 주세요.');
      });
    return () => c.abort();
  }, [repositoryId, days]);
  return error ? (
    <p role="alert">{error}</p>
  ) : value ? (
    <ReviewObservations value={value} />
  ) : (
    <p role="status">관측 기록을 불러오고 있습니다.</p>
  );
}
export function ReviewObservationsPage() {
  const [user, setUser] = useState<User | null>(null),
    [repos, setRepos] = useState<Awaited<ReturnType<typeof loadCriteriaRepositories>>>([]),
    [repo, setRepo] = useState(''),
    [days, setDays] = useState<7 | 30 | 90>(30),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    void Promise.all([loadCurrentUser(c.signal), loadCriteriaRepositories(c.signal)])
      .then(([u, r]) => {
        if (c.signal.aborted) return;
        setUser(u);
        setRepos(r);
        const id = new URLSearchParams(window.location.search).get('repositoryId');
        setRepo(r.find((x) => x.id === id)?.id ?? r[0]?.id ?? '');
        setLoading(false);
      })
      .catch(() => {
        if (!c.signal.aborted) {
          setError('저장소 목록을 불러오지 못했습니다.');
          setLoading(false);
        }
      });
    return () => c.abort();
  }, []);
  return (
    <>
      <AppHeader user={user} />
      <main className="review-observations">
        <header className="observation-page-heading">
          <div>
            <p className="observation-eyebrow">REVIEW INSIGHTS</p>
            <h1>중앙 리뷰 관측</h1>
            <p>저장소의 리뷰 현황과 기준 판단, 실행 기록을 확인합니다.</p>
          </div>
          {repo ? (
            <a href={`/review-history?repositoryId=${encodeURIComponent(repo)}`}>
              리뷰 이력 보기 →
            </a>
          ) : null}
        </header>
        {error ? <p role="alert">{error}</p> : null}
        <div className="observation-controls">
          <label>
            저장소{' '}
            <select
              aria-label="조회 저장소"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              disabled={!repos.length}
            >
              {repos.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.owner}/{r.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            기간{' '}
            <select
              aria-label="조회 기간"
              value={days}
              onChange={(e) => setDays(Number(e.target.value) as 7 | 30 | 90)}
            >
              <option value={7}>최근 7일</option>
              <option value={30}>최근 30일</option>
              <option value={90}>최근 90일</option>
            </select>
          </label>
          <button type="button" onClick={() => setRefresh((x) => x + 1)} disabled={!repo}>
            새로고침
          </button>
        </div>
        {loading ? (
          <p role="status">저장소를 불러오고 있습니다.</p>
        ) : repo ? (
          <RepositoryObservations
            key={repo + ':' + days + ':' + refresh}
            repositoryId={repo}
            days={days}
          />
        ) : !error ? (
          <p>조회할 수 있는 저장소가 없습니다.</p>
        ) : null}
      </main>
    </>
  );
}
