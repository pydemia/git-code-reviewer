import type { FindingCriteria as Criteria } from '@gcr/contracts';

const outcomes = { violation: '위반 가능성', satisfied: '충족 판단', uncertain: '판단 미완료' };
export function FindingCriteria({ criteria }: { criteria: Criteria | undefined }) {
  if (!criteria) return null;
  return (
    <details className="finding-criteria">
      <summary>공용 기준 판단 · {criteria.items.length}개</summary>
      <p>
        모델이 제시한 판단입니다. 기준 버전과 적용 파일의 연결을 확인했으며 결함 확정이나 테스트
        실행 증거는 아닙니다.
      </p>
      {criteria.status === 'not-reported' ? (
        <p>이 지적에 대한 기준별 판단이 보고되지 않았습니다. 기준을 충족했다는 뜻은 아닙니다.</p>
      ) : null}
      {criteria.rejected ? (
        <p>연결 조건을 충족하지 못한 판단 {criteria.rejected}개를 제외했습니다.</p>
      ) : null}
      {criteria.items.map((item) => (
        <section key={item.id}>
          <b>
            {item.title} · v{item.revision} · {outcomes[item.outcome]}
          </b>
          <p>{item.rationale}</p>
          <p>
            반증 {item.counterEvidence.status === 'reviewed' ? '검토' : '미검토'}:{' '}
            {item.counterEvidence.explanation}
          </p>
          <details>
            <summary>기준·원문 식별 정보</summary>
            <dl>
              <dt>기준 ID</dt>
              <dd>{item.id}</dd>
              <dt>기준 hash</dt>
              <dd>{item.hash}</dd>
              <dt>파일 hash</dt>
              <dd>{item.sourceHash}</dd>
              <dt>발행본 hash</dt>
              <dd>{item.pinHash}</dd>
              <dt>선택 context hash</dt>
              <dd>{item.contextHash}</dd>
            </dl>
          </details>
        </section>
      ))}
    </details>
  );
}
