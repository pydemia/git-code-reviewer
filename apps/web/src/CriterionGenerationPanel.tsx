import { useEffect, useState, type FormEvent } from 'react';
import {
  criterionGenerationCreateSchema,
  type CriterionGenerationCreate,
  type CriterionGeneration,
} from '@gcr/contracts';
import {
  loadChatAccounts,
  loadCriterionGenerations,
  requestCriterionGeneration,
  cancelCriterionGeneration,
  type ChatAccountCatalog,
  type loadCriterionSources,
} from './api.ts';
const states = {
  queued: '대기 중',
  running: '생성 중',
  completed: '후보 등록 완료',
  failed: '생성 실패',
  uncertain: '결과 확인 불가',
  cancelled: '취소됨',
};
const errors: Record<string, string> = {
  MODEL_CAPACITY: '모델 계정의 호출 여유가 없습니다.',
  MODEL_OUTPUT_INVALID: '모델 응답이 기준 형식에 맞지 않습니다.',
  MODEL_RESULT_UNKNOWN: '모델 실행 결과를 확인하지 못했습니다. 자동으로 다시 호출하지 않습니다.',
  EXECUTION_LOST: '실행 프로세스의 결과를 확인하지 못했습니다.',
  GENERATION_SOURCE_CHANGED: '생성 중 원문이 변경됐습니다. 최신 출처를 확인해 주세요.',
  GENERATION_ACCESS_REVOKED: '저장소 또는 유지관리 권한이 변경됐습니다.',
  GENERATION_MODEL_UNAVAILABLE: '선택한 모델 계정을 사용할 수 없습니다.',
};
export function CriterionGenerationPanel({
  repositoryId,
  sources,
  onOpen,
}: {
  repositoryId: string;
  sources: Awaited<ReturnType<typeof loadCriterionSources>>;
  onOpen: (ruleId: string) => void;
}) {
  const [catalog, setCatalog] = useState<ChatAccountCatalog | null>(null);
  const [accountId, setAccountId] = useState('');
  const [modelName, setModelName] = useState('');
  const [effort, setEffort] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [runs, setRuns] = useState<CriterionGeneration[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState<CriterionGenerationCreate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const account = catalog?.items.find((item) => item.id === accountId);
  const model = account?.models.find((item) => item.id === modelName);
  const active = runs.some((run) => ['queued', 'running'].includes(run.state));
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await loadCriterionGenerations(repositoryId, controller.signal);
        if (!controller.signal.aborted) {
          setRuns(result.items);
          setEnabled(result.enabled);
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '생성 상태를 불러오지 못했습니다.');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    void loadChatAccounts(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setCatalog(result);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '모델 계정을 불러오지 못했습니다.');
      });
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [repositoryId]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    const data = new FormData(event.currentTarget);
    const manual = String(data.get('source') ?? '').trim();
    const parsed = criterionGenerationCreateSchema.safeParse(
      pending ?? {
        requestId: crypto.randomUUID(),
        accountId,
        modelName,
        reasoningEffort: effort,
        focus: data.get('focus'),
        sources: [
          ...sources
            .filter((source) => selected.includes(`${source.kind}:${source.id}`))
            .map(({ kind, id, contentHash, observationHash }) => ({
              kind,
              id,
              contentHash,
              ...(observationHash ? { observationHash } : {}),
            })),
          ...(manual ? [{ kind: 'manual', content: manual }] : []),
        ],
      },
    );
    if (!parsed.success) {
      setError('계정·모델·effort, 검토 초점과 출처를 지정해 주세요. 출처는 최대 6개입니다.');
      return;
    }
    setPending(parsed.data);
    setBusy(true);
    try {
      const result = await requestCriterionGeneration(repositoryId, parsed.data);
      setRuns((previous) =>
        [result, ...previous.filter((run) => run.id !== result.id)].slice(0, 20),
      );
      setPending(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : '접수 결과를 확인하지 못했습니다. 같은 요청 확인으로 중복 호출 없이 조회할 수 있습니다.',
      );
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      const result = await cancelCriterionGeneration(repositoryId, id);
      setRuns((previous) => previous.map((run) => (run.id === id ? result : run)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '취소하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="criteria-generation">
      <summary>원문에서 모델 후보 생성</summary>
      <p>
        선택한 원문과 검토 초점만 등록된 모델 계정으로 전송합니다. 결과는 평가·승인 전 후보로
        등록되며 원문에 없는 사실은 직접 확인해야 합니다.
      </p>
      {!enabled ? <p>등록된 모델 계정을 사용하는 후보 생성이 활성화되지 않았습니다.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy || active || Boolean(pending) || !enabled}>
          <div className="criteria-fields">
            <label>
              모델 계정
              <select
                aria-label="모델 계정"
                value={accountId}
                onChange={(event) => {
                  setAccountId(event.target.value);
                  setModelName('');
                  setEffort('');
                }}
              >
                <option value="">계정 선택</option>
                {catalog?.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              후보 생성 모델
              <select
                aria-label="후보 생성 모델"
                value={modelName}
                onChange={(event) => {
                  setModelName(event.target.value);
                  setEffort(
                    account?.models.find((model) => model.id === event.target.value)
                      ?.defaultEffort ?? '',
                  );
                }}
              >
                <option value="">모델 선택</option>
                {account?.models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              추론 수준
              <select
                aria-label="추론 수준"
                value={effort}
                onChange={(event) => setEffort(event.target.value)}
              >
                <option value="">선택</option>
                {model?.allowedEfforts.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            검토 초점
            <textarea
              aria-label="검토 초점"
              name="focus"
              maxLength={2000}
              required
              placeholder="예: 테넌트 격리 조건과 호출부의 반증을 기준으로 정리"
            />
          </label>
          <details>
            <summary>기존 PR 논의·집단 메모리 선택</summary>
            {sources.map((source) => (
              <label className="criteria-source-choice" key={`${source.kind}:${source.id}`}>
                <input
                  type="checkbox"
                  checked={selected.includes(`${source.kind}:${source.id}`)}
                  onChange={(event) =>
                    setSelected((previous) =>
                      event.target.checked
                        ? [...previous, `${source.kind}:${source.id}`]
                        : previous.filter((key) => key !== `${source.kind}:${source.id}`),
                    )
                  }
                />
                <span>
                  {source.label}
                  <small>{source.content.slice(0, 240)}</small>
                </span>
              </label>
            ))}
          </details>
          <label>
            모델에 전달할 수동 원문
            <textarea aria-label="모델에 전달할 수동 원문" name="source" maxLength={8000} />
          </label>
        </fieldset>
        <button type="submit" disabled={busy || (!pending && (active || !enabled))}>
          {pending ? '같은 생성 요청 확인' : '후보 생성 요청'}
        </button>
        {pending ? (
          <button type="button" disabled={busy} onClick={() => setPending(null)}>
            입력 다시 선택
          </button>
        ) : null}
      </form>
      <ul>
        {runs.map((run) => (
          <li key={run.id}>
            <strong>{states[run.state]}</strong> · {run.modelName} · {run.reasoningEffort}
            <small>{new Date(run.createdAt).toLocaleString('ko-KR')}</small>
            {run.errorCode ? (
              <p>{errors[run.errorCode] ?? '후보 생성을 완료하지 못했습니다.'}</p>
            ) : null}
            {run.ruleId ? (
              <button onClick={() => onOpen(run.ruleId!)}>생성한 후보 보기</button>
            ) : null}
            {['queued', 'running'].includes(run.state) ? (
              <button disabled={busy} onClick={() => void cancel(run.id)}>
                생성 취소
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <small>
        취소 전에 전송된 요청은 모델 사용량에 포함될 수 있습니다. 결과 확인 불가 상태에서는 새
        요청을 명시적으로 제출해야 다시 실행됩니다.
      </small>
    </details>
  );
}
