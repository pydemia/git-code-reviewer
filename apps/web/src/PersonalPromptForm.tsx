import { personalPromptMaximumLength } from '@gcr/contracts';
import { MessageSquareText, Save } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { updatePersonalPrompt } from './api.ts';

export function PersonalPromptForm({ initialPrompt }: { initialPrompt: string }) {
  const [draft, setDraft] = useState(initialPrompt);
  const [saved, setSaved] = useState(initialPrompt);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || draft.trim() === saved) return;
    setPending(true);
    setNotice(null);
    try {
      const value = await updatePersonalPrompt(draft);
      setDraft(value);
      setSaved(value);
      setNotice({
        tone: 'success',
        text: value
          ? '개인 Prompt를 저장했습니다. 다음 Chat 질문부터 적용됩니다.'
          : '개인 Prompt를 해제했습니다. 다음 Chat 질문부터 기본 지침만 적용됩니다.',
      });
    } catch (error) {
      setNotice({
        tone: 'error',
        text:
          error instanceof Error
            ? error.message
            : '개인 Prompt를 저장하지 못했습니다. 다시 시도해 주세요.',
      });
      window.requestAnimationFrame(() => noticeRef.current?.focus());
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="profile-section" aria-labelledby="profile-prompt-title">
      <div className="profile-section-heading">
        <MessageSquareText size={18} />
        <div>
          <h2 id="profile-prompt-title">개인 Prompt</h2>
          <p>Review Chat의 답변 방식과 중점적으로 살펴볼 내용을 지정합니다.</p>
        </div>
      </div>
      {notice ? (
        <div
          className={`profile-notice ${notice.tone}`}
          role={notice.tone === 'error' ? 'alert' : 'status'}
          tabIndex={-1}
          ref={noticeRef}
        >
          {notice.text}
        </div>
      ) : null}
      <form onSubmit={(event) => void save(event)}>
        <label className="field-label" htmlFor="personal-prompt">
          Chat에 적용할 지침
        </label>
        <textarea
          id="personal-prompt"
          className="profile-prompt-input"
          ref={inputRef}
          rows={8}
          maxLength={personalPromptMaximumLength}
          value={draft}
          disabled={pending}
          aria-describedby="personal-prompt-help personal-prompt-count"
          placeholder={
            '예: 답변은 결론부터 설명해 주세요.\n보안과 backward compatibility를 중점적으로 검토하고, 수정 제안에는 가능한 경우 짧은 코드 예시를 포함해 주세요.'
          }
          onChange={(event) => {
            setDraft(event.target.value);
            setNotice(null);
          }}
        />
        <p className="profile-prompt-count" id="personal-prompt-count">
          {draft.length.toLocaleString('ko-KR')} /{' '}
          {personalPromptMaximumLength.toLocaleString('ko-KR')}자
        </p>
        <p className="profile-prompt-help" id="personal-prompt-help">
          본인의 Chat에만 적용되며 공동 PR 분석·게시와 다른 사용자에게는 적용되지 않습니다. 저장하면
          기존 대화에서도 다음 질문부터 반영됩니다. 비워서 저장하면 적용이 해제됩니다. 입력한 내용은
          선택한 모델로 전송되므로 비밀번호나 Access token을 넣지 마세요.
        </p>
        <div className="profile-actions profile-prompt-actions">
          <button
            type="button"
            className="command-button"
            disabled={pending || !draft}
            onClick={() => {
              setDraft('');
              setNotice(null);
              inputRef.current?.focus();
            }}
          >
            내용 비우기
          </button>
          <button
            type="submit"
            className={`command-button primary ${pending ? 'pending' : ''}`}
            disabled={pending || draft.trim() === saved}
          >
            <Save size={15} /> {pending ? '저장 중' : '개인 Prompt 저장'}
          </button>
        </div>
      </form>
    </section>
  );
}
