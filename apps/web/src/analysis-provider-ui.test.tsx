import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { analysisProviderSettingsSchema } from '@gcr/contracts';
import { ProviderPanel } from './AdminPage';
import { analysisEffortDescription } from './analysis-provider-ui';
import { saveAnalysisProvider } from './api';

const effective = {
  source: 'administration',
  versionId: '00000000-0000-4000-8000-000000000001',
  version: 1,
  mode: 'chatgpt-account',
  chatAccountId: '00000000-0000-4000-8000-000000000002',
  modelName: 'synthetic-model',
  reasoningEffort: 'medium',
  endpoint: null,
  timeoutMs: 300000,
  concurrency: 4,
  apiKeyConfigured: false,
  configurationHash: 'a'.repeat(64),
};
const settings = analysisProviderSettingsSchema.parse({
  schemaVersion: 1,
  editable: true,
  allowedOrigins: [],
  effective,
  deployment: effective,
  active: null,
  items: [],
});
const props: ComponentProps<typeof ProviderPanel> = {
  data: settings,
  busyKey: null,
  draft: {
    mode: 'chatgpt-account',
    chatAccountId: effective.chatAccountId,
    modelName: 'synthetic-model',
    reasoningEffort: 'medium',
    endpoint: '',
    apiKey: '',
    timeoutMs: 300000,
    concurrency: 4,
  },
  accounts: [
    {
      id: effective.chatAccountId,
      displayName: '합성 검증 account',
      enabled: true,
      providerType: 'chatgpt-account',
      endpoint: null,
      credentialVersion: 1,
      credentialFingerprint: 'synthetic',
      health: 'ready',
      expiresAt: null,
      lastValidatedAt: null,
      createdAt: '',
      models: [
        {
          id: 'synthetic-model',
          displayName: '검증 모델',
          enabled: true,
          defaultEffort: 'medium',
          allowedEfforts: ['low', 'medium'],
        },
        {
          id: 'disabled-model',
          displayName: '비활성 모델',
          enabled: false,
          defaultEffort: 'high',
          allowedEfforts: ['high'],
        },
      ],
      assignments: [{ scopeType: 'all', scopeId: '*', enabled: true }],
    },
  ],
  onDraftChange: () => {},
  onTest: () => {},
  onSave: () => {},
  onActivate: () => {},
  onReset: () => {},
};
describe('analysis model settings', () => {
  it('shows allowed model/effort, four parallel files, scope and registry recovery link', () => {
    const html = renderToStaticMarkup(<ProviderPanel {...props} />);
    expect(html).toContain('분석 모델 및 실행 설정');
    expect(html).toContain('value="4" selected=""');
    expect(html).toContain('value="medium" selected=""');
    expect(html).not.toContain('value="disabled-model"');
    expect(html).not.toContain('value="high"');
    expect(html).toContain('/admin?tab=chat');
    expect(html).toContain('Review Chat의 선택과는');
    expect(html).toContain('이미 생성된 분석과 Report는 유지');
  });
  it('disables save for missing/unsupported selections and while saving', () => {
    for (const overrides of [
      { accounts: [] },
      { draft: { ...props.draft, reasoningEffort: 'high' } },
      { busyKey: 'provider:save' },
      { draft: { ...props.draft, concurrency: 5 } },
    ]) {
      const html = renderToStaticMarkup(<ProviderPanel {...props} {...overrides} />);
      expect(html).toMatch(/class="command-button primary"[^>]*disabled=""/);
    }
  });
  it('describes speed/quality tradeoffs without inventing a model choice', () => {
    expect(analysisEffortDescription('low')).toContain('줄어들 수');
    expect(analysisEffortDescription('high')).toContain('시간이 더');
    expect(analysisEffortDescription('unknown')).toContain('선택하세요');
  });
  it('saves account/model/effort and parallelism in one version request', async () => {
    const fetcher = vi.fn(async () => Response.json({ id: effective.versionId }));
    vi.stubGlobal('fetch', fetcher);
    try {
      await saveAnalysisProvider(props.draft);
      expect(fetcher).toHaveBeenCalledWith(
        '/api/v1/admin/analysis-provider/versions',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(props.draft),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
