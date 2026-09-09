// 수동 Browser 회귀 검증 전용. API·모델은 합성 응답이며 production build에는 포함되지 않는다.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatPanel } from '../src/ChatPanel';
import { ChatRunActivity, SourceEvidenceView } from '../src/ChatRunActivity';
import { ChatRunHistory } from '../src/ChatRunHistory';
import { useInteractiveChat } from '../src/use-interactive-chat';
import { browserUuid } from '../src/browser-uuid';
import type { ChatAccountCatalog, ChatMessage } from '../src/api';
import type { ChatRunView, SourceEvidence } from '@gcr/contracts';
import '../src/styles.css';

const sessionId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const snapshotId = '00000000-0000-4000-8000-000000000003';
const source: SourceEvidence = {
  id: 'source1',
  path: 'src/example.ts',
  revision: 'head',
  sha: 'a'.repeat(40),
  blob: 'b'.repeat(40),
  hash: 'c'.repeat(64),
  startLine: 12,
  endLine: 14,
  content: 'export function example() {\n  return 42;\n}',
  truncated: false,
};
const messages: ChatMessage[] = [];
const runs: ChatRunView[] = [];
const requests: unknown[] = [];
Object.assign(window, { registryChatRequests: requests });
// HTTPS/localhost에서도 HTTP와 동일한 API 부재 조건을 재현한다.
Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input);
  const response = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  if (!url.startsWith('/api/')) return nativeFetch(input, init);
  if (url === '/api/v1/chat-agent/config') return response({ enabled: true });
  if (url.endsWith('/messages')) return response({ schemaVersion: 1, sessionId, items: messages });
  if (url.includes('/run-history'))
    return response({
      items: runs
        .map((run) => ({
          id: run.id,
          status: run.status,
          createdAt: new Date().toISOString(),
          question: `질문 ${runs.indexOf(run) + 1}`,
          snapshotId,
        }))
        .reverse(),
      nextCursor: null,
    });
  if (url.endsWith('/runs') && init?.method === 'POST') {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    if (!/^[a-f0-9-]{36}$/.test(body.idempotencyKey))
      return response({ error: { message: '잘못된 UUID' } }, 400);
    const user: ChatMessage = {
      id: browserUuid(),
      role: 'user',
      status: 'completed',
      content: body.content,
      citations: [],
      memoryHash: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    const assistant: ChatMessage = {
      ...user,
      id: browserUuid(),
      role: 'assistant',
      content:
        '## 코드 확인\n\n**문제는 발견되지 않았습니다.**\n\n- `example()`은 42를 반환합니다.\n- 아래 링크에서 코드 근거를 확인하세요.',
    };
    messages.push(user, assistant);
    const run: ChatRunView = {
      id: browserUuid(),
      sessionId,
      assistantMessageId: assistant.id,
      status: 'completed',
      phase: 'completed',
      content: assistant.content,
      error: null,
      model: { name: body.selection.modelName, effort: body.selection.reasoningEffort },
      modelCalls: 1,
      toolCalls: 1,
      contextBytes: 100,
      question: null,
      resumeAfter: null,
      evidence: [source],
      timeline: [],
    };
    runs.push(run);
    return response(run, 202);
  }
  if (url.endsWith('/runs')) return response({ run: runs.at(-1) ?? null });
  if (url.startsWith('/api/v1/chat-runs/'))
    return response(runs.find((run) => url.endsWith(run.id)));
  return response({ error: { message: '합성 API 경로를 찾을 수 없습니다.' } }, 404);
};
const catalog: ChatAccountCatalog = {
  schemaVersion: 1,
  enabled: true,
  items: [
    {
      id: accountId,
      displayName: '검증 account',
      health: 'ready',
      models: [
        {
          id: 'test-sol',
          displayName: 'Test Sol',
          allowedEfforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
        },
        {
          id: 'test-luna',
          displayName: 'Test Luna',
          allowedEfforts: ['low', 'medium'],
          defaultEffort: 'low',
        },
      ],
    },
  ],
  analysisPresets: [
    {
      id: '00000000-0000-4000-8000-000000000004',
      version: 4,
      active: true,
      accountId,
      modelName: 'test-luna',
      reasoningEffort: 'low',
    },
  ],
};
export function Harness() {
  const [items, setItems] = useState<ChatMessage[]>([]);
  const chat = useInteractiveChat(sessionId, setItems);
  const [draft, setDraft] = useState('이 함수는 어떤 역할을 하나요?');
  const [model, setModel] = useState('test-sol');
  const [effort, setEffort] = useState('medium');
  const [evidence, setEvidence] = useState(false);
  return (
    <main
      style={{
        display: 'flex',
        minHeight: '100dvh',
        alignItems: 'stretch',
        justifyContent: 'center',
      }}
    >
      {evidence ? (
        <div style={{ width: 'min(600px,45vw)' }}>
          <SourceEvidenceView source={source} onClose={() => setEvidence(false)} />
        </div>
      ) : null}
      <div style={{ width: 'min(640px,100vw)', height: '100dvh' }}>
        <ChatPanel
          revision={1}
          headSha={source.sha}
          selectedFinding={undefined}
          selectedFile={source.path}
          model={{
            available: chat.configured,
            name: model,
            accountId,
            accountName: '검증 account',
            reasoningEffort: effort,
            credentialVersion: 1,
          }}
          accountCatalog={catalog}
          accountStatus="ready"
          reportReady
          analysisPending={false}
          onRetryAccounts={() => {}}
          accountId={accountId}
          modelName={model}
          reasoningEffort={effort}
          messages={items.filter((item) => item.id !== chat.run?.assistantMessageId)}
          draft={draft}
          sending={chat.sending}
          onDraftChange={setDraft}
          onAccountChange={() => {}}
          onModelChange={(value) => {
            setModel(value);
            setEffort(catalog.items[0]!.models.find((item) => item.id === value)!.defaultEffort);
          }}
          onEffortChange={setEffort}
          onPresetChange={() => {
            setModel('test-luna');
            setEffort('low');
          }}
          onSend={() =>
            void chat
              .submit(draft, {}, { accountId, modelName: model, reasoningEffort: effort })
              .then(() => setDraft(''))
          }
          onCitationSelect={() => {}}
          activity={
            <>
              <ChatRunHistory
                sessionId={sessionId}
                latestRunId={chat.run?.id}
                onSelect={() => setEvidence(false)}
                onEvidence={() => setEvidence(true)}
              />
              <ChatRunActivity
                run={chat.run}
                error={chat.error}
                sending={chat.sending}
                onAnswer={(answer) => chat.submit(answer, {})}
                onCancel={chat.cancel}
                onEvidence={() => setEvidence(true)}
              />
            </>
          }
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
