import { useEffect, useRef, useState } from 'react';
import { ciValidationViewSchema, type CiValidationView } from '@gcr/contracts';

const outcomes = { passed: '성공', failed: '실패', incomplete: '미완료', unavailable: '확인 불가' };

/** Key this component by analysisId so navigation immediately discards previous evidence. */
export function CiValidationEvidence({ analysisId }: { analysisId: string }) {
  const [value, setValue] = useState<CiValidationView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function refresh() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setValue(null);
    setError('');
    try {
      const response = await fetch(
        `/api/v1/analyses/${encodeURIComponent(analysisId)}/ci-validation`,
        {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        },
      );
      if (!response.ok) throw Error('CI evidence unavailable');
      const next = ciValidationViewSchema.parse(await response.json());
      if (next.analysisId !== analysisId) throw Error('CI analysis mismatch');
      if (!controller.signal.aborted) setValue(next);
    } catch {
      if (!controller.signal.aborted)
        setError('CI 근거를 조회하지 못했습니다. 접근 권한과 연결 상태를 확인해 주세요.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  return (
    <details className="report-provenance ci-validation">
      <summary>중앙 CI 검증 근거</summary>
      <p>
        조회 시점의 CI 결과를 이 보고서의 분석 입력과 대조합니다. 과거 보고서는 해당 소스 기준이며
        현재 PR의 통과 여부를 뜻하지 않습니다.
      </p>
      <button type="button" disabled={loading} onClick={() => void refresh()}>
        {loading ? '조회 중…' : value ? '다시 조회' : 'CI 근거 조회'}
      </button>
      <div aria-live="polite" aria-busy={loading}>
        {error ? <p role="alert">{error}</p> : null}
        {value ? (
          <>
            <p>{value.reason}</p>
            <p>
              조회 시각: <time dateTime={value.observedAt}>{value.observedAt}</time>
            </p>
            {value.evidence.map((evidence) => (
              <article key={evidence.payloadHash}>
                <h4>
                  CI 실행 {evidence.runId} · 시도 {evidence.attempt}
                </h4>
                <p>
                  발급자: {evidence.issuer} · 공개키: {evidence.keyId}
                </p>
                <p>
                  근거 만료: <time dateTime={evidence.expiresAt}>{evidence.expiresAt}</time>
                </p>
                <p>
                  서명과 입력이 일치한 CI의 진술입니다. 개별 리뷰 지적의 재현 여부나 수정 완료를
                  자동 판정하지 않습니다.
                </p>
                {evidence.checks.map((check) => (
                  <section key={check.id} aria-label={check.name}>
                    <h5>
                      {check.name} · {outcomes[check.outcome]}
                    </h5>
                    <dl>
                      <dt>실행 명령</dt>
                      <dd>
                        <code>{check.command}</code>
                      </dd>
                      <dt>기대 결과</dt>
                      <dd>{check.expected}</dd>
                      <dt>실제 결과</dt>
                      <dd>{check.actual}</dd>
                      <dt>종료 코드</dt>
                      <dd>{check.exitCode ?? '없음'}</dd>
                    </dl>
                  </section>
                ))}
              </article>
            ))}
            {value.rejected.length ? (
              <details>
                <summary>채택하지 않은 CI 근거 · {value.rejected.length}개</summary>
                <ul>
                  {value.rejected.map((item) => (
                    <li key={item.checkRunId}>
                      Check {item.checkRunId}: {item.reason}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {value.input ? (
              <details>
                <summary>대조한 분석 입력</summary>
                <pre>{JSON.stringify(value.input, null, 2)}</pre>
              </details>
            ) : null}
          </>
        ) : null}
      </div>
    </details>
  );
}
