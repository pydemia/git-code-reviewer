import {
  defaultReviewSeverityLevel,
  type ReviewSeverityLevel,
  analysisSkillSettingsSchema,
  adminChatAccountListSchema,
  adminRepositoryListSchema,
  adminUserListSchema,
  analysisProviderSettingsSchema,
  analysisProviderTestResultSchema,
  analysisListSchema,
  analysisStatusSchema,
  analysisPromptListSchema,
  chatAccountCatalogSchema,
  chatAccountModelDiscoverySchema,
  chatMessageListSchema,
  chatSendResponseSchema,
  chatSessionSchema,
  codeObjectListSchema,
  diffIndexSchema,
  githubConnectionListSchema,
  githubPrMemorySourceListSchema,
  reviewMemoryListSchema,
  reviewMemoryResponseSchema,
  adminReviewMemoryListSchema,
  operationSchema,
  passwordChangeResultSchema,
  profileSchema,
  personalPromptResultSchema,
  pullRequestDetailSchema,
  pullRequestListSchema,
  refreshResponseSchema,
  repositoryListSchema,
  reportViewSchema,
  snapshotCommitListSchema,
  snapshotFileListSchema,
  tenantListSchema,
  userSchema,
  type AdminUser,
  type AnalysisSkillSettings,
  type AnalysisProviderMode,
  type AnalysisProviderVersion,
  type AnalysisPromptVersion,
  type PullRequestSummary,
  type Profile,
  type Repository,
  type Tenant,
  type User,
} from '@gcr/contracts';

export type WorklistItem = PullRequestSummary & { repository: Repository };
export type WorkspaceData = {
  pull: ReturnType<typeof pullRequestDetailSchema.parse>;
  analysis: ReturnType<typeof analysisListSchema.parse>['items'][number] | null;
  files: ReturnType<typeof snapshotFileListSchema.parse>['items'];
  diff: ReturnType<typeof diffIndexSchema.parse> | null;
  commits: ReturnType<typeof snapshotCommitListSchema.parse>['commits'];
  report: ReturnType<typeof reportViewSchema.parse> | null;
  objects: ReturnType<typeof codeObjectListSchema.parse>['items'];
};
export type ChatMessage = ReturnType<typeof chatMessageListSchema.parse>['items'][number];
export type ChatSession = ReturnType<typeof chatSessionSchema.parse>;
export type ChatAccountCatalog = ReturnType<typeof chatAccountCatalogSchema.parse>;
export type AdminChatAccount = ReturnType<typeof adminChatAccountListSchema.parse>['items'][number];
export type GitHubConnection = ReturnType<typeof githubConnectionListSchema.parse>['items'][number];
export type ReviewMemory = ReturnType<typeof reviewMemoryResponseSchema.parse>['memory'];
export type ReviewMemoryList = ReturnType<typeof reviewMemoryListSchema.parse>;
export type GitHubPrMemorySource = ReturnType<
  typeof githubPrMemorySourceListSchema.parse
>['items'][number];
export type AdminRepository = ReturnType<typeof adminRepositoryListSchema.parse>['items'][number];
export type { AdminUser, AnalysisPromptVersion, AnalysisProviderVersion, Profile, Tenant, User };
export type { AnalysisSkillSettings };
export type AnalysisPromptList = ReturnType<typeof analysisPromptListSchema.parse>;
export type AnalysisProviderSettings = ReturnType<typeof analysisProviderSettingsSchema.parse>;
export type AnalysisProviderInput = {
  concurrency: number;
  chatAccountId?: string;
  reasoningEffort?: string;
  mode: AnalysisProviderMode;
  endpoint?: string;
  modelName?: string;
  timeoutMs: number;
  apiKey?: string;
};

export async function loadCurrentUser(signal: AbortSignal): Promise<User> {
  return userSchema.parse(await fetchJson('/api/v1/me', signal));
}

export async function loadProfile(signal: AbortSignal): Promise<Profile> {
  return profileSchema.parse(await fetchJson('/api/v1/profile', signal));
}

export async function updateProfile(displayName: string): Promise<Profile> {
  return profileSchema.parse(await mutateJson('/api/v1/profile', 'PATCH', { displayName }));
}

export async function updatePersonalPrompt(personalPrompt: string): Promise<string> {
  return personalPromptResultSchema.parse(
    await mutateJson('/api/v1/profile/prompt', 'PUT', { personalPrompt }),
  ).personalPrompt;
}

export async function changeOwnPassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  passwordChangeResultSchema.parse(
    await mutateJson('/api/v1/profile/password', 'PUT', { currentPassword, newPassword }),
  );
}

export async function loginLocalAccount(
  username: string,
  password: string,
  returnTo: string,
): Promise<string> {
  const response = await fetch('/auth/local/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, returnTo }),
  });
  if (!response.ok) throw await requestError(response);
  const body = (await response.json()) as { returnTo?: unknown };
  return typeof body.returnTo === 'string' ? body.returnTo : '/';
}

export async function logout(): Promise<void> {
  const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  if (!response.ok && response.status !== 401) throw await requestError(response);
  window.location.assign('/login');
}

export async function loadWorklist(
  signal: AbortSignal,
  tenantId?: string,
  state: import('@gcr/contracts').PullRequestStateFilter = 'open',
): Promise<{
  items: WorklistItem[];
  counts: { open: number; closed: number; all: number };
  syncErrors: number;
  pendingSync: number;
}> {
  const query = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
  const repositories = repositoryListSchema.parse(
    await fetchJson(`/api/v1/repositories${query}`, signal),
  ).items;
  const results = await Promise.all(
    repositories.map(async (repository) => {
      const items = new Map<string, WorklistItem>();
      let cursor: string | null = null;
      let counts = { open: 0, closed: 0, all: 0 };
      do {
        const query = new URLSearchParams({ state, ...(cursor ? { cursor } : {}) });
        const response = pullRequestListSchema.parse(
          await fetchJson(`/api/v1/repositories/${repository.id}/pulls?${query}`, signal),
        );
        for (const pull of response.items) items.set(pull.id, { ...pull, repository });
        if (response.counts) counts = response.counts;
        if (
          response.nextCursor &&
          (!/^\d+$/.test(response.nextCursor) ||
            Number(response.nextCursor) > 1_000_000 ||
            Number(response.nextCursor) <= Number(cursor ?? 0))
        )
          throw new Error('PR 목록 pagination이 진행되지 않았습니다.');
        cursor = response.nextCursor;
      } while (cursor);
      return { items: [...items.values()], counts };
    }),
  );
  return {
    items: results
      .flatMap(({ items }) => items)
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
      ),
    counts: results.reduce(
      (total, { counts }) => ({
        open: total.open + counts.open,
        closed: total.closed + counts.closed,
        all: total.all + counts.all,
      }),
      { open: 0, closed: 0, all: 0 },
    ),
    syncErrors: repositories.filter((repository) => repository.pollOutcome === 'failed').length,
    pendingSync: repositories.filter((repository) => !repository.lastPolledAt).length,
  };
}

export async function loadAdminTenants(signal: AbortSignal): Promise<Tenant[]> {
  return tenantListSchema.parse(await fetchJson('/api/v1/admin/tenants', signal)).items;
}

export async function createTenant(slug: string, displayName: string): Promise<void> {
  await mutateJson('/api/v1/admin/tenants', 'POST', { slug, displayName });
}

export async function updateTenant(
  tenantId: string,
  values: { displayName?: string; enabled?: boolean },
): Promise<void> {
  await mutateJson(`/api/v1/admin/tenants/${tenantId}`, 'PATCH', values);
}

export async function loadAdminUsers(signal: AbortSignal): Promise<AdminUser[]> {
  return adminUserListSchema.parse(await fetchJson('/api/v1/admin/users', signal)).items;
}

export async function createLocalUser(values: {
  username: string;
  displayName: string;
  role: 'reviewer' | 'administrator';
  password: string;
  tenantIds: string[];
}): Promise<void> {
  await mutateJson('/api/v1/admin/users', 'POST', values);
}

export async function updateUser(
  userId: string,
  values: { displayName?: string; role?: 'reviewer' | 'administrator'; enabled?: boolean },
): Promise<void> {
  await mutateJson(`/api/v1/admin/users/${userId}`, 'PATCH', values);
}

export async function resetLocalUserPassword(userId: string, password: string): Promise<void> {
  await mutateJson(`/api/v1/admin/users/${userId}/password`, 'PUT', { password });
}

export async function deleteAdminUser(userId: string, confirmIdentity: string): Promise<void> {
  await mutateJson(`/api/v1/admin/users/${userId}`, 'DELETE', { confirmIdentity });
}

export async function updateTenantMembership(
  tenantId: string,
  userId: string,
  enabled: boolean,
): Promise<void> {
  await mutateJson(`/api/v1/admin/tenants/${tenantId}/members/${userId}`, 'PUT', { enabled });
}

export async function loadAnalysisPrompts(
  tenantId: string,
  signal: AbortSignal,
): Promise<AnalysisPromptList> {
  return analysisPromptListSchema.parse(
    await fetchJson(`/api/v1/admin/tenants/${tenantId}/analysis-prompts`, signal),
  );
}

export async function saveAnalysisPrompt(
  tenantId: string,
  instructions: string,
  severityLevel: ReviewSeverityLevel = defaultReviewSeverityLevel,
): Promise<void> {
  await mutateJson(`/api/v1/admin/tenants/${tenantId}/analysis-prompts`, 'POST', {
    instructions,
    severityLevel,
  });
}

export async function activateAnalysisPrompt(tenantId: string, promptId: string): Promise<void> {
  await mutateJson(
    `/api/v1/admin/tenants/${tenantId}/analysis-prompts/${promptId}/activate`,
    'POST',
  );
}

export async function resetAnalysisPrompt(tenantId: string): Promise<void> {
  await mutateJson(`/api/v1/admin/tenants/${tenantId}/analysis-prompts/reset`, 'POST');
}

export async function loadAnalysisProvider(signal: AbortSignal): Promise<AnalysisProviderSettings> {
  return analysisProviderSettingsSchema.parse(
    await fetchJson('/api/v1/admin/analysis-provider', signal),
  );
}

export async function loadAnalysisSkills(signal: AbortSignal): Promise<AnalysisSkillSettings> {
  return analysisSkillSettingsSchema.parse(
    await fetchJson('/api/v1/admin/analysis-skills', signal),
  );
}

export async function saveAnalysisSkills(documents: string[]): Promise<void> {
  await mutateJson('/api/v1/admin/analysis-skills/versions', 'POST', { documents });
}

export async function activateAnalysisSkills(versionId: string): Promise<void> {
  await mutateJson(`/api/v1/admin/analysis-skills/versions/${versionId}/activate`, 'POST');
}

export async function resetAnalysisSkills(): Promise<void> {
  await mutateJson('/api/v1/admin/analysis-skills/reset', 'POST');
}

export async function saveAnalysisProvider(values: AnalysisProviderInput): Promise<void> {
  await mutateJson('/api/v1/admin/analysis-provider/versions', 'POST', values);
}

export async function activateAnalysisProvider(providerId: string): Promise<void> {
  await mutateJson(`/api/v1/admin/analysis-provider/versions/${providerId}/activate`, 'POST');
}

export async function deleteAnalysisProvider(
  providerId: string,
  confirmation: string,
): Promise<void> {
  await mutateJson(`/api/v1/admin/analysis-provider/versions/${providerId}`, 'DELETE', {
    confirmation,
  });
}

export async function resetAnalysisProvider(): Promise<void> {
  await mutateJson('/api/v1/admin/analysis-provider/reset', 'POST');
}

export async function testAnalysisProvider(values: AnalysisProviderInput): Promise<number> {
  const response = await mutateJson('/api/v1/admin/analysis-provider/test', 'POST', values);
  return analysisProviderTestResultSchema.parse(response).latencyMs;
}

export async function loadChatAccounts(signal: AbortSignal): Promise<ChatAccountCatalog> {
  return chatAccountCatalogSchema.parse(await fetchJson('/api/v1/chat-accounts', signal));
}

export async function loadAdminChatAccounts(signal: AbortSignal): Promise<AdminChatAccount[]> {
  return adminChatAccountListSchema.parse(await fetchJson('/api/v1/admin/chat-accounts', signal))
    .items;
}

export async function createChatAccount(values: {
  displayName: string;
  endpoint?: string;
  authJson: string;
  models: Array<{
    id: string;
    displayName: string;
    allowedEfforts: string[];
    defaultEffort: string;
  }>;
  assignments: Array<{ scopeType: string; scopeId: string }>;
}): Promise<void> {
  await mutateJson('/api/v1/admin/chat-accounts', 'POST', values);
}

export async function updateChatAccount(
  accountId: string,
  values: { enabled?: boolean; authJson?: string },
): Promise<void> {
  await mutateJson(`/api/v1/admin/chat-accounts/${accountId}`, 'PATCH', values);
}

export async function deleteChatAccount(accountId: string, confirmation: string): Promise<void> {
  await mutateJson(`/api/v1/admin/chat-accounts/${accountId}`, 'DELETE', { confirmation });
}

export async function discoverChatAccountModels(authJson: string) {
  return chatAccountModelDiscoverySchema.parse(
    await mutateJson('/api/v1/admin/chat-accounts/discover-models', 'POST', { authJson }),
  ).items;
}

export async function loadGitHubConnections(signal: AbortSignal): Promise<GitHubConnection[]> {
  return githubConnectionListSchema.parse(
    await fetchJson('/api/v1/admin/github-connections', signal),
  ).items;
}

export async function loadAdminRepositories(signal: AbortSignal): Promise<AdminRepository[]> {
  return adminRepositoryListSchema.parse(await fetchJson('/api/v1/admin/repositories', signal))
    .items;
}

export async function updateAdminRepository(
  repositoryId: string,
  values: {
    enabled?: boolean;
    pollingEnabled?: boolean;
    reviewPublishingEnabled?: boolean;
    pollIntervalSeconds?: number;
  },
): Promise<void> {
  await mutateJson(`/api/v1/admin/repositories/${repositoryId}`, 'PATCH', values);
}

export async function updateRepositoryGrant(
  repositoryId: string,
  userId: string,
  enabled: boolean,
): Promise<void> {
  await mutateJson(`/api/v1/admin/repositories/${repositoryId}/grants/${userId}`, 'PUT', {
    enabled,
  });
}

export async function deleteAdminRepository(
  repositoryId: string,
  confirmName: string,
): Promise<void> {
  await mutateJson(`/api/v1/admin/repositories/${repositoryId}`, 'DELETE', { confirmName });
}

export async function pollAdminRepository(repositoryId: string): Promise<void> {
  await mutateJson(`/api/v1/admin/repositories/${repositoryId}/poll`, 'POST');
}

export async function createGitHubConnection(values: {
  name: string;
  apiBaseUrl: string;
  webBaseUrl: string;
  credentialLabel: string;
  accessToken: string;
  expiresAt?: string;
}): Promise<void> {
  await mutateJson('/api/v1/admin/github-connections', 'POST', values);
}

export async function updateGitHubConnection(
  connectionId: string,
  values: {
    name: string;
    apiBaseUrl: string;
    webBaseUrl: string;
    credentialLabel: string;
    accessToken?: string;
    expiresAt: string | null;
  },
): Promise<void> {
  await mutateJson(`/api/v1/admin/github-connections/${connectionId}`, 'PATCH', values);
}

export async function testGitHubConnection(connectionId: string): Promise<{
  status: number;
  latencyMs: number;
}> {
  return (await mutateJson(`/api/v1/admin/github-connections/${connectionId}/test`, 'POST')) as {
    status: number;
    latencyMs: number;
  };
}

export async function registerGitHubRepository(
  connectionId: string,
  values: {
    tenantId: string;
    repositoryUrl: string;
    pollIntervalSeconds: number;
    reviewPublishingEnabled: boolean;
    grantSubjects: string[];
  },
): Promise<void> {
  await mutateJson(`/api/v1/admin/github-connections/${connectionId}/repositories`, 'POST', values);
}

export async function loadWorkspace(
  repositoryId: string,
  pullNumber: number,
  signal: AbortSignal,
  analysisId?: string,
): Promise<WorkspaceData> {
  const [pullValue, analysesValue] = await Promise.all([
    fetchJson(`/api/v1/repositories/${repositoryId}/pulls/${pullNumber}`, signal),
    fetchJson(`/api/v1/repositories/${repositoryId}/pulls/${pullNumber}/analyses`, signal),
  ]);
  const pull = pullRequestDetailSchema.parse(pullValue);
  const analyses = analysisListSchema.parse(analysesValue).items;
  const analysis = analysisId
    ? (analyses.find((item) => item.id === analysisId) ?? null)
    : (analyses[0] ?? null);
  if (analysisId && !analysis) throw new Error('Analysis revision is unavailable');
  if (!analysis)
    return { pull, analysis: null, files: [], diff: null, commits: [], report: null, objects: [] };
  const reportReady =
    analysis.id && (analysis.state === 'completed' || analysis.state === 'partial')
      ? analysis.id
      : null;
  const [filesValue, diffValue, commitsValue, reportValue, objectsValue] = await Promise.all([
    fetchJson(`/api/v1/snapshots/${analysis.snapshotId}/files`, signal),
    fetchJson(`/api/v1/snapshots/${analysis.snapshotId}/diff`, signal),
    fetchJson(`/api/v1/snapshots/${analysis.snapshotId}/commits`, signal),
    reportReady ? fetchJson(`/api/v1/analyses/${reportReady}`, signal) : null,
    reportReady ? fetchJson(`/api/v1/analyses/${reportReady}/objects`, signal) : null,
  ]);
  return {
    pull,
    analysis,
    files: snapshotFileListSchema.parse(filesValue).items,
    diff: diffIndexSchema.parse(diffValue),
    commits: snapshotCommitListSchema.parse(commitsValue).commits,
    report: reportValue ? reportViewSchema.parse(reportValue) : null,
    objects: objectsValue ? codeObjectListSchema.parse(objectsValue).items : [],
  };
}

export async function loadAnalysisWorkspace(
  analysisId: string,
  signal: AbortSignal,
): Promise<WorkspaceData> {
  const context = await loadAnalysisStatus(analysisId, signal);
  return loadWorkspace(context.repositoryId, context.pullNumber, signal, analysisId);
}

export async function loadAnalysisStatus(analysisId: string, signal: AbortSignal) {
  return analysisStatusSchema.parse(
    await fetchJson(`/api/v1/analyses/${analysisId}/status`, signal),
  );
}

export async function openChatSession(
  analysisId: string,
  values: {
    findingId?: string;
    fileId?: string;
    symbolId?: string;
    accountId?: string;
    modelName?: string;
    reasoningEffort?: string;
    newSession?: boolean;
  },
  signal: AbortSignal,
): Promise<{ session: ChatSession; messages: ChatMessage[] }> {
  const response = await fetch(`/api/v1/analyses/${analysisId}/chat-sessions`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(values),
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

export async function loadReviewMemories(
  analysisId: string,
  signal: AbortSignal,
): Promise<ReviewMemoryList> {
  return reviewMemoryListSchema.parse(
    await fetchJson(`/api/v1/analyses/${analysisId}/review-memories`, signal),
  );
}

export async function loadGitHubPrMemorySources(
  repositoryId: string,
  pullNumber: number,
  signal: AbortSignal,
): Promise<GitHubPrMemorySource[]> {
  return githubPrMemorySourceListSchema.parse(
    await fetchJson(
      `/api/v1/repositories/${repositoryId}/pulls/${pullNumber}/review-memory-sources`,
      signal,
    ),
  ).items;
}

export async function createReviewMemoryCandidate(
  analysisId: string,
  input: {
    kind: 'recurring-finding' | 'decision' | 'false-positive' | 'open-question';
    summary: string;
    detail?: string;
    recommendation?: string;
    categories?: string[];
    filePaths?: string[];
    symbols?: string[];
    confidence?: number;
    importance?: number;
    sourceFindingId?: string;
    sourceChatMessageId?: string;
    sourceGithubPrMessageId?: string;
  },
): Promise<ReviewMemory> {
  return reviewMemoryResponseSchema.parse(
    await mutateJson(`/api/v1/analyses/${analysisId}/review-memory-candidates`, 'POST', input),
  ).memory;
}

export async function reviewPersonalMemory(
  memoryId: string,
  action: 'activate' | 'reject' | 'retire',
): Promise<ReviewMemory> {
  return reviewMemoryResponseSchema.parse(
    await mutateJson(`/api/v1/review-memories/${memoryId}/review`, 'POST', { action }),
  ).memory;
}

export async function updateGitHubPrMemorySource(
  repositoryId: string,
  pullNumber: number,
  sourceId: string,
  state: 'available' | 'ignored',
): Promise<void> {
  await mutateJson(
    `/api/v1/repositories/${repositoryId}/pulls/${pullNumber}/review-memory-sources/${sourceId}`,
    'PATCH',
    { state },
  );
}

export async function loadAdminReviewMemories(
  signal: AbortSignal,
  filters: { tenantId?: string; repositoryId?: string; state?: string } = {},
): Promise<ReviewMemory[]> {
  const query = new URLSearchParams({ scope: 'collective' });
  if (filters.tenantId) query.set('tenantId', filters.tenantId);
  if (filters.repositoryId) query.set('repositoryId', filters.repositoryId);
  if (filters.state) query.set('state', filters.state);
  return adminReviewMemoryListSchema.parse(
    await fetchJson(`/api/v1/admin/review-memories?${query}`, signal),
  ).items;
}

export async function reviewCollectiveMemory(
  memoryId: string,
  action: 'activate' | 'reject' | 'retire',
): Promise<ReviewMemory> {
  return reviewMemoryResponseSchema.parse(
    await mutateJson(`/api/v1/admin/review-memories/${memoryId}/review`, 'POST', { action }),
  ).memory;
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
  if (!response.ok) throw await requestError(response);
  return response.json();
}

async function mutateJson(
  url: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    ...(body
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  if (response.status === 401) {
    window.location.assign(`/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`);
    return new Promise(() => undefined);
  }
  if (!response.ok) throw await requestError(response);
  return response.status === 204 ? null : response.json();
}

async function requestError(response: Response): Promise<Error> {
  const fallback = `Request failed: ${response.status}`;
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    return new Error(typeof body.error?.message === 'string' ? body.error.message : fallback);
  } catch {
    return new Error(fallback);
  }
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
