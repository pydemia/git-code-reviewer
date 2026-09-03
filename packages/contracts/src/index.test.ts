import { describe, expect, it } from 'vitest';
import {
  analysisProviderSettingsSchema,
  analysisPromptListSchema,
  chatSessionSchema,
  chatSendResponseSchema,
  dependencyHealthSchema,
  errorEnvelope,
  pullRequestListSchema,
  snapshotCommitListSchema,
} from './index.js';

describe('API contracts', () => {
  it('builds the typed error envelope', () => {
    expect(errorEnvelope('NOT_READY', '아직 준비되지 않았습니다.', 'req_1', true)).toEqual({
      error: {
        code: 'NOT_READY',
        message: '아직 준비되지 않았습니다.',
        requestId: 'req_1',
        retryable: true,
      },
    });
  });

  it('accepts dependency health with disabled optional services', () => {
    expect(
      dependencyHealthSchema.parse({
        schemaVersion: 1,
        status: 'ok',
        dependencies: {
          database: { status: 'ok', latencyMs: 2 },
          github: { status: 'disabled', latencyMs: null },
        },
      }),
    ).toBeTruthy();
  });

  it('requires latest analysis metadata on worklist rows', () => {
    const result = pullRequestListSchema.parse({
      schemaVersion: 1,
      repositoryId: '6655380f-34ee-4ab1-91b8-1fe2a37c0a72',
      nextCursor: null,
      items: [
        {
          id: '052491e6-df2d-43cb-b7e0-363f0d82ef95',
          number: 12,
          title: 'Review immutable snapshots',
          state: 'open',
          draft: false,
          author: 'reviewer',
          htmlUrl: 'https://github.example.test/platform/reviewer/pull/12',
          baseRef: 'main',
          baseSha: 'a'.repeat(40),
          headRef: 'review',
          headSha: 'b'.repeat(40),
          updatedAt: '2026-09-02T00:00:00.000Z',
          observedAt: '2026-09-02T00:00:01.000Z',
          latestAnalysisId: '4b8ff215-b0a9-423e-9ae2-70af24f2ee3c',
          analysisState: 'completed',
          grade: 'adequate',
          attentionCount: 2,
        },
      ],
    });
    expect(result.items[0]?.latestAnalysisId).toBeTruthy();
  });

  it('accepts persisted chat answers with evidence citations', () => {
    const response = chatSendResponseSchema.parse({
      schemaVersion: 1,
      sessionId: 'ae45aef5-46cd-4269-bde8-3bfbd4a2ebc9',
      userMessage: {
        id: '5acf99f7-fc3a-4eb8-ac63-fac507cce79f',
        role: 'user',
        status: 'completed',
        content: 'What should change?',
        citations: [],
        createdAt: '2026-09-02T00:00:00.000Z',
        completedAt: '2026-09-02T00:00:00.000Z',
      },
      assistantMessage: {
        id: '5be86f1f-60d1-4bfe-bcb3-d6722e7078d5',
        role: 'assistant',
        status: 'completed',
        content: 'Apply the finding recommendation.',
        citations: [
          {
            findingId: '1207f27a-1d72-4d8a-9752-28923e3e7262',
            evidenceId: 'a6d93d30-fb4f-43aa-ae5b-1dd3c3b7763c',
            fileId: 'f6599556-19ab-4a55-8100-784ac9a55f1e',
            line: 42,
            label: 'line 42',
          },
        ],
        createdAt: '2026-09-02T00:00:01.000Z',
        completedAt: '2026-09-02T00:00:02.000Z',
      },
    });
    expect(response.assistantMessage.citations).toHaveLength(1);
  });

  it('exposes whether a chat session has a configured model', () => {
    const session = chatSessionSchema.parse({
      schemaVersion: 1,
      id: 'ae45aef5-46cd-4269-bde8-3bfbd4a2ebc9',
      analysisId: '1207f27a-1d72-4d8a-9752-28923e3e7262',
      scope: {},
      model: { available: false, name: null },
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    });
    expect(session.model.available).toBe(false);
  });

  it('accepts immutable snapshot commit metadata for the Git graph', () => {
    const graph = snapshotCommitListSchema.parse({
      schemaVersion: 1,
      commits: [
        {
          sha: 'a'.repeat(40),
          subject: 'Add transaction coverage',
          author: 'reviewer',
          authoredAt: '2026-09-02T00:00:00.000Z',
        },
      ],
    });
    expect(graph.commits[0]?.subject).toBe('Add transaction coverage');
  });

  it('accepts a tenant-scoped immutable analysis prompt version', () => {
    const promptId = '8aff9bde-4c15-45b0-9fb2-65b70d2f98c2';
    const tenantId = '62f1b4ae-8c15-4a27-8857-a4ea940acfe8';
    const result = analysisPromptListSchema.parse({
      schemaVersion: 1,
      tenant: { id: tenantId, slug: 'platform', displayName: 'Platform' },
      model: { enabled: true, name: 'review-model' },
      active: {
        id: promptId,
        tenantId,
        version: 3,
        instructions: 'Prioritize transaction boundary regressions.',
        contentHash: 'a'.repeat(64),
        active: true,
        createdBy: { subject: 'admin', displayName: 'Administrator' },
        activatedBy: { subject: 'admin', displayName: 'Administrator' },
        activatedAt: '2026-09-03T00:00:01.000Z',
        createdAt: '2026-09-03T00:00:00.000Z',
      },
      items: [],
    });
    expect(result.active?.version).toBe(3);
  });

  it('accepts provider metadata without exposing its API key', () => {
    const version = {
      id: '9f9d2fe9-bdfb-49b2-a126-dc8de5932fac',
      version: 2,
      mode: 'openai-compatible',
      endpoint: 'https://models.example.test/v1/',
      modelName: 'review-model',
      timeoutMs: 120_000,
      apiKeyConfigured: true,
      configurationHash: 'b'.repeat(64),
      active: true,
      createdBy: { subject: 'admin', displayName: 'Administrator' },
      activatedBy: { subject: 'admin', displayName: 'Administrator' },
      activatedAt: '2026-09-03T00:00:01.000Z',
      createdAt: '2026-09-03T00:00:00.000Z',
    } as const;
    const result = analysisProviderSettingsSchema.parse({
      schemaVersion: 1,
      editable: true,
      allowedOrigins: ['https://models.example.test'],
      effective: {
        source: 'administration',
        versionId: version.id,
        version: 2,
        mode: version.mode,
        endpoint: version.endpoint,
        modelName: version.modelName,
        timeoutMs: version.timeoutMs,
        apiKeyConfigured: true,
        configurationHash: version.configurationHash,
      },
      deployment: {
        mode: 'disabled',
        endpoint: null,
        modelName: null,
        timeoutMs: 120_000,
        apiKeyConfigured: false,
        configurationHash: 'c'.repeat(64),
      },
      active: version,
      items: [version],
    });

    expect(result.effective.modelName).toBe('review-model');
    expect(result).not.toHaveProperty('apiKey');
  });
});
