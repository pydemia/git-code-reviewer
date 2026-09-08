import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ChatPanel } from './ChatPanel.tsx';

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
  expect(renderToStaticMarkup(<ChatPanel {...props} sending />)).toContain('답변을 생성하는 중');
  expect(renderToStaticMarkup(<ChatPanel {...props} accountCatalog={null} />)).not.toContain(
    'chat-model-selectors',
  );
});
