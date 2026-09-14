import { CriterionSourcePicker } from './CriterionSourcePicker.tsx';
import { useState, type FormEvent } from 'react';
import { criterionCreateSchema, type CriterionCreate, type CriterionDetail } from '@gcr/contracts';
import type { loadCriterionSources } from './api.ts';
type Sources = Awaited<ReturnType<typeof loadCriterionSources>>;
const outcomes = {
  defect: '결함',
  'false-positive': '오탐',
  'accepted-exception': '승인 대상 예외',
  'design-decision': '설계 결정',
  'open-question': '미해결 질문',
};
function lines(value: string) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
export function CriterionForm({
  detail,
  submissionSource,
  sources,
  busy,
  onCancel,
  onSubmit,
}: {
  detail: CriterionDetail | null;
  submissionSource?: string;
  sources: Sources;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: CriterionCreate) => Promise<void>;
}) {
  const existing = detail?.criterion.document;
  const decision = detail?.revisions[0]?.decision;
  const [error, setError] = useState('');
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    const data = new FormData(event.currentTarget);
    const get = (name: string) => String(data.get(name) ?? '');
    const linked = sources
      .filter((source) => selectedSources.includes(`${source.kind}:${source.id}`))
      .map(({ kind, id, contentHash, observationHash }) => ({
        kind,
        id,
        contentHash,
        ...(observationHash ? { observationHash } : {}),
      }));
    const manual = submissionSource ?? get('source').trim();
    const parsed = criterionCreateSchema.safeParse({
      document: {
        title: get('title'),
        topicKey: get('topicKey'),
        requirement: get('requirement'),
        rationale: get('rationale'),
        severity: get('severity'),
        enforcement: 'advisory',
        reviewAfter: existing?.reviewAfter ?? null,
        counterEvidence: lines(get('counterEvidence')),
        reviewSteps: lines(get('reviewSteps')),
        appliesTo: Object.fromEntries(
          ['languages', 'filePaths', 'symbols', 'contracts', 'branches'].map((name) => [
            name,
            lines(get(name)),
          ]),
        ),
      },
      decision: {
        outcome: get('outcome'),
        reasoning: get('reasoning'),
        sources: [...linked, ...(manual ? [{ kind: 'manual', content: manual }] : [])],
      },
      origin: submissionSource ? 'maintainer-curated' : get('origin'),
    });
    if (!parsed.success) {
      setError('필수 항목, 출처, 반증 조건과 검토 절차를 입력해 주세요.');
      return;
    }
    void onSubmit(parsed.data);
  };
  return (
    <form className="criteria-form" onSubmit={submit}>
      <h2>{detail ? `v${detail.criterion.revision + 1} 후보 작성` : '기준 후보 등록'}</h2>
      {detail ? (
        <p>새 출처를 확인해 연결해 주세요. 이전 버전과 평가·승인 이력은 보존됩니다.</p>
      ) : null}
      <fieldset disabled={busy}>
        <label>
          제목
          <input name="title" required maxLength={300} defaultValue={existing?.title} />
        </label>
        <label>
          주제 키
          <input
            name="topicKey"
            required
            maxLength={200}
            defaultValue={existing?.topicKey}
            placeholder="예: cache.tenant-isolation"
          />
        </label>
        <label>
          검토 기준
          <textarea
            name="requirement"
            aria-label="검토 기준"
            required
            maxLength={4000}
            defaultValue={existing?.requirement}
          />
        </label>
        <label>
          기준의 이유
          <textarea
            aria-label="기준의 이유"
            name="rationale"
            required
            maxLength={4000}
            defaultValue={existing?.rationale}
          />
        </label>
        <div className="criteria-fields">
          <label>
            영향도
            <select name="severity" defaultValue={existing?.severity ?? 'P2'}>
              {['P0', 'P1', 'P2', 'P3'].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            검토 결론
            <select name="outcome" defaultValue={decision?.outcome ?? 'design-decision'}>
              {Object.entries(outcomes).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            후보 출처
            <select
              name="origin"
              defaultValue="maintainer-curated"
              disabled={Boolean(submissionSource)}
            >
              <option value="maintainer-curated">유지관리자 선별</option>
              <option value="model-candidate">모델이 제안한 후보</option>
            </select>
          </label>
        </div>
        <label>
          판단 근거
          <textarea
            aria-label="판단 근거"
            name="reasoning"
            required
            maxLength={4000}
            defaultValue={decision?.reasoning}
          />
        </label>
        <label>
          반증 조건 <small>한 줄에 하나</small>
          <textarea
            name="counterEvidence"
            aria-label="반증 조건"
            required
            defaultValue={existing?.counterEvidence.join('\n')}
          />
        </label>
        <label>
          검토 절차 <small>한 줄에 하나</small>
          <textarea
            aria-label="검토 절차"
            name="reviewSteps"
            required
            defaultValue={existing?.reviewSteps.join('\n')}
          />
        </label>
        <details open={Boolean(existing)}>
          <summary>적용 범위 · 비워 두면 저장소 전체</summary>
          <div className="criteria-fields">
            {(
              [
                ['languages', '언어'],
                ['filePaths', '파일 경로'],
                ['symbols', '심볼'],
                ['contracts', 'API 계약'],
                ['branches', '브랜치'],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <textarea
                  name={key}
                  aria-label={label}
                  defaultValue={existing?.appliesTo[key].join('\n')}
                  placeholder="한 줄에 하나"
                />
              </label>
            ))}
          </div>
        </details>
        <CriterionSourcePicker
          sources={sources}
          selected={selectedSources}
          onToggle={(key, checked) =>
            setSelectedSources((previous) =>
              checked ? [...previous, key] : previous.filter((value) => value !== key),
            )
          }
        />
        <label>
          수동 검토 기록
          <textarea
            name="source"
            defaultValue={submissionSource}
            readOnly={Boolean(submissionSource)}
            maxLength={8000}
            placeholder="기존 출처를 선택하거나 판단의 원문·관련 변경 내용을 기록하세요."
          />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <div className="criteria-actions">
          <button type="submit">후보 저장</button>
          <button type="button" onClick={onCancel}>
            취소
          </button>
        </div>
      </fieldset>
    </form>
  );
}
