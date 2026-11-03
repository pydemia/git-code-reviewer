import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { GitHubConnectionPanel } from './AdminPage';
import type { AdminRepository } from './api';

const repository: AdminRepository = {
  id: '00000000-0000-4000-8000-000000000001',
  githubId: '101',
  installationId: 'access-token',
  tenantId: '00000000-0000-4000-8000-000000000002',
  tenantSlug: 'default',
  tenantName: 'Default tenant',
  owner: 'pydemia',
  name: 'review-target',
  enabled: true,
  pollingEnabled: true,
  reviewPublishingEnabled: true,
  reviewCommentMinPriority: 'P2',
  reviewTestCode: true,
  pollIntervalSeconds: 120,
  credentialId: null,
  credentialLabel: null,
  instanceName: 'GitHub',
  apiBaseUrl: 'https://api.github.com/',
  webBaseUrl: 'https://github.com/',
  lastPolledAt: null,
  nextPollAt: null,
  pollOutcome: null,
  pollError: null,
  reviewPublicationState: null,
  reviewCommentUrl: null,
  reviewPublicationError: null,
  reviewPublishedAt: null,
};

describe('repository review settings', () => {
  it('renders the pinned test-code preference and explains the large-review override', () => {
    const html = renderToStaticMarkup(
      <GitHubConnectionPanel
        connections={[]}
        repositories={[repository]}
        tenants={[]}
        users={[]}
        busyKey={null}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onTest={vi.fn()}
        onRegisterRepository={vi.fn()}
        onRepositoryPollingChange={vi.fn()}
        onRepositoryPublishingChange={vi.fn()}
        onRepositoryCommentPriorityChange={vi.fn()}
        onRepositoryTestCodeChange={vi.fn()}
        onDeleteRepository={vi.fn()}
        onPollNow={vi.fn()}
      />,
    );
    expect(html).toContain('테스트 코드도 검토 대상에 포함');
    expect(html).toContain('checked=""');
    expect(html).toContain('테스트 코드는 source context로만 사용');
    expect(html).toContain('대규모 분석에서는 일반 코드를 우선');
  });
});
