import './chat-run.css';

export function ChatThinking() {
  return (
    <strong className="chat-thinking" role="status" aria-label="답변 생성 중">
      Thinking
    </strong>
  );
}
