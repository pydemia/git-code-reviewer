import {
  analysisListSchema,
  diffIndexSchema,
  operationSchema,
  pullRequestDetailSchema,
  pullRequestListSchema,
  refreshResponseSchema,
  repositoryListSchema,
  snapshotFileListSchema,
  type PullRequest,
  type Repository,
} from '@gcr/contracts';

export type WorklistItem = PullRequest & { repository: Repository };
export type WorkspaceData = {
  pull: ReturnType<typeof pullRequestDetailSchema.parse>;
  analysis: ReturnType<typeof analysisListSchema.parse>['items'][number] | null;
  files: ReturnType<typeof snapshotFileListSchema.parse>['items'];
  diff: ReturnType<typeof diffIndexSchema.parse> | null;
};

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
  if (!analysis) return { pull, analysis: null, files: [], diff: null };
  const [filesValue, diffValue] = await Promise.all([
    fetchJson(`/api/v1/snapshots/${analysis.snapshotId}/files`, signal),
    fetchJson(`/api/v1/snapshots/${analysis.snapshotId}/diff`, signal),
  ]);
  return {
    pull,
    analysis,
    files: snapshotFileListSchema.parse(filesValue).items,
    diff: diffIndexSchema.parse(diffValue),
  };
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
