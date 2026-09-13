import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  criterionCreateSchema,
  criterionEvaluationCreateSchema,
  type CriterionAction,
  type CriterionCreate,
  type CriterionDetail,
  type CriterionSummary,
} from '@gcr/contracts';
import {
  loadCurrentUser,
  loadCriteriaRepositories,
  loadCriteria,
  loadCriterion,
  loadCriterionSources,
  saveCriterion,
  saveCriterionEvaluation,
  applyCriterionAction,
  type User,
} from './api.ts';
import { AppHeader } from './AppHeader.tsx';
import { CriterionFeedbackPanel, type CriterionMutation } from './CriterionFeedbackPanel.tsx';
import './review-criteria.css';
import { CriterionRolesPanel } from './CriterionRolesPanel.tsx';
import { CriterionGenerationPanel } from './CriterionGenerationPanel.tsx';

const stateLabels = {
  draft: '후보',
  evaluated: '평가 통과',
  shadow: '관찰 중',
  active: '활성',
  retired: '퇴역',
};
const outcomes = {
  defect: '결함',
  'false-positive': '오탐',
  'accepted-exception': '승인 대상 예외',
  'design-decision': '설계 결정',
  'open-question': '미해결 질문',
};
const caseLabels = { defect: '결함', fixed: '수정', normal: '정상', 'counter-evidence': '반증' };
type Sources = Awaited<ReturnType<typeof loadCriterionSources>>;
type Capabilities = CriterionDetail['capabilities'];
const noAccess: Capabilities = { manage: false, approveOwner: false, delegate: false };

export function ReviewCriteriaPage() {
  const [user, setUser] = useState<User | null>(null);
  const [repositories, setRepositories] = useState<
    Awaited<ReturnType<typeof loadCriteriaRepositories>>
  >([]);
  const [repositoryId, setRepositoryId] = useState('');
  const [items, setItems] = useState<CriterionSummary[]>([]);
  const [sources, setSources] = useState<Sources>([]);
  const [access, setAccess] = useState(noAccess);
  const [detail, setDetail] = useState<CriterionDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      loadCurrentUser(controller.signal),
      loadCriteriaRepositories(controller.signal),
    ])
      .then(([current, repos]) => {
        if (controller.signal.aborted) return;
        setUser(current);
        setRepositories(repos);
        const requested = new URLSearchParams(window.location.search).get('repositoryId');
        setRepositoryId(repos.find(({ id }) => id === requested)?.id ?? repos[0]?.id ?? '');
        if (!repos.length) setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(message(cause));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    generation.current += 1;
    setDetail(null);
    setEditing(false);
    setItems([]);
    setSources([]);
    setAccess(noAccess);
    setError('');
    setNotice('');
    if (!repositoryId) return () => controller.abort();
    setLoading(true);
    void Promise.all([
      loadCriteria(repositoryId, controller.signal),
      loadCriterionSources(repositoryId, controller.signal),
    ])
      .then(([list, available]) => {
        if (controller.signal.aborted) return;
        setItems(list.items);
        setAccess(list.capabilities);
        setSources(available);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(message(cause));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [repositoryId]);

  const open = async (ruleId: string) => {
    const current = ++generation.current;
    setEditing(false);
    setDetail(null);
    setError('');
    setNotice('');
    try {
      const next = await loadCriterion(repositoryId, ruleId, new AbortController().signal);
      if (current === generation.current) {
        setDetail(next);
        setAccess(next.capabilities);
        setItems((previous) =>
          previous.some((item) => item.id === next.criterion.id)
            ? previous.map((item) => (item.id === next.criterion.id ? next.criterion : item))
            : [next.criterion, ...previous].slice(0, 100),
        );
      }
    } catch (cause) {
      if (current === generation.current) setError(message(cause));
    }
  };
  const mutation = async (operation: () => Promise<CriterionDetail>, success: string) => {
    const current = generation.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await operation();
      if (current !== generation.current) return;
      setDetail(next);
      setEditing(false);
      setAccess(next.capabilities);
      setNotice(success);
      setItems((previous) =>
        [next.criterion, ...previous.filter(({ id }) => id !== next.criterion.id)].slice(0, 100),
      );
    } catch (cause) {
      if (current === generation.current) setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <AppHeader user={user} />
      <main className="criteria-page">
        <header className="criteria-heading">
          <div>
            <h1>Review criteria</h1>
            <p>
              저장소의 검토 기준과 근거를 관리합니다. 후보 등록부터 평가·승인·변경 이력을 확인할 수
              있습니다.
            </p>
          </div>
          <label>
            저장소
            <select
              aria-label="저장소"
              value={repositoryId}
              disabled={busy}
              onChange={(event) => setRepositoryId(event.target.value)}
            >
              {repositories.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.owner}/{repo.name}
                </option>
              ))}
            </select>
          </label>
        </header>
        {error ? (
          <p className="criteria-error" role="alert">
            {error}{' '}
            {detail ? (
              <button disabled={busy} onClick={() => void open(detail.criterion.id)}>
                최신 버전 불러오기
              </button>
            ) : null}
          </p>
        ) : null}
        {notice ? <p role="status">{notice}</p> : null}
        {loading ? <p role="status">기준을 불러오는 중입니다.</p> : null}
        {!loading && !repositories.length ? <p>접근할 수 있는 저장소가 없습니다.</p> : null}
        {repositoryId && access.delegate ? (
          <CriterionRolesPanel key={`roles:${repositoryId}`} repositoryId={repositoryId} />
        ) : null}
        {repositoryId && access.manage ? (
          <CriterionGenerationPanel
            key={`generation:${repositoryId}`}
            repositoryId={repositoryId}
            sources={sources}
            onOpen={(id) => void open(id)}
          />
        ) : null}
        {repositoryId ? (
          <div className="criteria-workspace">
            <aside className="criteria-list" aria-label="리뷰 기준 목록">
              <div className="criteria-list-heading">
                <h2>기준 {items.length}개</h2>
                {access.manage ? (
                  <button
                    disabled={busy}
                    onClick={() => {
                      generation.current += 1;
                      setDetail(null);
                      setEditing(true);
                      setError('');
                      setNotice('');
                    }}
                  >
                    후보 등록
                  </button>
                ) : null}
              </div>
              {!loading && !items.length ? (
                <p>
                  등록된 기준이 없습니다.
                  {access.manage ? ' PR 논의나 검토 기록에서 첫 후보를 등록하세요.' : ''}
                </p>
              ) : null}
              {items.map((rule) => (
                <button
                  type="button"
                  className={`criteria-list-item ${detail?.criterion.id === rule.id ? 'selected' : ''}`}
                  key={rule.id}
                  disabled={busy}
                  onClick={() => void open(rule.id)}
                >
                  <strong>{rule.document.title}</strong>
                  <span>
                    {stateLabels[rule.state]} · {rule.document.severity} · v{rule.revision}
                  </span>
                </button>
              ))}
              {items.length === 100 ? <small>최근 변경한 기준 100개를 표시합니다.</small> : null}
            </aside>
            <section className="criteria-detail" aria-label="기준 상세">
              {editing ? (
                <CriterionForm
                  key={`${repositoryId}:${detail?.criterion.id ?? 'new'}:${detail?.criterion.version ?? 0}`}
                  detail={detail}
                  sources={sources}
                  busy={busy}
                  onCancel={() => setEditing(false)}
                  onSubmit={(input) =>
                    mutation(
                      () =>
                        saveCriterion(
                          repositoryId,
                          input,
                          detail
                            ? { id: detail.criterion.id, version: detail.criterion.version }
                            : undefined,
                        ),
                      '후보 버전을 저장했습니다.',
                    )
                  }
                />
              ) : detail ? (
                <CriterionView
                  key={`${detail.criterion.id}:${detail.criterion.version}`}
                  detail={detail}
                  userId={user?.id ?? null}
                  busy={busy}
                  onMutation={mutation}
                  onEdit={() => setEditing(true)}
                  onAction={(action, note) =>
                    mutation(
                      () =>
                        applyCriterionAction(repositoryId, detail.criterion.id, {
                          expectedVersion: detail.criterion.version,
                          action,
                          note,
                        }),
                      '검토 이력을 저장했습니다.',
                    )
                  }
                  onEvaluate={(cases, note) =>
                    mutation(
                      () =>
                        saveCriterionEvaluation(repositoryId, detail.criterion.id, {
                          expectedVersion: detail.criterion.version,
                          cases,
                          note,
                        }),
                      '수동 평가 기록을 저장했습니다.',
                    )
                  }
                />
              ) : (
                <p className="criteria-placeholder">
                  기준을 선택하면 적용 범위, 출처, 평가와 변경 이력을 확인할 수 있습니다.
                </p>
              )}
            </section>
          </div>
        ) : null}
      </main>
    </>
  );
}

function CriterionForm({
  detail,
  sources,
  busy,
  onCancel,
  onSubmit,
}: {
  detail: CriterionDetail | null;
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
      .map(({ kind, id, contentHash }) => ({ kind, id, contentHash }));
    const manual = get('source').trim();
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
      origin: get('origin'),
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
            <select name="origin" defaultValue="maintainer-curated">
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
        <details>
          <summary>기존 PR 논의·집단 메모리에서 출처 선택</summary>
          {sources.length ? (
            sources.map((source) => (
              <label className="criteria-source-choice" key={`${source.kind}:${source.id}`}>
                <input
                  type="checkbox"
                  checked={selectedSources.includes(`${source.kind}:${source.id}`)}
                  onChange={(event) =>
                    setSelectedSources((previous) =>
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
            ))
          ) : (
            <p>연결할 수 있는 출처가 없습니다.</p>
          )}
        </details>
        <label>
          수동 검토 기록
          <textarea
            name="source"
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

function CriterionView({
  detail,
  userId,
  busy,
  onMutation,
  onEdit,
  onAction,
  onEvaluate,
}: {
  detail: CriterionDetail;
  userId: string | null;
  busy: boolean;
  onMutation: CriterionMutation;
  onEdit: () => void;
  onAction: (action: CriterionAction['action'], note: string) => Promise<void>;
  onEvaluate: (
    cases: import('@gcr/contracts').CriterionEvaluationCreate['cases'],
    note: string,
  ) => Promise<void>;
}) {
  const { criterion: rule, capabilities: access } = detail;
  const [note, setNote] = useState('');
  const [evaluationOpen, setEvaluationOpen] = useState(false);
  const actions: Array<[CriterionAction['action'], string]> = access.manage
    ? rule.state === 'draft'
      ? [
          ['evaluate', '평가 통과 처리'],
          ['retire', '퇴역'],
        ]
      : rule.state === 'evaluated'
        ? [
            ['shadow', '관찰 시작'],
            ['retire', '퇴역'],
          ]
        : rule.state === 'shadow'
          ? [
              ['activate', '활성화'],
              ['retire', '퇴역'],
            ]
          : rule.state === 'active'
            ? [['retire', '퇴역']]
            : []
    : [];
  if (access.approveOwner && rule.state === 'evaluated')
    actions.unshift(['approve-owner', '책임자 승인']);
  return (
    <article>
      <header className="criteria-detail-heading">
        <div>
          <p>
            {stateLabels[rule.state]} · {rule.document.severity} · v{rule.revision} · Advisory
          </p>
          <h2>{rule.document.title}</h2>
        </div>
        {access.manage ? (
          <button disabled={busy} onClick={onEdit}>
            새 버전 작성
          </button>
        ) : null}
      </header>
      {detail.generation ? (
        <p>
          최초 후보 생성 모델: {detail.generation.modelName} · {detail.generation.reasoningEffort}
        </p>
      ) : null}
      <p>배포 상태: 미발행. 현재 PR·CLI 리뷰에는 이 기준이 아직 적용되지 않습니다.</p>
      <p className="criteria-prose">{rule.document.requirement}</p>
      <h3>기준의 이유</h3>
      <p className="criteria-prose">{rule.document.rationale}</p>
      <h3>반증 조건</h3>
      <ul>
        {rule.document.counterEvidence.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
      <h3>검토 절차</h3>
      <ol>
        {rule.document.reviewSteps.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ol>
      <h3>적용 범위</h3>
      <dl className="criteria-scope">
        {Object.entries(rule.document.appliesTo)
          .filter(([, values]) => values.length)
          .map(([key, values]) => (
            <div key={key}>
              <dt>
                {
                  (
                    {
                      languages: '언어',
                      filePaths: '파일 경로',
                      symbols: '심볼',
                      contracts: 'API 계약',
                      branches: '브랜치',
                    } as Record<string, string>
                  )[key]
                }
              </dt>
              <dd>{values.join(', ')}</dd>
            </div>
          ))}
      </dl>
      {Object.values(rule.document.appliesTo).every((values) => values.length === 0) ? (
        <p>저장소 전체</p>
      ) : null}
      <h3>평가</h3>
      <p>수동 검토자가 결함·수정·정상·반증 사례의 관찰 결과를 기록합니다.</p>
      {detail.evaluations
        .filter((entry) => entry.revision === rule.revision)
        .map((entry) => (
          <details key={entry.id}>
            <summary>
              {entry.passed ? '4개 사례 통과' : '미통과·문맥 부족'} · 수동 평가 ·{' '}
              {new Date(entry.createdAt).toLocaleString('ko-KR')}
            </summary>
            <p>{entry.note}</p>
            {entry.cases.map((item) => (
              <div key={item.kind}>
                <h4>
                  {caseLabels[item.kind]} · {item.name} · {item.observed}
                </h4>
                <pre>{item.source}</pre>
                <p>{item.evidence}</p>
                <small>Source SHA-256 {item.sourceHash}</small>
              </div>
            ))}
          </details>
        ))}
      {!detail.evaluations.some((entry) => entry.revision === rule.revision) ? (
        <p>이 버전의 평가 기록이 없습니다.</p>
      ) : null}
      {access.manage && rule.state === 'draft' ? (
        <>
          <button disabled={busy} onClick={() => setEvaluationOpen((value) => !value)}>
            평가 기록 추가
          </button>
          {evaluationOpen ? <EvaluationForm busy={busy} onSubmit={onEvaluate} /> : null}
        </>
      ) : null}
      {actions.length ? (
        <div className="criteria-review-actions">
          <label>
            검토 메모
            <textarea
              value={note}
              maxLength={2000}
              disabled={busy}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <div className="criteria-actions">
            {actions.map(([action, label]) => (
              <button
                key={action}
                disabled={busy || !note.trim()}
                onClick={() => void onAction(action, note.trim())}
              >
                {label}
              </button>
            ))}
          </div>
          {['P0', 'P1'].includes(rule.document.severity) ||
          rule.outcome === 'accepted-exception' ? (
            <p>관찰 시작 전 지정 security/domain owner의 승인이 필요합니다.</p>
          ) : null}
        </div>
      ) : null}
      <CriterionFeedbackPanel detail={detail} userId={userId} busy={busy} onMutation={onMutation} />
      <h3>출처와 버전 이력</h3>
      {detail.revisions.map((revision) => (
        <details key={revision.revision} open={revision.revision === rule.revision}>
          <summary>
            v{revision.revision} · {outcomes[revision.decision.outcome]} ·{' '}
            {revision.decision.origin === 'model-candidate' ? '모델 제안' : '유지관리자 선별'}
          </summary>
          <p>{revision.decision.reasoning}</p>
          <small>Content SHA-256 {revision.contentHash}</small>
          {revision.revision !== rule.revision ? (
            <>
              <h4>{revision.document.title}</h4>
              <p className="criteria-prose">{revision.document.requirement}</p>
            </>
          ) : null}
          {revision.decision.sources.map((source, index) => (
            <div className="criteria-source" key={index}>
              <h4>{source.label}</h4>
              <pre>{source.content}</pre>
              <small>Source SHA-256 {source.contentHash}</small>
              {source.headSha ? <small>Commit {source.headSha}</small> : null}
            </div>
          ))}
        </details>
      ))}
      <h3>검토 이력</h3>
      <ol className="criteria-history">
        {detail.events.map((event) => (
          <li key={event.id}>
            <span>
              v{event.revision} · {event.action} ·{' '}
              {new Date(event.createdAt).toLocaleString('ko-KR')}
            </span>
            <p>{event.note}</p>
            <small>검토자 {event.actorUserId}</small>
          </li>
        ))}
      </ol>
    </article>
  );
}

function EvaluationForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (
    cases: import('@gcr/contracts').CriterionEvaluationCreate['cases'],
    note: string,
  ) => Promise<void>;
}) {
  const [error, setError] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = criterionEvaluationCreateSchema.safeParse({
      expectedVersion: 1,
      note: data.get('evaluationNote'),
      cases: Object.keys(caseLabels).map((kind) => ({
        kind,
        name: data.get(`${kind}.name`),
        source: data.get(`${kind}.source`),
        observed: data.get(`${kind}.observed`),
        evidence: data.get(`${kind}.evidence`),
      })),
    });
    if (!parsed.success) {
      setError('네 사례의 코드·관찰 결과·근거와 평가 메모를 입력해 주세요.');
      return;
    }
    setError('');
    void onSubmit(parsed.data.cases, parsed.data.note);
  };
  return (
    <form className="criteria-evaluation" onSubmit={submit}>
      <fieldset disabled={busy}>
        <legend>수동 평가 기록</legend>
        {Object.entries(caseLabels).map(([kind, label]) => (
          <fieldset key={kind}>
            <legend>{label} 사례</legend>
            <label>
              사례 이름
              <input
                aria-label={`${label} 사례 이름`}
                name={`${kind}.name`}
                required
                maxLength={300}
              />
            </label>
            <label>
              평가한 코드·조건
              <textarea
                aria-label={`${label} 코드`}
                name={`${kind}.source`}
                required
                maxLength={20000}
              />
            </label>
            <label>
              관찰 결과
              <select
                aria-label={`${label} 결과`}
                name={`${kind}.observed`}
                defaultValue="needs-context"
              >
                <option value="needs-context">문맥 부족</option>
                <option value="finding">결함 발견</option>
                <option value="clear">문제 없음</option>
              </select>
            </label>
            <label>
              확인한 근거
              <textarea
                aria-label={`${label} 근거`}
                name={`${kind}.evidence`}
                required
                maxLength={4000}
              />
            </label>
          </fieldset>
        ))}
        <label>
          평가 메모
          <textarea name="evaluationNote" required maxLength={2000} />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit">평가 기록 저장</button>
      </fieldset>
    </form>
  );
}
function lines(value: string) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
function message(error: unknown) {
  return error instanceof Error ? error.message : '요청을 처리하지 못했습니다.';
}
