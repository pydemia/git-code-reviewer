import {
  pullRequestListSchema,
  repositoryListSchema,
  type PullRequest,
  type Repository,
} from '@gcr/contracts';

export type WorklistItem = PullRequest & { repository: Repository };

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

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, credentials: 'same-origin' });
  if (response.status === 401) {
    window.location.assign(`/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`);
    return new Promise(() => undefined);
  }
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}
