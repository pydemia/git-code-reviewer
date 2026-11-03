import { useEffect, useState } from 'react';
import { analysisSharedKnowledgeSchema, type AnalysisSharedKnowledge } from '@gcr/contracts';
import { fetchJson } from './api.ts';
export function SharedKnowledgePanel({ analysisId }: { analysisId: string }) {
  const [data, setData] = useState<AnalysisSharedKnowledge | null>(null),
    [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetchJson(`/api/v1/analyses/${analysisId}/shared-knowledge`, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setData(analysisSharedKnowledgeSchema.parse(value));
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [analysisId]);
  return (
    <details className="report-section shared-knowledge-panel" aria-label="공용 리뷰 기준 버전">
      <summary>공용 리뷰 기준 버전</summary>
      {error ? (
        <p role="alert">이 분석의 공용 기준 정보를 불러오지 못했습니다.</p>
      ) : !data ? (
        <p role="status">기준 정보를 불러오는 중입니다.</p>
      ) : (
        <>
          {data.reason ? (
            <p>{data.reason}</p>
          ) : (
            <p>
              분석 접수 때 고정한 발행본입니다. 선택된 항목은 검토 입력이며 결함 확인이나 테스트
              실행을 뜻하지 않습니다.
            </p>
          )}
          {data.status === 'queued' ? (
            <p>발행본을 고정했으며 원문별 기준 선택은 아직 기록되지 않았습니다.</p>
          ) : null}
          {data.releases.length ? (
            <ul>
              {data.releases.map((release) => (
                <li key={release.component}>
                  {release.component === 'policy' ? '기준·Skill' : '집단 Memory'} · 발행{' '}
                  {release.sequence} · <code>{release.hash.slice(0, 12)}</code>
                </li>
              ))}
            </ul>
          ) : null}
          {data.selection ? (
            <>
              <p>
                선택 {data.selection.items.length}개 · 제외 {data.selection.omitted}개 ·{' '}
                {new Date(data.selection.selectedAt).toLocaleString('ko-KR')}
              </p>
              <ul>
                {data.selection.items.map((item) => (
                  <li key={`${item.component}:${item.kind}:${item.id}`}>
                    <details>
                      <summary>
                        {{ policy: '검토 기준', skill: 'Skill', memory: '집단 Memory' }[item.kind]}{' '}
                        · {item.title} · v{item.revision}
                      </summary>
                      <p>{item.targets.map((t) => t.path).join(', ')}</p>
                      <small>
                        {item.id} · {item.hash.slice(0, 12)}
                      </small>
                    </details>
                  </li>
                ))}
              </ul>
              {data.selection.validUntil ? (
                <p>
                  예외·만료 시각 {new Date(data.selection.validUntil).toLocaleString('ko-KR')}{' '}
                  이후에는 새 분석이 필요합니다.
                </p>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </details>
  );
}
