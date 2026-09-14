import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  type CriterionSummary,
  type SubmissionIntakeAction,
  submissionIntakeActionSchema,
} from '@gcr/contracts';
import { loadCriteria, loadCriterion } from './api.ts';
import {
  loadReviewSubmissions,
  reviewClientSubmission,
  type SubmissionIntakeEntry,
} from './review-submission-api.ts';
import { CriterionForm } from './CriterionForm.tsx';
const states = {
  draft: '후보',
  evaluated: '평가 통과',
  shadow: '관찰 중',
  active: '활성',
  retired: '퇴역',
};
const kinds = { correction: '정정·오탐', exception: '예외 요청', judgment: '새 판단' };
const actions = {
  dismiss: '검토 종결',
  'create-candidate': '기준 후보로 채택',
  'link-feedback': '기준 요청으로 연결',
};
const resolutions = { acknowledge: '검토 접수', 'approve-exception': '예외 승인', reject: '거절' };
const message = (error: unknown) =>
  error instanceof Error ? error.message : '요청을 처리하지 못했습니다.';
export function ReviewSubmissionsPanel({
  repositoryId,
  onOpen,
}: {
  repositoryId: string;
  onOpen: (ruleId: string) => void;
}) {
  const [items, setItems] = useState<SubmissionIntakeEntry[]>([]);
  const [selected, setSelected] = useState<string>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [manage, setManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true),
    request = useRef<AbortController | undefined>(undefined);
  const reload = useCallback(
    async (next?: string) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setError('');
      try {
        const result = await loadReviewSubmissions(repositoryId, controller.signal, next);
        if (controller.signal.aborted || !alive.current) return;
        setItems((previous) =>
          next
            ? [
                ...previous,
                ...result.items.filter(
                  (item) => !previous.some((p) => p.receipt.id === item.receipt.id),
                ),
              ]
            : result.items,
        );
        setCursor(result.nextCursor);
        setManage(result.capabilities.manage);
        if (!next) setSelected(undefined);
      } catch (cause) {
        if (!controller.signal.aborted && alive.current) setError(message(cause));
      } finally {
        if (!controller.signal.aborted && alive.current) setLoading(false);
      }
    },
    [repositoryId],
  );
  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, [reload]);
  const entry = items.find((item) => item.receipt.id === selected);
  async function review(input: SubmissionIntakeAction) {
    if (!entry || busy) return;
    const parsed = submissionIntakeActionSchema.safeParse(input);
    if (!parsed.success) {
      setError('검토 메모, 기준 내용과 예외 범위·기간을 확인해 주세요.');
      return;
    }
    const id = entry.receipt.id;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await reviewClientSubmission(repositoryId, id, parsed.data);
      if (!alive.current) return;
      setItems((previous) =>
        previous.map((item) =>
          item.receipt.id === id ? { ...item, decision: result.decision } : item,
        ),
      );
      setNotice('검토 결과를 저장했습니다. 기준과 예외의 평가·승인은 연결된 기준에서 진행합니다.');
      if (result.decision.ruleId) onOpen(result.decision.ruleId);
    } catch (cause) {
      if (alive.current) setError(message(cause));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="criteria-submissions" aria-label="클라이언트 리뷰 제출">
      <div className="criteria-list-heading">
        <h2>클라이언트 리뷰 제출</h2>
        <button disabled={loading || busy} onClick={() => void reload()}>
          제출·승인 상태 새로고침
        </button>
      </div>
      <p>
        사용자가 공유한 피드백과 리뷰 상태입니다. 접수는 기준·예외 승인을 뜻하지 않으며 독립 검증
        전의 사용자 보고로 취급합니다. 원본 제출은 30일 보관합니다.
      </p>
      {error ? (
        <p className="criteria-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {loading ? <p role="status">제출 내용을 불러오는 중입니다.</p> : null}
      {!loading && !items.length ? <p>현재 보관 중인 제출이 없습니다.</p> : null}
      <div className="submission-list">
        {items.map((item) => (
          <button
            type="button"
            key={item.receipt.id}
            disabled={busy}
            aria-pressed={selected === item.receipt.id}
            onClick={() => {
              setSelected(item.receipt.id);
              setError('');
              setNotice('');
            }}
          >
            <strong>
              {item.submission.kind === 'feedback'
                ? kinds[item.submission.feedback.kind]
                : '리뷰 상태·건수'}
            </strong>
            <span>
              {item.decision ? actions[item.decision.action] : '검토 대기'} ·{' '}
              {item.submission.clientId} · {new Date(item.receipt.receivedAt).toLocaleString()}
            </span>
            {item.submission.kind === 'feedback' ? (
              <span>{item.submission.feedback.message.slice(0, 160)}</span>
            ) : null}
          </button>
        ))}
      </div>
      {cursor ? (
        <button disabled={loading || busy} onClick={() => void reload(cursor)}>
          다음 제출 불러오기
        </button>
      ) : null}
      {entry ? (
        <div className="submission-detail" key={entry.receipt.id}>
          <h3>제출 내용</h3>
          <p>
            제출자 {entry.submission.audience.userId} · 공개 범위: 저장소 열람 권한자 · 보관 만료{' '}
            {new Date(entry.receipt.expiresAt).toLocaleString()}
          </p>
          {entry.submission.kind === 'feedback' ? (
            <p className="criteria-prose">{entry.submission.feedback.message}</p>
          ) : (
            <p>
              리뷰 상태 {entry.submission.result.status} · 파일 {entry.submission.result.fileCount}
              개 · 지적 {entry.submission.result.findingCount}개
            </p>
          )}
          <details>
            <summary>제출 원문과 snapshot·rule·source 참조</summary>
            <pre className="criteria-prose">{JSON.stringify(entry.submission, null, 2)}</pre>
          </details>
          {entry.decision ? (
            <div>
              <p>
                {actions[entry.decision.action]} · {entry.decision.note}
              </p>
              {entry.decision.rule ? (
                <p>
                  연결된 기준: {states[entry.decision.rule.state]} · v{entry.decision.rule.revision}{' '}
                  <button disabled={busy} onClick={() => onOpen(entry.decision!.ruleId!)}>
                    연결된 기준 열기
                  </button>
                </p>
              ) : null}
              {entry.decision.feedbackId ? (
                <p>
                  요청 검토:{' '}
                  {entry.decision.feedbackResolution
                    ? resolutions[entry.decision.feedbackResolution.action]
                    : '검토 대기'}
                  {entry.decision.feedbackResolution
                    ? ` · ${entry.decision.feedbackResolution.note}`
                    : ''}
                </p>
              ) : null}
            </div>
          ) : manage ? (
            <SubmissionReviewForm
              key={entry.receipt.id}
              entry={entry}
              repositoryId={repositoryId}
              busy={busy}
              onReview={review}
            />
          ) : (
            <p>기준 관리자가 제출을 검토하고 후보나 정정·예외 요청으로 연결할 수 있습니다.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
function SubmissionReviewForm({
  entry,
  repositoryId,
  busy,
  onReview,
}: {
  entry: SubmissionIntakeEntry;
  repositoryId: string;
  busy: boolean;
  onReview: (input: SubmissionIntakeAction) => Promise<void>;
}) {
  const [choice, setChoice] = useState<'dismiss' | 'create-candidate' | 'link-feedback'>('dismiss');
  const [note, setNote] = useState('');
  const common = { expectedPayloadHash: entry.receipt.payloadHash, note };
  return (
    <div className="submission-review-form">
      <label>
        검토 처리
        <select
          aria-label="검토 처리"
          value={choice}
          disabled={busy}
          onChange={(event) => setChoice(event.target.value as typeof choice)}
        >
          <option value="dismiss">메모를 남기고 종결</option>
          {entry.submission.kind === 'feedback' ? (
            <option value="create-candidate">새 기준 후보로 채택</option>
          ) : null}
          {entry.submission.kind === 'feedback' && entry.submission.feedback.kind !== 'judgment' ? (
            <option value="link-feedback">기존 기준의 정정·예외 요청으로 연결</option>
          ) : null}
        </select>
      </label>
      <label>
        검토 메모
        <textarea
          required
          maxLength={2000}
          value={note}
          disabled={busy}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      {choice !== 'dismiss' ? (
        <p>
          채택한 내용과 사용자 제출 출처는 원본 제출의 보관 기간이 지난 뒤에도 기준·요청 이력에
          남습니다. 평가와 권한자의 승인은 연결된 기준에서 별도로 진행합니다.
        </p>
      ) : null}
      {choice === 'dismiss' ? (
        <button
          disabled={busy || !note.trim()}
          onClick={() => void onReview({ ...common, action: 'dismiss' })}
        >
          검토 종결
        </button>
      ) : null}
      {choice === 'create-candidate' && entry.submission.kind === 'feedback' ? (
        <CriterionForm
          detail={null}
          sources={[]}
          busy={busy}
          submissionSource={`Client-reported feedback\nSubmission: ${entry.receipt.id}\nPayload SHA-256: ${entry.receipt.payloadHash}\n\n${entry.submission.feedback.message}`}
          onCancel={() => setChoice('dismiss')}
          onSubmit={async (input) =>
            onReview({
              ...common,
              action: 'create-candidate',
              document: input.document,
              outcome: input.decision.outcome,
              reasoning: input.decision.reasoning,
            })
          }
        />
      ) : null}
      {choice === 'link-feedback' ? (
        <LinkFeedbackForm
          entry={entry}
          repositoryId={repositoryId}
          busy={busy}
          onSubmit={async (input) => onReview({ ...common, ...input })}
        />
      ) : null}
    </div>
  );
}
function LinkFeedbackForm({
  entry,
  repositoryId,
  busy,
  onSubmit,
}: {
  entry: SubmissionIntakeEntry;
  repositoryId: string;
  busy: boolean;
  onSubmit: (
    input: Omit<
      Extract<SubmissionIntakeAction, { action: 'link-feedback' }>,
      'note' | 'expectedPayloadHash'
    >,
  ) => Promise<void>;
}) {
  const [rules, setRules] = useState<CriterionSummary[]>([]),
    [ruleId, setRuleId] = useState(''),
    [error, setError] = useState('');
  const feedback = entry.submission.kind === 'feedback' ? entry.submission.feedback : null;
  const referenced = feedback?.rule?.id;
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const next = referenced
        ? [(await loadCriterion(repositoryId, referenced, controller.signal)).criterion]
        : (await loadCriteria(repositoryId, controller.signal)).items;
      if (controller.signal.aborted) return;
      setRules(next);
      setRuleId(next[0]?.id ?? '');
    })().catch((cause) => {
      if (!controller.signal.aborted) setError(message(cause));
    });
    return () => controller.abort();
  }, [repositoryId, referenced]);
  const rule = rules.find((r) => r.id === ruleId);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!rule) return;
    const data = new FormData(event.currentTarget),
      get = (key: string) => String(data.get(key) ?? '');
    const iso = (key: string) => {
      const value = Date.parse(get(key));
      return Number.isFinite(value) ? new Date(value).toISOString() : '';
    };
    void onSubmit({
      action: 'link-feedback',
      ruleId: rule.id,
      expectedVersion: rule.version,
      ...(feedback?.kind === 'exception'
        ? {
            exceptionTerms: {
              appliesTo: {
                languages: get('languages').split('\n').filter(Boolean),
                filePaths: get('filePaths').split('\n').filter(Boolean),
                symbols: get('symbols').split('\n').filter(Boolean),
                contracts: get('contracts').split('\n').filter(Boolean),
                branches: get('branches').split('\n').filter(Boolean),
              },
              startsAt: iso('startsAt'),
              expiresAt: iso('expiresAt'),
            },
          }
        : {}),
    });
  }
  return (
    <form className="criteria-form" onSubmit={submit}>
      <fieldset disabled={busy}>
        {error ? <p role="alert">{error}</p> : null}
        <label>
          연결할 기준
          <select value={ruleId} onChange={(event) => setRuleId(event.target.value)} required>
            {rules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.document.title} · {states[r.state]} · v{r.revision}
              </option>
            ))}
          </select>
        </label>
        {!referenced ? <small>최근 변경한 기준 최대 100개를 표시합니다.</small> : null}
        {feedback?.kind === 'exception' ? (
          <>
            <p>
              기준을 관찰 또는 활성 상태로 만든 뒤 예외를 요청하세요. 이 요청을 등록한 관리자와 다른
              지정 책임자가 승인해야 유효합니다.
            </p>
            <div className="criteria-fields">
              {(
                [
                  ['languages', '언어'],
                  ['filePaths', '파일 경로'],
                  ['symbols', '심볼'],
                  ['contracts', 'API 계약'],
                  ['branches', '브랜치'],
                ] as const
              ).map(([name, label]) => (
                <label key={name}>
                  예외 {label}
                  <textarea name={name} />
                </label>
              ))}
              <label>
                예외 시작
                <input type="datetime-local" name="startsAt" required />
              </label>
              <label>
                예외 만료
                <input type="datetime-local" name="expiresAt" required />
              </label>
            </div>
          </>
        ) : null}
        <button disabled={!rule} type="submit">
          정정·예외 요청 등록
        </button>
      </fieldset>
    </form>
  );
}
