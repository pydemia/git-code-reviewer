import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ChatPanel } from './ChatPanel.tsx';
import type { WorkspaceData } from './api.ts';

const props: ComponentProps<typeof ChatPanel> = {
  revision: 1,
  headSha: 'abc1234',
  selectedFinding: undefined,
  selectedFile: 'src/main.ts',
  model: {
    available: true,
    name: 'test-model',
    accountId: 'account',
    accountName: '테스트 계정',
    reasoningEffort: 'medium',
    credentialVersion: 1,
  },
  accountCatalog: {
    schemaVersion: 1,
    enabled: true,
    items: [
      {
        id: 'account',
        displayName: '테스트 계정',
        health: 'ready',
        models: [
          {
            id: 'test-model',
            displayName: 'Test model',
            allowedEfforts: ['medium', 'high'],
            defaultEffort: 'medium',
          },
        ],
      },
    ],
  },
  accountStatus: 'ready',
  reportReady: true,
  analysisPending: false,
  accountId: 'account',
  modelName: 'test-model',
  reasoningEffort: 'medium',
  messages: [],
  draft: '',
  sending: false,
  onRetryAccounts() {},
  onDraftChange() {},
  onAccountChange() {},
  onModelChange() {},
  onEffortChange() {},
  onSend() {},
  onCitationSelect() {},
};

it('offers permission-filtered analysis presets and locks settings during generation', () => {
  const html = renderToStaticMarkup(
    <ChatPanel
      {...props}
      selectionLocked
      onPresetChange={() => {}}
      accountCatalog={{
        ...props.accountCatalog!,
        analysisPresets: [
          {
            id: 'preset',
            version: 2,
            active: true,
            accountId: 'account',
            modelName: 'test-model',
            reasoningEffort: 'high',
          },
        ],
      }}
    />,
  );
  expect(html).toContain('분석 Provider 설정 불러오기');
  expect(html).toContain('v2 · 분석에 사용 중');
  expect(html.match(/<select[^>]*disabled/g)).toHaveLength(4);
  expect(html).toContain('답변 생성이 끝나면 모델을 변경');
});
it('shows readable prior messages even when no account is currently available', () => {
  const html = renderToStaticMarkup(
    <ChatPanel
      {...props}
      model={{ ...props.model!, available: false }}
      messages={[
        {
          id: 'past',
          role: 'assistant',
          status: 'completed',
          content: '**이전 답변**',
          citations: [],
          memoryHash: null,
          createdAt: '',
          completedAt: null,
        },
      ]}
    />,
  );
  expect(html).toContain('<strong>이전 답변</strong>');
});
it('places account/model/effort after the taller composer in DOM and keyboard order', () => {
  const html = renderToStaticMarkup(<ChatPanel {...props} />);
  expect(html).toContain('rows="5"');
  expect(html).toContain('aria-label="질문"');
  expect(html.indexOf('chat-messages')).toBeLessThan(html.indexOf('chat-composer'));
  expect(html.indexOf('</form>')).toBeLessThan(html.indexOf('chat-model-selectors'));
  expect(html.indexOf('Account')).toBeLessThan(html.indexOf('Model'));
  expect(html).toContain('아직 대화가 없습니다.');
});

it('retains loading, unavailable, disabled and pending states', () => {
  expect(renderToStaticMarkup(<ChatPanel {...props} accountStatus="loading" />)).toContain(
    '사용 가능한 계정을 확인',
  );
  expect(renderToStaticMarkup(<ChatPanel {...props} accountStatus="error" />)).toContain(
    '다시 시도',
  );
  const unavailable = renderToStaticMarkup(
    <ChatPanel
      {...props}
      model={{ ...props.model!, available: false }}
      accountCatalog={{ schemaVersion: 1, enabled: true, items: [] }}
    />,
  );
  expect(unavailable).toContain('사용 가능한 ChatGPT account가 없습니다.');
  expect(unavailable).toContain('aria-label="질문" aria-keyshortcuts="Enter" disabled=""');
  expect(renderToStaticMarkup(<ChatPanel {...props} sending />)).toContain('Thinking');
  expect(renderToStaticMarkup(<ChatPanel {...props} accountCatalog={null} />)).not.toContain(
    'chat-model-selectors',
  );
});

it('renders assistant Markdown safely while preserving the user question verbatim', () => {
  const content =
    '# Merge 확인\n\n**위험**과 `path_format`\n\n- 저장 경로\n- 배포 설정\n\n```ts\nconst safe = true;\n```\n\n| 파일 | 상태 |\n| --- | --- |\n| a.ts | 확인 |\n\n<script>alert(1)</script>\n![tracking](https://evil.example/pixel)\n[unsafe](javascript:alert(1))';
  const html = renderToStaticMarkup(
    <ChatPanel
      {...props}
      messages={[
        {
          id: 'assistant',
          role: 'assistant',
          status: 'completed',
          content,
          citations: [],
          memoryHash: null,
          createdAt: 'now',
          completedAt: 'now',
        },
        {
          id: 'user',
          role: 'user',
          status: 'completed',
          content: '**이 문구** 그대로\n다음 줄',
          citations: [],
          memoryHash: null,
          createdAt: 'now',
          completedAt: 'now',
        },
      ]}
    />,
  );
  expect(html).toContain('<h4>Merge 확인</h4>');
  expect(html).toContain('<strong>위험</strong>');
  expect(html).toContain('<code>path_format</code>');
  expect(html).toContain('<ul>');
  expect(html).toContain('<pre><code class="language-ts">');
  expect(html).toContain('<table>');
  expect(html).toContain('**이 문구** 그대로\n다음 줄');
  for (const unsafe of ['<script>', '<img', 'href="javascript:', 'src="https://evil.example'])
    expect(html).not.toContain(unsafe);
});

it('renders separate file/range links and disables stale evidence instead of pointing elsewhere', () => {
  const anchor = {
    id: 'anchor',
    fileId: 'file-a',
    side: 'head' as const,
    startLine: 10,
    endLine: 14,
    artifactType: 'snapshot-diff',
  };
  const evidence = {
    id: 'evidence',
    fileId: 'file-b',
    side: 'mergeBase' as const,
    startLine: 50,
    endLine: 57,
    artifactType: 'snapshot-diff',
  };
  const findings = [{ id: 'finding', anchor, evidence: [evidence] }] as NonNullable<
    WorkspaceData['report']
  >['findings'];
  const citations = [
    { findingId: 'finding', evidenceId: 'anchor', fileId: 'file-a', line: 10, label: 'line 10' },
    { findingId: 'finding', evidenceId: 'evidence', fileId: 'file-b', line: 50, label: 'line 50' },
    { findingId: 'finding', evidenceId: 'stale', fileId: 'file-b', line: 99, label: 'line 99' },
  ];
  const html = renderToStaticMarkup(
    <ChatPanel
      {...props}
      files={[
        { id: 'file-a', path: 'src/a.ts' },
        { id: 'file-b', path: 'k8s/deploy.yaml' },
      ]}
      findings={findings}
      messages={[
        {
          id: 'reply',
          role: 'assistant',
          status: 'completed',
          content: '확인 사항',
          citations,
          memoryHash: null,
          createdAt: 'now',
          completedAt: 'now',
        },
      ]}
    />,
  );
  expect(html).toContain('관련 코드');
  expect(html).toContain('src/a.ts · L10–14 · 변경 코드');
  expect(html).toContain('k8s/deploy.yaml · L50–57 · 이전 코드');
  expect(html).toContain(
    'disabled="" title="현재 revision에서 이 근거 위치를 확인할 수 없습니다."',
  );
  expect(html).toContain('line 99 · 위치 확인 불가');
});
