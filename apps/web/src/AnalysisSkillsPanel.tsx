import { useEffect, useRef, useState } from 'react';
import { Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import type { ReviewSkillBundle } from '@gcr/contracts';
import {
  activateAnalysisSkills,
  loadAnalysisSkills,
  resetAnalysisSkills,
  saveAnalysisSkills,
  type AnalysisSkillSettings,
} from './api.ts';

type Draft = { key: string; label: string; kind: 'perspective' | 'form'; markdown: string };
const toDraft = (bundle: ReviewSkillBundle): Draft[] =>
  bundle.skills.map((skill) => ({
    key: skill.name,
    label: skill.name,
    kind: skill.kind,
    markdown: skill.markdown,
  }));
const serialize = (draft: Draft[]) => JSON.stringify(draft.map((item) => item.markdown));

// Operate: 기존 Admin의 색·서체를 유지하며 목록 → SKILL.md 편집 → version 적용 순서로 배치한다.
// 전역 적용 범위와 queued snapshot 보존을 저장 버튼 앞에서 확인할 수 있어야 한다.
export function AnalysisSkillsPanel({ visible }: { visible: boolean }) {
  const [data, setData] = useState<AnalysisSkillSettings | null>(null);
  const [draft, setDraft] = useState<Draft[]>([]);
  const [baseline, setBaseline] = useState('');
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const current = draft.find((item) => item.key === selected);
  const dirty = serialize(draft) !== baseline && baseline !== '';

  function replaceDraft(bundle: ReviewSkillBundle, newBaseline = true) {
    const next = toDraft(bundle);
    setDraft(next);
    setSelected(next[0]?.key ?? '');
    if (newBaseline) setBaseline(serialize(next));
  }

  useEffect(() => {
    if (!visible || data) return;
    const controller = new AbortController();
    setBusy(true);
    void loadAnalysisSkills(controller.signal)
      .then(
        (result) => {
          if (controller.signal.aborted) return;
          setData(result);
          replaceDraft(result.effective.bundle);
          setNotice(null);
        },
        (error: unknown) => {
          if (!controller.signal.aborted) setNotice({ error: true, text: message(error) });
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [visible, data, attempt]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function mutate(action: () => Promise<void>, success: string) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    let applied = false;
    try {
      await action();
      applied = true;
      const updated = await loadAnalysisSkills(new AbortController().signal);
      setData(updated);
      replaceDraft(updated.effective.bundle);
      setNotice({ error: false, text: success });
    } catch (error) {
      setNotice({
        error: true,
        text: applied
          ? '변경은 적용됐지만 새 목록을 읽지 못했습니다. 페이지를 다시 열어 활성 version을 확인하세요.'
          : message(error),
      });
    } finally {
      setBusy(false);
    }
  }

  function openBundle(bundle: ReviewSkillBundle) {
    if (dirty && !window.confirm('저장하지 않은 초안을 버리고 선택한 bundle을 불러올까요?')) return;
    replaceDraft(bundle, false);
    setNotice({
      error: false,
      text: '편집 초안으로 불러왔습니다. 저장 전에는 분석에 적용되지 않습니다.',
    });
  }

  function addPerspective() {
    let index = 1;
    while (draft.some((item) => item.markdown.includes(`name: custom-review-${index}\n`))) index++;
    const name = `custom-review-${index}`;
    setDraft((items) => [
      ...items,
      {
        key: name,
        label: name,
        kind: 'perspective',
        markdown: `---\nname: ${name}\ntitle: 사용자 정의 분석\nkind: perspective\nunit: code-segment\nversion: 1\nenabled: true\n---\n\n# 분석 지침\n\n이 영역에서 확인할 문제, 필요한 코드 근거와 제외 조건을 작성한다.\n추측을 확정된 문제로 작성하지 않는다.\n`,
      },
    ]);
    setSelected(name);
    requestAnimationFrame(() => editor.current?.focus());
  }

  return (
    <section
      className="admin-section skills-panel"
      hidden={!visible}
      aria-labelledby="skills-title"
    >
      <h1 id="skills-title">분석 Skills</h1>
      <p className="admin-section-description">
        분석 관점과 report 형식을 SKILL.md로 관리합니다. 모든 tenant의 새 분석에 적용되며 이미
        queue에 들어간 작업과 기존 report는 바뀌지 않습니다. Tenant별 추가 지침은{' '}
        <a href="/admin?tab=prompt">분석 프롬프트</a>에서 관리하세요.
      </p>
      {notice ? (
        <p
          className={`admin-message ${notice.error ? 'error' : 'success'}`}
          role={notice.error ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      ) : null}
      {!data ? (
        <div className="panel-empty">
          {busy ? (
            'Skill bundle을 불러오는 중…'
          ) : (
            <button
              type="button"
              className="command-button secondary-button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              다시 불러오기
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="skills-current">
            <strong>
              현재 적용:{' '}
              {data.effective.source === 'builtin'
                ? 'Built-in'
                : `Version ${data.effective.version}`}
            </strong>
            <code title={data.effective.bundle.hash}>
              SHA-256 {data.effective.bundle.hash.slice(0, 12)}
            </code>
            <button
              className="command-button secondary-button"
              type="button"
              disabled={busy}
              onClick={() => openBundle(data.builtin)}
            >
              Built-in을 초안으로 불러오기
            </button>
          </div>
          <div className="skills-workbench">
            <div className="skills-mobile-toolbar">
              <label htmlFor="skill-mobile-choice">편집할 Skill</label>
              <select
                id="skill-mobile-choice"
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
              >
                {draft.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label} · {item.kind}
                  </option>
                ))}
              </select>
              <button
                className="command-button"
                type="button"
                disabled={busy || draft.length >= 32}
                onClick={addPerspective}
              >
                <Plus size={14} /> Perspective 추가
              </button>
            </div>
            <nav className="skills-catalog" aria-label="편집할 Skill">
              {(['perspective', 'form'] as const).map((kind) => (
                <div key={kind}>
                  <h2>{kind === 'perspective' ? '분석 관점' : '분석 형식'}</h2>
                  {draft
                    .filter((item) => item.kind === kind)
                    .map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        aria-current={selected === item.key ? 'true' : undefined}
                        onClick={() => setSelected(item.key)}
                      >
                        <span>{item.label}</span>
                        <small>
                          {kind === 'form'
                            ? '필수 form'
                            : /^enabled: false$/m.test(item.markdown.split('\n---')[0]!)
                              ? '비활성'
                              : 'perspective'}
                        </small>
                      </button>
                    ))}
                </div>
              ))}
              <button
                className="command-button secondary-button"
                type="button"
                disabled={busy || draft.length >= 32}
                onClick={addPerspective}
              >
                <Plus size={14} /> Perspective 추가
              </button>
            </nav>
            <div className="skills-editor">
              <div className="skills-editor-title">
                <label htmlFor="skill-markdown">{current?.label ?? 'Skill'} / SKILL.md</label>
                {current?.kind === 'perspective' ? (
                  <button
                    className="icon-button"
                    type="button"
                    disabled={busy}
                    aria-label="선택한 perspective를 초안에서 삭제"
                    onClick={() => {
                      if (
                        !window.confirm(
                          `${current.label}를 편집 초안에서 삭제할까요? 저장 전에는 적용되지 않습니다.`,
                        )
                      )
                        return;
                      const next = draft.filter((item) => item.key !== selected);
                      setDraft(next);
                      setSelected(next[0]?.key ?? '');
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                ) : null}
              </div>
              <textarea
                ref={editor}
                id="skill-markdown"
                spellCheck={false}
                value={current?.markdown ?? ''}
                disabled={busy || !current}
                maxLength={20000}
                aria-describedby="skill-fields"
                onChange={(event) => {
                  const markdown = event.target.value;
                  setDraft((items) =>
                    items.map((item) => (item.key === selected ? { ...item, markdown } : item)),
                  );
                }}
              />
              <p id="skill-fields">
                name은 영어 소문자·숫자·hyphen으로 작성합니다. 관점을 끄려면{' '}
                <code>enabled: false</code>로 바꾸세요. 내용을 변경할 때 <code>version</code>도 올려
                주세요. 세 form은 항상 활성화해야 합니다.
              </p>
              <details className="skills-help">
                <summary>분석 단위와 지침 작성 규칙</summary>
                <p>
                  Perspective는 <code>code-segment</code> 단위로 문제와 코드 근거를 검토합니다.{' '}
                  <code>unit-comment-block</code>은 comment 형식, <code>overall-summary</code>는
                  파일별 요약, <code>total-summary</code>는 전체 요약을 정의합니다.
                </p>
                <p>
                  Frontmatter의 필수 key는 name, title, kind, unit, version, enabled입니다. 한
                  bundle은 4–32개 Skill을 포함하며 하나 이상의 perspective가 활성 상태여야 합니다.
                  Secret이나 access token을 지침에 넣지 마세요. 인증·source 신뢰 경계·JSON
                  contract는 Skill로 바꿀 수 없습니다.
                </p>
              </details>
            </div>
          </div>
          <div className="skills-save">
            <span>
              {dirty ? '저장하지 않은 변경이 있습니다.' : '현재 활성 bundle과 같은 내용입니다.'}
            </span>
            <button
              className="command-button primary"
              type="button"
              disabled={busy || !dirty}
              onClick={() =>
                void mutate(
                  () => saveAnalysisSkills(draft.map((item) => item.markdown)),
                  'Skill bundle을 저장하고 활성화했습니다. 다음에 생성되는 분석부터 사용합니다.',
                )
              }
            >
              <Save size={15} />
              {busy ? '처리 중…' : 'Version 저장 및 활성화'}
            </button>
          </div>
          <section className="skills-history" aria-labelledby="skills-history-title">
            <h2 id="skills-history-title">Version history</h2>
            <p>
              저장된 version 본문은 변경되지 않습니다. 같은 bundle을 다시 저장하면 기존 version을
              활성화합니다. 최근 50개 version을 표시합니다.
            </p>
            {data.items.length ? (
              <ul>
                {data.items.map((item) => (
                  <li key={item.id}>
                    <div>
                      <strong>
                        Version {item.version}
                        {item.active ? ' · 활성' : ''}
                      </strong>
                      <small>
                        {new Date(item.createdAt).toLocaleString('ko-KR')} ·{' '}
                        <code>{item.contentHash.slice(0, 12)}</code>
                      </small>
                    </div>
                    <div className="skills-history-actions">
                      <button
                        className="command-button secondary-button"
                        type="button"
                        disabled={busy}
                        onClick={() => openBundle(item.bundle)}
                      >
                        초안으로 불러오기
                      </button>
                      <button
                        className="command-button secondary-button"
                        type="button"
                        disabled={busy || item.active}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Version ${item.version}을 새 분석에 적용할까요? 저장하지 않은 초안은 사라집니다.`,
                            )
                          )
                            return;
                          void mutate(
                            () => activateAnalysisSkills(item.id),
                            `Version ${item.version}을 활성화했습니다.`,
                          );
                        }}
                      >
                        활성화
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p>아직 저장된 관리자 version이 없습니다.</p>
            )}
            <button
              className="command-button secondary-button"
              type="button"
              disabled={busy || data.effective.source === 'builtin'}
              onClick={() => {
                if (
                  !window.confirm(
                    '관리자 version 대신 배포된 Built-in을 적용할까요? 기존 version은 보존되며 저장하지 않은 초안은 사라집니다.',
                  )
                )
                  return;
                void mutate(
                  resetAnalysisSkills,
                  'Built-in Skill을 활성화했습니다. 저장된 version은 보존했습니다.',
                );
              }}
            >
              <RotateCcw size={14} /> Built-in으로 복원
            </button>
          </section>
        </>
      )}
    </section>
  );
}

function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Skill을 처리하지 못했습니다. 잠시 후 다시 시도하세요.';
}
