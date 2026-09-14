import type { CriterionReviewStatus } from '@gcr/contracts';

export function CriterionRecheckPanel({ status }: { status: CriterionReviewStatus | undefined }) {
  if (!status) return null;
  const changed = status.sources.filter((source) => source.status === 'changed').length;
  const unavailable = status.sources.filter((source) => source.status === 'unavailable').length;
  return (
    <section className="criteria-recheck" aria-label="기준 재검토">
      <h3>{status.requiresReview ? '재검토가 필요합니다' : '출처 확인'}</h3>
      {status.promotionBlocked ? (
        <p>
          출처를 다시 확인해 새 버전을 작성해야 평가·승인을 진행할 수 있습니다. 현재 버전은 다음
          발행에서 제외됩니다.
        </p>
      ) : (
        <p>
          저장된 출처가 현재 조회 가능한 내용과 일치합니다. 이 확인은 기준의 정확성이나 코드 수정
          검증을 뜻하지 않습니다.
        </p>
      )}
      {changed + unavailable + status.expiredExceptions > 0 ||
      status.sourceSetChanged ||
      status.reviewDateReached ? (
        <ul>
          {changed > 0 ? <li>내용·상태·위치가 바뀐 출처 {changed}개</li> : null}
          {unavailable > 0 ? (
            <li>
              접근할 수 없거나 더 이상 사용할 수 없는 출처 {unavailable}개. 원문은 표시하지
              않습니다.
            </li>
          ) : null}
          {status.sourceSetChanged ? <li>저장된 출처 집합의 hash가 일치하지 않습니다.</li> : null}
          {status.reviewDateReached ? (
            <li>
              지정한 재검토 시각이 지났습니다. 날짜만으로 기준을 퇴역하거나 적용을 중단하지
              않습니다.
            </li>
          ) : null}
          {status.expiredExceptions > 0 ? (
            <li>
              만료된 예외 {status.expiredExceptions}개. 해당 범위에는 기준이 다시 적용되며 예외를
              연장하려면 새 요청과 승인이 필요합니다.
            </li>
          ) : null}
        </ul>
      ) : null}
      <small>확인 시각 {new Date(status.checkedAt).toLocaleString('ko-KR')}</small>
    </section>
  );
}
