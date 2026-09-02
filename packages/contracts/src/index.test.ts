import { describe, expect, it } from 'vitest';
import {
  chatSendResponseSchema,
  dependencyHealthSchema,
  errorEnvelope,
  pullRequestListSchema,
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
});
