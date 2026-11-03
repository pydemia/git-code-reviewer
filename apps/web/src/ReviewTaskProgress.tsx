import { useEffect, useState } from 'react';
import { fetchJson, mutateJson } from './api.ts';
type Tasks = {
  planHash: string | null;
  filesTotal: number;
  filesExcluded: number;
  tasks: Array<{ state: string; count: number; retryAt: string | null; errorCode?: string }>;
  modelLimit?: { code: string; retryAt: string; active: boolean } | null;
  canResume: boolean;
  maxAdditionalModelCalls: number;
};
const labels: Record<string, string> = {
  pending: '대기',
  running: '실행 중',
  completed: '완료',
  'retry-wait': '재시도 대기',
  'budget-wait': '예산 대기',
  failed: '실패',
  blocked: '입력 분할 필요',
};
export function ReviewTaskProgress({
  analysisId,
  state,
}: {
  analysisId: string;
  state: string | null;
}) {
  const [data, setData] = useState<Tasks | null>(null),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setData(null);
    setError('');
    const load = async () => {
      let quotaWait = false;
      try {
        const next = (await fetchJson(
          `/api/v1/analyses/${analysisId}/review-tasks`,
          controller.signal,
        )) as Tasks;
        quotaWait = next.modelLimit?.active ?? false;
        if (!controller.signal.aborted) {
          setData(next);
          setError('');
        }
      } catch {
        if (!controller.signal.aborted) setError('묶음 검토 상태를 불러오지 못했습니다.');
      } finally {
        if (
          !controller.signal.aborted &&
          (state === 'queued' || state === 'analyzing' || quotaWait)
        )
          timer = setTimeout(() => void load(), quotaWait ? 30000 : 5000);
      }
    };
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [analysisId, state]);
  if (!data?.planHash)
    return error ? (
      <p className="review-task-status" role="status">
        {error}
      </p>
    ) : null;
  const total = data.tasks.reduce((n, t) => n + t.count, 0),
    complete = data.tasks.filter((t) => t.state === 'completed').reduce((n, t) => n + t.count, 0);
  const resume = async () => {
    setSaving(true);
    setError('');
    try {
      const next = (await mutateJson(`/api/v1/analyses/${analysisId}/resume`, 'POST')) as {
        analysisId: string;
      };
      window.location.assign(`/reviews/${next.analysisId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '검토 재개에 실패했습니다.');
      setSaving(false);
    }
  };
  return (
    <section className="review-task-status" aria-label="묶음 검토 상태">
      <p>
        <strong>
          묶음 검토 {complete}/{total}
        </strong>{' '}
        · 전체 {data.filesTotal}파일 · 정책상 제외 {data.filesExcluded}파일
      </p>
      <p aria-live="polite">
        {data.tasks
          .filter((t) => t.state !== 'completed' && t.count)
          .map(
            (t) =>
              `${t.errorCode === 'MODEL_USAGE_LIMIT_REACHED' || (t.state === 'budget-wait' && data.modelLimit) ? '계정 사용량 제한' : (labels[t.state] ?? t.state)} ${t.count}${t.retryAt ? ` (재개 가능 ${new Date(t.retryAt).toLocaleString()})` : ''}`,
          )
          .join(' · ') || '모든 묶음의 응답 검증을 마쳤습니다.'}
      </p>
      {data.modelLimit ? (
        <p role="status">
          {data.modelLimit.active
            ? '모델 계정 사용량 제한으로 검토가 중단되었습니다.'
            : '이전 검토는 모델 계정 사용량 제한으로 중단되었습니다.'}{' '}
          재개 가능 시각: {new Date(data.modelLimit.retryAt).toLocaleString()}. 완료된 묶음은
          보존됩니다.
        </p>
      ) : null}
      {(state === 'partial' || state === 'failed') && data.canResume ? (
        <div>
          <button
            className="command-button"
            type="button"
            disabled={saving || data.modelLimit?.active}
            onClick={() => void resume()}
          >
            {saving ? '재개 요청 중…' : '남은 검토 재개'}
          </button>
          <small>
            새 보고서에서 계속합니다. 입력이 같은 완료 묶음은 재사용하며 모델을 최대{' '}
            {data.maxAdditionalModelCalls}회 추가 호출합니다.
          </small>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
