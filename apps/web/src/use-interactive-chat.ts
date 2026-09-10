import { useCallback, useEffect, useRef, useState } from 'react';
import {
  chatRunViewSchema,
  chatMessageListSchema,
  isTerminalChatRun,
  type ChatRunView,
  type ChatRunSelection,
} from '@gcr/contracts';
import type { ChatMessage } from './api.ts';
import { browserUuid } from './browser-uuid.ts';

async function jsonRequest(url: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(url, {
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    throw Error(failure?.error?.message ?? `대화 요청을 처리하지 못했습니다 (${response.status}).`);
  }
  return response.json() as Promise<unknown>;
}
export function useInteractiveChat(
  sessionId: string | undefined,
  onMessages: (messages: ChatMessage[]) => void,
) {
  const [enabled, setEnabled] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [run, setRun] = useState<ChatRunView | null>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const pending = useRef<{ content: string; key: string } | null>(null);
  const inFlight = useRef(false);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  useEffect(() => {
    const controller = new AbortController();
    void jsonRequest('/api/v1/chat-agent/config', undefined, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setEnabled((value as { enabled: boolean }).enabled);
        setConfigured(true);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('대화 기능 설정을 불러오지 못했습니다. 페이지를 새로고침해 주세요.');
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    setRun(null);
    setError('');
    setSending(false);
    pending.current = null;
    if (!enabled || !sessionId) return;
    const controller = new AbortController();
    void jsonRequest(`/api/v1/chat-sessions/${sessionId}/runs`, undefined, controller.signal)
      .then((value) => {
        const current = (value as { run: unknown }).run;
        if (!controller.signal.aborted) setRun(current ? chatRunViewSchema.parse(current) : null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('진행 상태를 불러오지 못했습니다.');
      });
    return () => controller.abort();
  }, [enabled, sessionId]);
  const refreshMessages = useCallback(async () => {
    if (!sessionId) return;
    const messages = chatMessageListSchema.parse(
      await jsonRequest(`/api/v1/chat-sessions/${sessionId}/messages`),
    ).items;
    if (currentSession.current === sessionId) onMessages(messages);
  }, [sessionId, onMessages]);
  const runId = run?.id;
  const status = run?.status;
  useEffect(() => {
    if (!runId || !status || isTerminalChatRun(status)) return;
    const controller = new AbortController();
    let busy = false;
    const refresh = () => {
      if (busy) return;
      busy = true;
      void jsonRequest(`/api/v1/chat-runs/${runId}`, undefined, controller.signal)
        .then((value) => {
          if (controller.signal.aborted) return;
          const next = chatRunViewSchema.parse(value);
          setRun(next);
          setError('');
          if (isTerminalChatRun(next.status)) void refreshMessages().catch(() => undefined);
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError('연결 복구 중입니다. 실행은 서버에서 계속됩니다.');
        })
        .finally(() => {
          busy = false;
        });
    };
    const stream = new EventSource(`/api/v1/chat-runs/${runId}/events`);
    stream.addEventListener('change', refresh);
    const timer = setInterval(refresh, 3000);
    return () => {
      controller.abort();
      stream.close();
      clearInterval(timer);
    };
  }, [runId, status, refreshMessages]);
  const submit = async (
    content: string,
    scope: Record<string, string>,
    selection?: ChatRunSelection,
  ) => {
    if (!sessionId || inFlight.current)
      throw Error('대화 연결을 준비하고 있습니다. 잠시 후 다시 시도해 주세요.');
    inFlight.current = true;
    setSending(true);
    setError('');
    try {
      const signature = JSON.stringify({ sessionId, content, scope, selection });
      if (pending.current?.content !== signature)
        pending.current = { content: signature, key: browserUuid() };
      if (run && !isTerminalChatRun(run.status)) {
        if (run.status === 'awaiting_input' && run.question)
          await jsonRequest(`/api/v1/chat-runs/${run.id}/questions/${run.question.id}/responses`, {
            answer: content,
          });
        else
          await jsonRequest(`/api/v1/chat-runs/${run.id}/instructions`, {
            idempotencyKey: pending.current.key,
            content,
          });
        const next = chatRunViewSchema.parse(await jsonRequest(`/api/v1/chat-runs/${run.id}`));
        if (currentSession.current !== sessionId) return;
        setRun(next);
        pending.current = null;
      } else {
        const next = chatRunViewSchema.parse(
          await jsonRequest(`/api/v1/chat-sessions/${sessionId}/runs`, {
            content,
            scope,
            ...(selection ? { selection } : {}),
            idempotencyKey: pending.current.key,
          }),
        );
        if (currentSession.current !== sessionId) return;
        setRun(next);
        pending.current = null;
      }
      await refreshMessages().catch(() => {
        if (currentSession.current === sessionId)
          setError('질문은 접수됐지만 대화 목록을 갱신하지 못했습니다. 답변 생성은 계속됩니다.');
      });
    } catch (failure) {
      if (currentSession.current === sessionId)
        setError(failure instanceof Error ? failure.message : '대화 요청 실패');
      throw failure;
    } finally {
      inFlight.current = false;
      if (currentSession.current === sessionId) setSending(false);
    }
  };
  const cancel = async () => {
    if (run) {
      await jsonRequest(`/api/v1/chat-runs/${run.id}/cancel`, {});
      const next = chatRunViewSchema.parse(await jsonRequest(`/api/v1/chat-runs/${run.id}`));
      if (currentSession.current === sessionId) setRun(next);
    }
  };
  return { enabled, configured, run, error, sending, submit, cancel };
}
