import {
  analysisListSchema,
  chatMessageListSchema,
  chatSendResponseSchema,
  chatSessionSchema,
  codeObjectListSchema,
  diffIndexSchema,
  operationSchema,
  pullRequestDetailSchema,
  pullRequestListSchema,
  refreshResponseSchema,
  repositoryListSchema,
  reportViewSchema,
  relationshipViewSchema,
  snapshotFileListSchema,
  type PullRequestSummary,
  type Repository,
} from '@gcr/contracts';

export type WorklistItem = PullRequestSummary & { repository: Repository };
export type WorkspaceData = {
  pull: ReturnType<typeof pullRequestDetailSchema.parse>;
  analysis: ReturnType<typeof analysisListSchema.parse>['items'][number] | null;
  files: ReturnType<typeof snapshotFileListSchema.parse>['items'];
  diff: ReturnType<typeof diffIndexSchema.parse> | null;
  report: ReturnType<typeof reportViewSchema.parse> | null;
  objects: ReturnType<typeof codeObjectListSchema.parse>['items'];
};
export type ChatMessage = ReturnType<typeof chatMessageListSchema.parse>['items'][number];
export type ChatSession = ReturnType<typeof chatSessionSchema.parse>;
export type RelationshipView = ReturnType<typeof relationshipViewSchema.parse>;

export async function loadWorklist(signal: AbortSignal): Promise<WorklistItem[]> {
  const repositories = repositoryListSchema.parse(
    await fetchJson('/api/v1/repositories', signal),
  ).items;
  const pulls = await Promise.all(
    repositories.map(async (repository) => {
      const response = pullRequestListSchema.parse(
        await fetchJson(`/api/v1/repositories/${repository.id}/pulls`, signal),
      );
      return response.items.map((pull) => ({ ...pull, repository }));
    }),
  );
  return [...pulls.flat()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function loadWorkspace(
  repositoryId: string,
  pullNumber: number,
  signal: AbortSignal,
): Promise<WorkspaceData> {
  const [pullValue, analysesValue] = await Promise.all([
    fetchJson(`/api/v1/repositories/${repositoryId}/pulls/${pullNumber}`, signal),
    fetchJson(`/api/v1/repositories/${repositoryId}/pulls/${pullNumber}/analyses`, signal),
  ]);
  const pull = pullRequestDetailSchema.parse(pullValue);
  const analyses = analysisListSchema.parse(analysesValue).items;
  const analysis = analyses[0] ?? null;
  if (!analysis) return { pull, analysis: null, files: [], diff: null, report: null, objects: [] };
  const reportReady =
    analysis.id && (analysis.state === 'completed' || analysis.state === 'partial')
      ? analysis.id
      : null;
  const [filesValue, diffValue, reportValue, objectsValue] = await Promise.all([
    fetchJson(`/api/v1/snapshots/${analysis.snapshotId}/files`, signal),
    fetchJson(`/api/v1/snapshots/${analysis.snapshotId}/diff`, signal),
    reportReady ? fetchJson(`/api/v1/analyses/${reportReady}`, signal) : null,
    reportReady ? fetchJson(`/api/v1/analyses/${reportReady}/objects`, signal) : null,
  ]);
  return {
    pull,
    analysis,
    files: snapshotFileListSchema.parse(filesValue).items,
    diff: diffIndexSchema.parse(diffValue),
    report: reportValue ? reportViewSchema.parse(reportValue) : null,
    objects: objectsValue ? codeObjectListSchema.parse(objectsValue).items : [],
  };
}

export async function loadAnalysisWorkspace(
  analysisId: string,
  signal: AbortSignal,
): Promise<WorkspaceData> {
  const report = reportViewSchema.parse(await fetchJson(`/api/v1/analyses/${analysisId}`, signal));
  const { repositoryId, pullNumber, snapshotId } = report.context;
  const [pullValue, analysesValue, filesValue, diffValue, objectsValue] = await Promise.all([
    fetchJson(`/api/v1/repositories/${repositoryId}/pulls/${pullNumber}`, signal),
    fetchJson(`/api/v1/repositories/${repositoryId}/pulls/${pullNumber}/analyses`, signal),
    fetchJson(`/api/v1/snapshots/${snapshotId}/files`, signal),
    fetchJson(`/api/v1/snapshots/${snapshotId}/diff`, signal),
    fetchJson(`/api/v1/analyses/${analysisId}/objects`, signal),
  ]);
  const analyses = analysisListSchema.parse(analysesValue).items;
  const analysis = analyses.find((item) => item.id === analysisId);
  if (!analysis) throw new Error('Analysis revision is unavailable');
  return {
    pull: pullRequestDetailSchema.parse(pullValue),
    analysis,
    files: snapshotFileListSchema.parse(filesValue).items,
    diff: diffIndexSchema.parse(diffValue),
    report,
    objects: codeObjectListSchema.parse(objectsValue).items,
  };
}

export async function loadRelationships(
  analysisId: string,
  objectId: string,
  signal: AbortSignal,
): Promise<RelationshipView> {
  return relationshipViewSchema.parse(
    await fetchJson(
      `/api/v1/analyses/${analysisId}/objects/${objectId}/relationships?direction=outgoing&depth=3`,
      signal,
    ),
  );
}

export async function openChatSession(
  analysisId: string,
  scope: { findingId?: string; fileId?: string; symbolId?: string },
  signal: AbortSignal,
): Promise<{ session: ChatSession; messages: ChatMessage[] }> {
  const response = await fetch(`/api/v1/analyses/${analysisId}/chat-sessions`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(scope),
    signal,
  });
  if (!response.ok) throw new Error(`Chat session failed: ${response.status}`);
  const session = chatSessionSchema.parse(await response.json());
  const messages = chatMessageListSchema.parse(
    await fetchJson(`/api/v1/chat-sessions/${session.id}/messages`, signal),
  ).items;
  return { session, messages };
}

export async function sendChatMessage(
  sessionId: string,
  content: string,
  scope: { findingId?: string; fileId?: string; symbolId?: string },
): Promise<ReturnType<typeof chatSendResponseSchema.parse>> {
  const response = await fetch(`/api/v1/chat-sessions/${sessionId}/messages`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, scope }),
  });
  if (!response.ok) throw new Error(`Chat message failed: ${response.status}`);
  return chatSendResponseSchema.parse(await response.json());
}

export async function refreshPull(
  repositoryId: string,
  pullNumber: number,
): Promise<ReturnType<typeof refreshResponseSchema.parse>> {
  const response = await fetch(`/api/v1/repositories/${repositoryId}/pulls/${pullNumber}/refresh`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error(`Refresh failed: ${response.status}`);
  return refreshResponseSchema.parse(await response.json());
}

export async function waitForSnapshot(
  operationId: string,
  signal: AbortSignal,
): Promise<ReturnType<typeof operationSchema.parse>> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const operation = operationSchema.parse(
      await fetchJson(`/api/v1/operations/${operationId}`, signal),
    );
    if (operation.result?.snapshotId || operation.state === 'failed') return operation;
    await delay(500, signal);
  }
  throw new Error('Snapshot operation timed out');
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, credentials: 'same-origin' });
  if (response.status === 401) {
    window.location.assign(`/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`);
    return new Promise(() => undefined);
  }
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
