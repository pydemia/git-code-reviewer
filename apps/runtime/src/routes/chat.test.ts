import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { chatMessageListSchema, chatSendResponseSchema } from '@gcr/contracts';
import type { Database } from '@gcr/db';
import type { FilesystemArtifactStore } from '@gcr/artifact-store';
import type { AuthUser } from '../auth/index.js';
import type { AppConfig } from '../config.js';
import type { EventHub } from '../events/index.js';
import type { AuthorizationService } from '../services/authorization.js';
import type { ChatModel } from '../services/chat-model.js';
import { registerChatRoutes } from './chat.js';

async function chatApp({
  owned = true,
  allowed = true,
  personalPrompt = '',
  memoryOwnerUserId = null,
}: {
  owned?: boolean;
  allowed?: boolean;
  personalPrompt?: string;
  memoryOwnerUserId?: string | null;
} = {}) {
  const sessionId = randomUUID(),
    analysisId = randomUUID(),
    snapshotId = randomUUID(),
    repoId = randomUUID(),
    tenantId = randomUUID();
  const user = {
    id: randomUUID(),
    subject: 'local:test',
    displayName: '검증 사용자',
    role: 'reviewer',
    enabled: true,
    groups: [],
    tenants: [],
  } as AuthUser;
  const files = [
    { id: randomUUID(), path: 'src/a.ts' },
    { id: randomUUID(), path: 'src/b.ts' },
  ];
  const coverage = {
    filesChanged: 2,
    filesExamined: 2,
    objectsExamined: 0,
    relationsExamined: 0,
    truncated: false,
    limitations: [],
  };
  const report = {
    schemaVersion: 1,
    compatibility: {
      commitDefenderSchemaVersion: 1,
      baselineRevision: '47dabfea718729b0ccc685ae173857476040d6ea',
    },
    analysisRevisionId: analysisId,
    snapshotId,
    summary: '두 파일 검토',
    grade: 'adequate',
    hasCriticalFindings: false,
    coverage,
    versions: { model: 'synthetic' },
    durationMs: 1,
    perFileSummaries: [],
    impact: { summary: '', affectedAreas: [], coverage, confidence: 'high' },
    findings: files.map((file, index) => ({
      id: randomUUID(),
      title: '문제 확인',
      problem: '문제',
      impact: '영향',
      recommendation: '권고',
      category: 'correctness',
      priority: 'P2',
      confidence: 'high',
      source: { kind: 'model', producer: 'synthetic' },
      verification: { status: 'verified', checks: [], originalPriority: 'P2' },
      fingerprint: file.id,
      anchor: {
        id: randomUUID(),
        fileId: file.id,
        side: index ? 'mergeBase' : 'head',
        startLine: 10 + index * 20,
        endLine: 14 + index * 20,
        artifactType: 'snapshot-diff',
      },
      evidence: [],
    })),
  };
  const now = new Date();
  const userRow = {
    id: randomUUID(),
    role: 'user',
    status: 'completed',
    content: 'PR 전체를 검토해 주세요.',
    citations: [],
    memory_hash: null,
    created_at: now,
    completed_at: now,
  };
  const assistantRow = {
    id: randomUUID(),
    role: 'assistant',
    status: 'pending',
    content: '',
    citations: [] as unknown[],
    memory_hash: null as string | null,
    created_at: now,
    completed_at: now,
  };
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('select personal_prompt')) {
      expect(values).toEqual([user.id]);
      return { rows: [{ personalPrompt }] };
    }
    if (sql.includes('from chat_sessions session left join')) {
      expect(values).toEqual([sessionId, user.id]);
      return {
        rows: owned
          ? [
              {
                id: sessionId,
                analysis_id: analysisId,
                scope: {},
                chat_account_id: null,
                model_name: null,
                reasoning_effort: null,
                created_at: now,
                updated_at: now,
              },
            ]
          : [],
      };
    }
    if (sql.includes('select pr.repository_id, ar.memory_owner_user_id'))
      return { rows: [{ repository_id: repoId, memory_owner_user_id: memoryOwnerUserId }] };
    if (sql.includes('from repositories r join tenants'))
      return { rows: [{ tenantId: randomUUID(), enabled: true, granted: true }] };
    if (sql.includes('from artifacts where scope_type'))
      return { rows: [{ locator: 'synthetic-report' }] };
    if (sql.includes('from snapshot_files')) {
      expect(values).toEqual([snapshotId]);
      return { rows: files };
    }
    if (sql.includes('analysis.memory_hash as "memoryHash"')) {
      return {
        rows: [
          {
            tenantId,
            repositoryId: repoId,
            memoryHash: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
            memoryContext: [],
          },
        ],
      };
    }
    if (sql.includes('from review_memories memory')) return { rows: [] };
    if (sql.includes('as hourly')) return { rows: [{ hourly: '0', session: '0', pending: '0' }] };
    if (sql.includes('with user_message as'))
      return { rows: [{ user_id: userRow.id, assistant_id: assistantRow.id }] };
    if (sql.includes("update chat_messages set status = 'completed'")) {
      assistantRow.content = String(values[1]);
      assistantRow.citations = JSON.parse(String(values[2]));
      assistantRow.memory_hash = String(values[3]);
      assistantRow.status = 'completed';
      return { rows: [assistantRow] };
    }
    if (sql.includes('insert into event_log')) return { rows: [{ id: '1' }] };
    if (sql.includes('from chat_messages where id')) return { rows: [userRow] };
    if (sql.includes('from chat_messages where session_id'))
      return { rows: [userRow, assistantRow] };
    return { rows: [] };
  });
  const database = { query, connect: async () => ({ query, release() {} }) } as unknown as Database;
  const artifacts = { readJson: vi.fn(async () => report) } as unknown as FilesystemArtifactStore;
  const generate = vi.fn<ChatModel['generate']>(async () =>
    JSON.stringify({ content: '## PR 전체\n\n두 파일을 확인하세요.', citationIds: ['E1', 'E2'] }),
  );
  const authorization = {
    isAllowed: vi.fn(async () => allowed),
  } as unknown as AuthorizationService;
  const app = Fastify();
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    request.user = user;
  });
  await registerChatRoutes(
    app,
    database,
    {} as EventHub,
    artifacts,
    {
      CHAT_MODEL_MODE: 'openai-compatible',
      CHAT_HOURLY_LIMIT: 100,
      CHAT_SESSION_MESSAGE_LIMIT: 100,
      CHAT_CONCURRENCY_LIMIT: 10,
    } as AppConfig,
    { name: 'synthetic', generate },
    authorization,
  );
  return {
    app,
    sessionId,
    generate,
    query,
    assistantRow,
    files,
    artifacts,
    setPersonalPrompt(value: string) {
      personalPrompt = value;
    },
  };
}

describe('chat citation API persistence and authorization', () => {
  it('loads current personal Prompt on every turn without storing it as a chat message', async () => {
    const fixture = await chatApp({ personalPrompt: '첫 개인 지침' });
    try {
      for (const prompt of ['첫 개인 지침', '바꾼 개인 지침', '']) {
        fixture.setPersonalPrompt(prompt);
        const response = await fixture.app.inject({
          method: 'POST',
          url: `/api/v1/chat-sessions/${fixture.sessionId}/messages`,
          payload: { content: 'PR 전체를 검토해 주세요.' },
        });
        expect(response.statusCode).toBe(201);
        const messages = fixture.generate.mock.calls.at(-1)![0].messages;
        const preferences = messages.filter((message) =>
          message.content.includes('"kind":"personal-preferences"'),
        );
        expect(preferences).toHaveLength(prompt ? 1 : 0);
        if (prompt) expect(JSON.parse(preferences[0]!.content).instructions).toBe(prompt);
        for (const [sql, values] of fixture.query.mock.calls)
          if (sql.includes('insert into') && prompt)
            expect(JSON.stringify(values)).not.toContain(prompt);
      }
    } finally {
      await fixture.app.close();
    }
  });
  it('persists and reloads multiple file ranges through the existing message contract', async () => {
    const fixture = await chatApp();
    try {
      const response = await fixture.app.inject({
        method: 'POST',
        url: `/api/v1/chat-sessions/${fixture.sessionId}/messages`,
        payload: { content: 'PR 전체를 검토해 주세요.' },
      });
      expect(response.statusCode).toBe(201);
      const body = chatSendResponseSchema.parse(response.json());
      expect(body.assistantMessage.memoryHash).toBe(
        '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      );
      expect(body.assistantMessage.content).toContain('## PR 전체');
      expect(body.assistantMessage.content).not.toContain('citationIds');
      expect(body.assistantMessage.citations).toHaveLength(2);
      expect(body.assistantMessage.citations[1]).toMatchObject({
        fileId: fixture.files[1]!.id,
        line: 30,
        endLine: 34,
        side: 'mergeBase',
        path: 'src/b.ts',
      });
      const reloaded = await fixture.app.inject({
        url: `/api/v1/chat-sessions/${fixture.sessionId}/messages`,
      });
      expect(chatMessageListSchema.parse(reloaded.json()).items[1]!.citations).toEqual(
        body.assistantMessage.citations,
      );
    } finally {
      await fixture.app.close();
    }
  });
  it.each([{ owned: false }, { allowed: false }, { memoryOwnerUserId: randomUUID() }])(
    'does not read report or call the model for inaccessible sessions %j',
    async (options) => {
      const fixture = await chatApp(options);
      try {
        const response = await fixture.app.inject({
          method: 'POST',
          url: `/api/v1/chat-sessions/${fixture.sessionId}/messages`,
          payload: { content: '질문' },
        });
        expect(response.statusCode).toBe(404);
        expect(fixture.generate).not.toHaveBeenCalled();
        expect(fixture.artifacts.readJson).not.toHaveBeenCalled();
        expect(
          fixture.query.mock.calls.some(([sql]) => sql.includes('select personal_prompt')),
        ).toBe(false);
        expect(fixture.query.mock.calls.some(([sql]) => sql.includes('with user_message as'))).toBe(
          false,
        );
      } finally {
        await fixture.app.close();
      }
    },
  );
});
