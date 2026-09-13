import { useState, type FormEvent } from 'react';
import {
  criterionFeedbackCreateSchema,
  type CriterionDetail,
  type CriterionFeedbackResolution,
} from '@gcr/contracts';
import {
  submitCriterionFeedback,
  resolveCriterionFeedback,
  revokeCriterionException,
} from './api.ts';

export type CriterionMutation = (
  operation: () => Promise<CriterionDetail>,
  notice: string,
) => Promise<void>;
const scopeLabels = {
  languages: '언어',
  filePaths: '파일 경로',
  symbols: '심볼',
  contracts: 'API 계약',
  branches: '브랜치',
};
const statusLabels = {
  scheduled: '시작 예정',
  active: '유효',
  expired: '만료',
  revoked: '철회',
  superseded: '이전 버전',
  retired: '기준 퇴역',
};
const resolutionLabels = {
  acknowledge: '검토 접수',
  'approve-exception': '예외 승인',
  reject: '거절',
};

export function CriterionFeedbackPanel({
  detail,
  userId,
  busy,
  onMutation,
}: {
  detail: CriterionDetail;
  userId: string | null;
  busy: boolean;
  onMutation: CriterionMutation;
}) {
  const { criterion: rule, capabilities: access } = detail;
  const [kind, setKind] = useState<'correction' | 'exception'>('correction');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const get = (key: string) => String(data.get(key) ?? '');
    const toIso = (key: string) => {
      const timestamp = Date.parse(get(key));
      return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
    };
    const input = criterionFeedbackCreateSchema.safeParse({
      expectedVersion: rule.version,
      request: {
        kind,
        message: get('message'),
        ...(kind === 'exception'
          ? {
              terms: {
                appliesTo: Object.fromEntries(
                  Object.keys(scopeLabels).map((key) => [
                    key,
                    get(key)
                      .split('\n')
                      .map((value) => value.trim())
                      .filter(Boolean),
                  ]),
                ),
                startsAt: toIso('startsAt'),
                expiresAt: toIso('expiresAt'),
              },
            }
          : {}),
      },
    });
    if (!input.success) {
      setError(input.error.issues[0]?.message ?? '요청 내용을 확인해 주세요.');
      return;
    }
    setError('');
    void onMutation(
      () => submitCriterionFeedback(rule.repositoryId, rule.id, input.data),
      '요청을 등록했습니다. 검토 결과는 이 화면에서 확인할 수 있습니다.',
    );
  };
  const resolve = (requestId: string, action: CriterionFeedbackResolution['action']) =>
    onMutation(
      () =>
        resolveCriterionFeedback(rule.repositoryId, rule.id, requestId, {
          expectedVersion: rule.version,
          action,
          note,
        }),
      '요청 검토 결과를 저장했습니다.',
    );

  return (
    <section className="criteria-feedback" aria-label="정정과 예외">
      <h3>정정·예외 요청</h3>
      <p>
        요청 내용은 이 저장소를 열람할 수 있는 사용자에게 공개됩니다. 정정 요청을 접수해도 기준
        내용은 새 버전을 작성하기 전까지 유지됩니다.
      </p>
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          <label>
            요청 종류
            <select
              aria-label="요청 종류"
              value={kind}
              onChange={(event) => setKind(event.target.value as typeof kind)}
            >
              <option value="correction">정정·오탐 검토</option>
              {['shadow', 'active'].includes(rule.state) ? (
                <option value="exception">기간·범위 예외</option>
              ) : null}
            </select>
          </label>
          <label>
            요청 근거
            <textarea aria-label="요청 근거" name="message" required maxLength={4000} />
          </label>
          {kind === 'exception' ? (
            <>
              <p>
                이 버전에 한정한 예외입니다. 적용 범위를 하나 이상 지정하고 시작·만료 시각을 입력해
                주세요. 요청자와 다른 지정 책임자가 승인해야 유효합니다.
              </p>
              <div className="criteria-fields">
                {Object.entries(scopeLabels).map(([key, label]) => (
                  <label key={key}>
                    예외 {label}
                    <textarea aria-label={`예외 ${label}`} name={key} placeholder="한 줄에 하나" />
                  </label>
                ))}
                <label>
                  예외 시작
                  <input type="datetime-local" aria-label="예외 시작" name="startsAt" required />
                </label>
                <label>
                  예외 만료
                  <input type="datetime-local" aria-label="예외 만료" name="expiresAt" required />
                </label>
              </div>
              <small>시각은 현재 브라우저의 시간대를 사용합니다.</small>
            </>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
          <div>
            <button type="submit">요청 제출</button>
          </div>
        </fieldset>
      </form>
      {access.manage || access.approveOwner ? (
        <label className="criteria-feedback-note">
          요청 검토 메모
          <textarea
            aria-label="요청 검토 메모"
            value={note}
            disabled={busy}
            maxLength={2000}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
      ) : null}
      {!detail.feedback.length ? (
        <p>등록된 요청이 없습니다.</p>
      ) : (
        <ul className="criteria-feedback-list">
          {detail.feedback.map((item) => (
            <li key={item.id}>
              <p>
                <strong>{item.request.kind === 'exception' ? '예외 요청' : '정정 요청'}</strong> · v
                {item.revision} ·{' '}
                {item.resolution ? resolutionLabels[item.resolution.action] : '검토 대기'}
              </p>
              <p className="criteria-prose">{item.request.message}</p>
              {item.request.kind === 'exception' ? (
                <>
                  <p>
                    {new Date(item.request.terms.startsAt).toLocaleString('ko-KR')} —{' '}
                    {new Date(item.request.terms.expiresAt).toLocaleString('ko-KR')}
                  </p>
                  <Scope terms={item.request.terms.appliesTo} />
                </>
              ) : null}
              <small>
                요청자 {item.createdBy} · {new Date(item.createdAt).toLocaleString('ko-KR')}
              </small>
              {item.resolution ? (
                <p>
                  {item.resolution.note} · 검토자 {item.resolution.actorUserId}
                </p>
              ) : (
                <div className="criteria-actions">
                  {(access.manage || access.approveOwner) && item.request.kind === 'correction' ? (
                    <button
                      disabled={busy || !note.trim()}
                      onClick={() => void resolve(item.id, 'acknowledge')}
                    >
                      정정 검토 접수
                    </button>
                  ) : null}
                  {access.approveOwner &&
                  item.request.kind === 'exception' &&
                  item.createdBy !== userId &&
                  item.revision === rule.revision &&
                  ['shadow', 'active'].includes(rule.state) ? (
                    <button
                      disabled={busy || !note.trim()}
                      onClick={() => void resolve(item.id, 'approve-exception')}
                    >
                      예외 승인
                    </button>
                  ) : null}
                  {access.manage || access.approveOwner ? (
                    <button
                      disabled={busy || !note.trim()}
                      onClick={() => void resolve(item.id, 'reject')}
                    >
                      요청 거절
                    </button>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <h3>승인한 예외</h3>
      {!detail.exceptions.length ? (
        <p>승인한 예외가 없습니다.</p>
      ) : (
        detail.exceptions.map((item) => (
          <div className="criteria-exception" key={item.id}>
            <p>
              <strong>{statusLabels[item.status]}</strong> · v{item.revision} · {item.reason}
            </p>
            <Scope terms={item.appliesTo} />
            <p>
              {new Date(item.startsAt).toLocaleString('ko-KR')} —{' '}
              {new Date(item.expiresAt).toLocaleString('ko-KR')}
            </p>
            <small>승인자 {item.approvedBy}</small>
            {item.revocation ? (
              <p>철회 사유: {item.revocation.note}</p>
            ) : (access.manage || access.approveOwner) &&
              ['active', 'scheduled'].includes(item.status) ? (
              <button
                disabled={busy || !note.trim()}
                onClick={() =>
                  void onMutation(
                    () =>
                      revokeCriterionException(rule.repositoryId, rule.id, item.id, {
                        expectedVersion: rule.version,
                        note,
                      }),
                    '예외를 철회했습니다.',
                  )
                }
              >
                예외 철회
              </button>
            ) : null}
          </div>
        ))
      )}
    </section>
  );
}

function Scope({ terms }: { terms: CriterionDetail['exceptions'][number]['appliesTo'] }) {
  return (
    <dl className="criteria-scope">
      {Object.entries(terms)
        .filter(([, values]) => values.length)
        .map(([key, values]) => (
          <div key={key}>
            <dt>{scopeLabels[key as keyof typeof scopeLabels]}</dt>
            <dd>{values.join(', ')}</dd>
          </div>
        ))}
    </dl>
  );
}
