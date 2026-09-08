import { Bot, Link2, RefreshCw, Send, Sparkles } from 'lucide-react';
import type { ChatAccountCatalog, ChatMessage, ChatSession, WorkspaceData } from './api.ts';

type FindingView = NonNullable<WorkspaceData['report']>['findings'][number];

export function ChatPanel({
  revision,
  headSha,
  selectedFinding,
  selectedFile,
  model,
  accountCatalog,
  accountStatus,
  reportReady,
  analysisPending,
  onRetryAccounts,
  accountId,
  modelName,
  reasoningEffort,
  messages,
  draft,
  sending,
  onDraftChange,
  onAccountChange,
  onModelChange,
  onEffortChange,
  onSend,
  onCitationSelect,
}: {
  revision: number | null | undefined;
  headSha: string | undefined;
  selectedFinding: FindingView | undefined;
  selectedFile: string | undefined;
  model: ChatSession['model'] | null;
  accountCatalog: ChatAccountCatalog | null;
  accountStatus: 'loading' | 'ready' | 'error';
  reportReady: boolean;
  analysisPending: boolean;
  onRetryAccounts: () => void;
  accountId: string;
  modelName: string;
  reasoningEffort: string;
  messages: ChatMessage[];
  draft: string;
  sending: boolean;
  onDraftChange: (value: string) => void;
  onAccountChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;
  onSend: () => void;
  onCitationSelect: (findingId: string) => void;
}) {
  const account = accountCatalog?.items.find((item) => item.id === accountId);
  const selectedModel = account?.models.find((item) => item.id === modelName);
  return (
    <aside
      className={`chat-panel${accountCatalog?.enabled ? ' registry-enabled' : ''}`}
      aria-label="분석 대화"
    >
      <div className="chat-heading">
        <span>
          <Bot size={15} /> Review chat
        </span>
        <span className="chat-revision">R{revision ?? '-'} locked</span>
      </div>
      <div className="chat-scope" title={selectedFinding?.title ?? selectedFile}>
        <Link2 size={12} />
        <span>{selectedFinding?.title ?? selectedFile ?? '전체 report'}</span>
        <code>{headSha?.slice(0, 7) ?? '-------'}</code>
      </div>
      <div className="chat-messages" aria-live="polite">
        {accountStatus === 'loading' ? (
          <div className="chat-message-empty">사용 가능한 계정을 확인하고 있습니다.</div>
        ) : null}
        {accountStatus === 'error' ? (
          <div className="chat-unavailable">
            <strong>계정 목록을 불러오지 못했습니다.</strong>
            <button type="button" onClick={onRetryAccounts}>
              다시 시도
            </button>
          </div>
        ) : null}
        {accountStatus === 'ready' && !reportReady && accountCatalog?.items.length ? (
          <div className="chat-message-empty">
            {analysisPending
              ? '분석 중입니다. 완료되면 이 계정으로 결과에 대해 질문할 수 있습니다.'
              : '분석 결과가 준비되면 질문할 수 있습니다.'}
          </div>
        ) : null}
        {accountStatus === 'ready' &&
        reportReady &&
        !model &&
        !(accountCatalog?.enabled && accountCatalog.items.length === 0) ? (
          <div className="chat-message-empty">Chat 연결 상태를 확인하는 중입니다.</div>
        ) : null}
        {accountStatus === 'ready' &&
        accountCatalog?.enabled &&
        accountCatalog.items.length === 0 ? (
          <div className="chat-unavailable">
            <Bot size={22} />
            <strong>사용 가능한 ChatGPT account가 없습니다.</strong>
            <span>시스템 관리자에게 account 할당을 요청해 주세요.</span>
          </div>
        ) : null}
        {model && !model.available ? (
          <div className="chat-unavailable">
            <Bot size={22} />
            <strong>Chat 모델이 연결되지 않았습니다.</strong>
            <span>이 revision의 report와 evidence는 계속 확인할 수 있습니다.</span>
          </div>
        ) : null}
        {model?.available && messages.length === 0 ? (
          <div className="chat-message-empty">아직 대화가 없습니다.</div>
        ) : null}
        {model?.available
          ? messages.map((message) => (
              <article className={`chat-message ${message.role}`} key={message.id}>
                <div className="message-author">
                  {message.role === 'assistant' ? <Sparkles size={12} /> : null}
                  <strong>{message.role === 'assistant' ? 'Review assistant' : 'You'}</strong>
                  {message.status !== 'completed' ? <small>{message.status}</small> : null}
                </div>
                <div className="chat-message-content">{message.content}</div>
                {message.citations.length > 0 ? (
                  <div className="chat-citations" aria-label="답변 근거">
                    {message.citations.map((citation) => (
                      <button
                        type="button"
                        key={citation.evidenceId}
                        disabled={!citation.findingId}
                        onClick={() => citation.findingId && onCitationSelect(citation.findingId)}
                      >
                        <Link2 size={11} /> {citation.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </article>
            ))
          : null}
        {model?.available && sending ? (
          <div className="chat-pending">
            <RefreshCw size={13} className="spin" /> 답변을 생성하는 중입니다.
          </div>
        ) : null}
      </div>
      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <textarea
          rows={5}
          value={draft}
          maxLength={4_000}
          placeholder={
            model?.available
              ? '현재 리비전에 대해 질문'
              : analysisPending
                ? '분석이 완료되면 질문할 수 있습니다.'
                : 'Chat 모델을 연결한 후 질문할 수 있습니다.'
          }
          aria-label="질문"
          aria-keyshortcuts="Enter"
          disabled={!model?.available}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
        />
        <div className="composer-actions">
          <span>Enter 전송 · Shift+Enter 줄바꿈 · {draft.length}/4000</span>
          <button
            className="send-button"
            type="submit"
            title="질문 보내기"
            aria-label="질문 보내기"
            disabled={!model?.available || !draft.trim() || sending}
          >
            <Send size={14} />
          </button>
        </div>
      </form>
      {accountCatalog?.enabled ? (
        <div className="chat-model-selectors" aria-label="Chat model 설정">
          <label>
            <span>Account</span>
            <select value={accountId} onChange={(event) => onAccountChange(event.target.value)}>
              {accountCatalog.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Model</span>
            <select value={modelName} onChange={(event) => onModelChange(event.target.value)}>
              {(account?.models ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Effort</span>
            <select
              value={reasoningEffort}
              onChange={(event) => onEffortChange(event.target.value)}
            >
              {(selectedModel?.allowedEfforts ?? []).map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
    </aside>
  );
}
