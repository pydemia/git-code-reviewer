import { useEffect, useRef, useState } from 'react';
import {
  chatRunHistorySchema,
  chatRunViewSchema,
  type ChatRunHistory as History,
  type ChatRunView,
} from '@gcr/contracts';
import { ChatRunActivity } from './ChatRunActivity.tsx';

export function ChatRunHistory({
  sessionId,
  latestRunId,
  onEvidence,
  onSelect,
}: {
  sessionId: string;
  latestRunId: string | undefined;
  onEvidence: (runId: string, unitId: string) => void;
  onSelect: () => void;
}) {
  const key = `review-chat-history:${sessionId}`;
  const [items, setItems] = useState<History['items']>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [before, setBefore] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(() => {
    try {
      return sessionStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  });
  const [run, setRun] = useState<ChatRunView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const evidenceCallback = useRef(onEvidence);
  evidenceCallback.current = onEvidence;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void fetch(
      `/api/v1/chat-sessions/${sessionId}/run-history${before ? `?before=${before}` : ''}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw Error('history_unavailable');
        const history = chatRunHistorySchema.parse(await response.json());
        if (controller.signal.aborted) return;
        setItems((previous) =>
          before
            ? [
                ...previous.filter((item) => !history.items.some((next) => next.id === item.id)),
                ...history.items,
              ]
            : history.items,
        );
        setCursor(history.nextCursor);
        setError('');
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('분석 이력을 불러오지 못했습니다.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [sessionId, before, latestRunId, retry]);
  useEffect(() => {
    const controller = new AbortController();
    setRun(null);
    if (!selected) return;
    void fetch(`/api/v1/chat-runs/${selected}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw Error('history_unavailable');
        const next = chatRunViewSchema.parse(await response.json());
        if (controller.signal.aborted || next.sessionId !== sessionId) return;
        setRun(next);
        setError('');
        try {
          const unitId = sessionStorage.getItem(`${key}:source`);
          if (unitId && next.evidence.some((unit) => unit.id === unitId))
            evidenceCallback.current(next.id, unitId);
        } catch {
          return;
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('이전 답변에 접근할 수 없습니다. 권한 또는 보존 기간을 확인해 주세요.');
      });
    return () => controller.abort();
  }, [selected, sessionId, key, retry]);
  return (
    <details className="chat-run-history" open={selected ? true : undefined}>
      <summary>이전 분석과 코드 근거</summary>
      <label>
        분석 선택
        <select
          value={selected}
          onChange={(event) => {
            const next = event.target.value;
            onSelect();
            setSelected(next);
            try {
              sessionStorage.setItem(key, next);
              sessionStorage.removeItem(`${key}:source`);
            } catch {
              return;
            }
          }}
        >
          <option value="">이전 질문을 선택해 주세요</option>
          {selected && !items.some((item) => item.id === selected) ? (
            <option value={selected}>저장한 분석</option>
          ) : null}
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {new Date(item.createdAt).toLocaleString('ko-KR')} · {item.question}
            </option>
          ))}
        </select>
      </label>
      {loading ? <p role="status">이력을 불러오는 중입니다.</p> : null}
      {cursor ? (
        <button type="button" disabled={loading} onClick={() => setBefore(cursor)}>
          이전 질문 더 보기
        </button>
      ) : null}
      {error ? (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            다시 시도
          </button>
        </p>
      ) : null}
      {run ? (
        <ChatRunActivity
          key={run.id}
          run={run}
          readOnly
          error=""
          sending={false}
          onAnswer={async () => {}}
          onCancel={async () => {}}
          onEvidence={(unitId) => {
            try {
              sessionStorage.setItem(`${key}:source`, unitId);
            } catch {
              setError(
                '브라우저 저장 공간을 사용할 수 없어 다음 접속 때 위치가 복원되지 않습니다.',
              );
            }
            onEvidence(run.id, unitId);
          }}
        />
      ) : null}
    </details>
  );
}
