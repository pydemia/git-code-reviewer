import type { ReviewRecurrence as Recurrence } from '@gcr/contracts';

const labels = {
  'observed-again': '다른 SHA에서 재관측',
  'same-head': '같은 SHA에서 재관측',
  'not-in-baseline': '비교 보고서에 없음',
  untracked: '비교 식별자 없음',
  ambiguous: '중복 위치로 연결 보류',
};
export function ReviewRecurrence({ value }: { value: Recurrence | undefined }) {
  if (!value) return null;
  const counts = Object.fromEntries(
    Object.keys(labels).map((status) => [
      status,
      value.items.filter((item) => item.status === status).length,
    ]),
  );
  return (
    <details className="review-recurrence">
      <summary>
        이전 리뷰와 비교
        {value.unconfirmedPrevious.length ? ` · 재확인 ${value.unconfirmedPrevious.length}개` : ''}
      </summary>
      <p>{value.reason}</p>
      {value.baseline ? (
        <>
          <p>
            <a href={`/reviews/${value.baseline.analysisId}`}>비교 보고서</a> · SHA{' '}
            {value.baseline.headSha.slice(0, 12)} ·{' '}
            {value.baseline.state === 'partial' ? '일부 검토' : '검토 완료'}
          </p>
          <ul>
            {Object.entries(labels)
              .filter(([status]) => counts[status])
              .map(([status, label]) => (
                <li key={status}>
                  {label}: {counts[status]}개
                </li>
              ))}
          </ul>
          <p>
            현재 지적은 모두 유지됩니다. 같은 코드·설명이라는 비교 결과이며 결함 재현이나 수정 완료
            판정은 아닙니다.
          </p>
          {value.unconfirmedPrevious.length ? (
            <details>
              <summary>재확인하지 못한 이전 지적 · {value.unconfirmedPrevious.length}개</summary>
              <ul>
                {value.unconfirmedPrevious.map((item) => (
                  <li key={item.findingId}>
                    <a href={`/reviews/${value.baseline!.analysisId}?finding=${item.findingId}`}>
                      {item.priority} · {item.title}
                    </a>
                    {item.path ? ` · ${item.path}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </details>
  );
}
