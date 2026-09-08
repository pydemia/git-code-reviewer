import { useState } from 'react';
import { isTerminalChatRun, type ChatRunView, type SourceEvidence } from '@gcr/contracts';
import { ReviewMarkdown } from './ReviewMarkdown.tsx';
import './chat-run.css';

const statusLabels: Record<ChatRunView['status'], string> = {
  queued: '분석 대기',
  running: '분석 중',
  awaiting_input: '응답을 기다리고 있습니다',
  waiting_capacity: '계정 호출 한도 대기',
  cancelling: '중단 중',
  completed: '분석 완료',
  partial: '부분 완료',
  failed: '분석 실패',
  cancelled: '중단됨',
};
export function ChatRunActivity({
  run,
  error,
  sending,
  onAnswer,
  onCancel,
  onEvidence,
  readOnly = false,
}: {
  run: ChatRunView | null;
  error: string;
  sending: boolean;
  onAnswer: (answer: string) => Promise<void>;
  onCancel: () => Promise<void>;
  onEvidence: (unitId: string) => void;
  readOnly?: boolean;
}) {
  const [answer, setAnswer] = useState('');
  const [actionError, setActionError] = useState('');
  const send = async (value: string) => {
    try {
      await onAnswer(value);
      setAnswer('');
      setActionError('');
    } catch {
      setActionError('응답을 저장하지 못했습니다. 다시 시도해 주세요.');
    }
  };
  if (!run)
    return error ? (
      <p role="alert">{error}</p>
    ) : (
      <p className="chat-message-empty">질문에 따라 로컬 Git·기존 코드·테스트를 조회합니다.</p>
    );
  return (
    <section className="chat-run-activity" aria-label="추가 코드 분석">
      <div className="chat-run-status">
        <strong role="status">{statusLabels[run.status]}</strong>
        {!readOnly && !isTerminalChatRun(run.status) ? (
          <button
            type="button"
            onClick={() => void onCancel().catch(() => setActionError('중단 요청에 실패했습니다.'))}
          >
            중단
          </button>
        ) : null}
      </div>
      <small>
        모델 {run.modelCalls}회 · 도구 {run.toolCalls}회 · 근거 {Math.ceil(run.contextBytes / 1024)}{' '}
        KiB
      </small>
      <details>
        <summary>조회 과정 · {run.timeline.length}</summary>
        <ol>
          {run.timeline.map((event) => (
            <li key={event.id}>{event.label}</li>
          ))}
        </ol>
      </details>
      {run.content ? (
        <div className="chat-message-content">
          <ReviewMarkdown text={run.content.replace(/\[source:[a-f0-9]+\]/g, '')} />
        </div>
      ) : null}
      {readOnly ? <p>저장된 분석 이력입니다. 새 요청과 중단은 현재 대화에서 처리합니다.</p> : null}
      {(run.questions ?? [])
        .filter((question) => question.answer !== null || readOnly)
        .map((question) => (
          <div className="chat-question" key={question.id}>
            <strong>{question.question}</strong>
            <p>{question.answer ?? '응답 없음'}</p>
          </div>
        ))}
      {!readOnly && run.status === 'awaiting_input' && run.question ? (
        <div className="chat-question" key={run.question.id}>
          <strong>{run.question.question}</strong>
          <div>
            {run.question.options.map((option) => (
              <button
                type="button"
                disabled={sending}
                key={option}
                onClick={() => void send(option)}
              >
                {option}
              </button>
            ))}
          </div>
          <label>
            직접 답변
            <textarea
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              maxLength={4000}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (answer.trim() && !sending) void send(answer.trim());
                }
              }}
            />
          </label>
          <button
            type="button"
            disabled={!answer.trim() || sending}
            onClick={() => void send(answer.trim())}
          >
            답변하고 분석 계속
          </button>
        </div>
      ) : null}
      {run.evidence.length ? (
        <div className="chat-source-links">
          <strong>조회한 코드 근거</strong>
          {run.evidence.map((unit) => (
            <button type="button" key={unit.id} onClick={() => onEvidence(unit.id)}>
              {unit.revision} · {unit.path}:{unit.startLine}–{unit.endLine}
            </button>
          ))}
        </div>
      ) : null}
      {run.status === 'waiting_capacity' ? (
        <p>다른 분석이나 계정 제한으로 대기 중입니다. 자동으로 다시 시도합니다.</p>
      ) : null}
      {run.error ? <p role="alert">확인하지 못한 범위가 있습니다: {run.error}</p> : null}
      {error || actionError ? <p role="alert">{error || actionError}</p> : null}
    </section>
  );
}
export function SourceEvidenceView({
  source,
  onClose,
}: {
  source: SourceEvidence;
  onClose: () => void;
}) {
  return (
    <section className="source-evidence-view" aria-label="고정 revision 코드 근거">
      <header>
        <div>
          <strong>{source.path}</strong>
          <p>
            {source.revision} · {source.sha} · L{source.startLine}–L{source.endLine}
          </p>
        </div>
        <button type="button" onClick={onClose}>
          코드 근거 닫기
        </button>
      </header>
      {source.truncated ? (
        <p>조회한 범위만 표시합니다. 파일 전체를 검토했다는 뜻은 아닙니다.</p>
      ) : null}
      <pre>
        <code>
          {source.content.split('\n').map((line, index) => (
            <span className="source-evidence-line" key={index}>
              <span aria-hidden="true">{source.startLine + index}</span>
              {line}
              {'\n'}
            </span>
          ))}
        </code>
      </pre>
    </section>
  );
}
