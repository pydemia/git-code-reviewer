import {
  Building2,
  Check,
  Cpu,
  FileText,
  Github,
  KeyRound,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import {
  githubRepositoryExample,
  parseGitHubRepositoryUrl,
  localPasswordMaximumLength,
  localPasswordMinimumLength,
  defaultReviewSeverityLevel,
  reviewSeverityLevels,
  type ReviewSeverityLevel,
} from '@gcr/contracts';
import { SeverityLevelField } from './SeverityLevelField';
import { UserDeleteDialog } from './UserDeleteDialog';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  activateAnalysisProvider,
  activateAnalysisPrompt,
  createLocalUser,
  createTenant,
  createChatAccount,
  discoverChatAccountModels,
  createGitHubConnection,
  deleteAdminRepository,
  deleteAdminUser,
  registerGitHubRepository,
  loadAdminChatAccounts,
  loadAdminRepositories,
  loadGitHubConnections,
  pollAdminRepository,
  loadAdminTenants,
  loadAdminUsers,
  loadAnalysisProvider,
  loadAnalysisPrompts,
  loadCurrentUser,
  resetAnalysisProvider,
  resetAnalysisPrompt,
  resetLocalUserPassword,
  saveAnalysisProvider,
  saveAnalysisPrompt,
  testAnalysisProvider,
  testGitHubConnection,
  updateAdminRepository,
  updateChatAccount,
  updateGitHubConnection,
  updateRepositoryGrant,
  updateTenant,
  updateTenantMembership,
  updateUser,
  type AdminUser,
  type AdminChatAccount,
  type AdminRepository,
  type AnalysisProviderInput,
  type AnalysisProviderSettings,
  type AnalysisPromptList,
  type Tenant,
  type GitHubConnection,
  type User,
} from './api.ts';
import { AppHeader } from './AppHeader.tsx';
import { AnalysisSkillsPanel } from './AnalysisSkillsPanel.tsx';

type AdminTab = 'tenants' | 'users' | 'provider' | 'prompt' | 'skills' | 'chat' | 'github';
type TenantForm = {
  id?: string;
  slug: string;
  displayName: string;
  enabled: boolean;
};
type ProviderDraft = {
  mode: 'disabled' | 'openai-compatible' | 'chatgpt-account';
  chatAccountId: string;
  reasoningEffort: string;
  endpoint: string;
  modelName: string;
  timeoutMs: number;
  apiKey: string;
};
type UserForm = {
  id?: string;
  username: string;
  displayName: string;
  role: 'reviewer' | 'administrator';
  password: string;
  tenantIds: string[];
  enabled: boolean;
};
type PasswordForm = { id: string; displayName: string; password: string };
type RepositoryGrantForm = {
  userId: string;
  displayName: string;
  tenantId: string;
  initialRepositoryIds: string[];
  repositoryIds: string[];
};
type GitHubConnectionUpdateValues = {
  name: string;
  apiBaseUrl: string;
  webBaseUrl: string;
  credentialLabel: string;
  accessToken?: string;
  expiresAt: string | null;
};

const ADMIN_TENANT_STORAGE_KEY = 'git-code-reviewer.admin-tenant.v1';

export function AdminPage() {
  const [tab, setTab] = useState<AdminTab>(() => readTab());
  const [reloadToken, setReloadToken] = useState(0);
  const [user, setUser] = useState<User | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState(
    () => window.localStorage.getItem(ADMIN_TENANT_STORAGE_KEY) ?? '',
  );
  const [promptData, setPromptData] = useState<AnalysisPromptList | null>(null);
  const [promptDraft, setPromptDraft] = useState('');
  const [promptSeverity, setPromptSeverity] = useState<ReviewSeverityLevel>(
    defaultReviewSeverityLevel,
  );
  const [providerData, setProviderData] = useState<AnalysisProviderSettings | null>(null);
  const [chatAccounts, setChatAccounts] = useState<AdminChatAccount[]>([]);
  const [githubConnections, setGithubConnections] = useState<GitHubConnection[]>([]);
  const [adminRepositories, setAdminRepositories] = useState<AdminRepository[]>([]);
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>({
    chatAccountId: '',
    reasoningEffort: '',
    mode: 'disabled',
    endpoint: '',
    modelName: '',
    timeoutMs: 120_000,
    apiKey: '',
  });
  const [tenantForm, setTenantForm] = useState<TenantForm | null>(null);
  const [userForm, setUserForm] = useState<UserForm | null>(null);
  const [passwordForm, setPasswordForm] = useState<PasswordForm | null>(null);
  const [deleteUser, setDeleteUser] = useState<AdminUser | null>(null);
  const [repositoryGrantForm, setRepositoryGrantForm] = useState<RepositoryGrantForm | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void Promise.all([
      loadCurrentUser(controller.signal),
      loadAdminTenants(controller.signal),
      loadAdminUsers(controller.signal),
      loadAnalysisProvider(controller.signal),
      loadAdminChatAccounts(controller.signal),
      loadGitHubConnections(controller.signal),
      loadAdminRepositories(controller.signal),
    ]).then(
      ([
        currentUser,
        tenantItems,
        userItems,
        providerSettings,
        accountItems,
        connectionItems,
        repositories,
      ]) => {
        if (currentUser.role !== 'administrator') {
          window.location.replace('/');
          return;
        }
        setUser(currentUser);
        setTenants(tenantItems);
        setUsers(userItems);
        setProviderData(providerSettings);
        setProviderDraft(providerDraftFrom(providerSettings));
        setChatAccounts(accountItems);
        setGithubConnections(connectionItems);
        setAdminRepositories(repositories);
        setSelectedTenantId((current) => {
          const selected = tenantItems.some((tenant) => tenant.id === current)
            ? current
            : (tenantItems.find((tenant) => tenant.enabled)?.id ?? tenantItems[0]?.id ?? '');
          if (selected) window.localStorage.setItem(ADMIN_TENANT_STORAGE_KEY, selected);
          return selected;
        });
        setStatus('ready');
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setMessage({ tone: 'error', text: errorMessage(error) });
          setStatus('error');
        }
      },
    );
    return () => controller.abort();
  }, [reloadToken]);

  useEffect(() => {
    if (tab !== 'prompt') return;
    if (!selectedTenantId) {
      setPromptData(null);
      setPromptDraft('');
      setPromptSeverity(defaultReviewSeverityLevel);
      return;
    }
    const controller = new AbortController();
    setPromptData(null);
    void loadAnalysisPrompts(selectedTenantId, controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return;
        setPromptData(value);
        setPromptDraft(value.active?.instructions ?? '');
        setPromptSeverity(value.active?.severityLevel ?? defaultReviewSeverityLevel);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setMessage({ tone: 'error', text: errorMessage(error) });
      },
    );
    return () => controller.abort();
  }, [reloadToken, selectedTenantId, tab]);

  const selectedTenant = tenants.find((tenant) => tenant.id === selectedTenantId) ?? null;
  const visibleUsers = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return users;
    return users.filter((item) =>
      [item.displayName, item.subject, item.role, ...item.groups]
        .join(' ')
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [search, users]);

  const selectTab = (nextTab: AdminTab) => {
    setTab(nextTab);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', nextTab);
    window.history.replaceState(null, '', url);
  };

  const selectTenant = (tenantId: string) => {
    window.localStorage.setItem(ADMIN_TENANT_STORAGE_KEY, tenantId);
    setSelectedTenantId(tenantId);
  };

  const runMutation = async (key: string, task: () => Promise<void>, success: string) => {
    setBusyKey(key);
    setMessage(null);
    try {
      await task();
      setMessage({ tone: 'success', text: success });
      setReloadToken((value) => value + 1);
      return true;
    } catch (error) {
      setMessage({ tone: 'error', text: errorMessage(error) });
      return false;
    } finally {
      setBusyKey(null);
    }
  };

  const submitGitHubConnectionUpdate = async (
    connectionId: string,
    values: GitHubConnectionUpdateValues,
  ): Promise<string | null> => {
    setBusyKey(`github:update:${connectionId}`);
    setMessage(null);
    try {
      await updateGitHubConnection(connectionId, values);
      setMessage({
        tone: 'success',
        text: 'GHES 연결 설정을 저장했습니다. 연결 테스트를 다시 실행해 주세요.',
      });
      setReloadToken((value) => value + 1);
      return null;
    } catch (error) {
      return errorMessage(error);
    } finally {
      setBusyKey(null);
    }
  };

  const submitRepositoryDelete = async (repository: AdminRepository): Promise<string | null> => {
    setBusyKey(`repository:delete:${repository.id}`);
    setMessage(null);
    try {
      await deleteAdminRepository(repository.id, `${repository.owner}/${repository.name}`);
      setAdminRepositories((current) => current.filter((item) => item.id !== repository.id));
      setMessage({
        tone: 'success',
        text: `${repository.owner}/${repository.name}의 review 등록을 삭제했습니다.`,
      });
      setReloadToken((value) => value + 1);
      return null;
    } catch (error) {
      return errorMessage(error);
    } finally {
      setBusyKey(null);
    }
  };

  const submitUserDelete = async (confirmation: string): Promise<string | null> => {
    if (!deleteUser) return '삭제할 사용자를 다시 선택해 주세요.';
    setBusyKey(`user:delete:${deleteUser.id}`);
    setMessage(null);
    try {
      await deleteAdminUser(deleteUser.id, confirmation);
      setUsers((current) => current.filter((item) => item.id !== deleteUser.id));
      setMessage({ tone: 'success', text: `${deleteUser.displayName} 계정을 삭제했습니다.` });
      setReloadToken((value) => value + 1);
      return null;
    } catch (error) {
      return errorMessage(error);
    } finally {
      setBusyKey(null);
    }
  };

  const submitTenant = async (event: FormEvent) => {
    event.preventDefault();
    if (!tenantForm) return;
    const key = tenantForm.id ? `tenant:${tenantForm.id}` : 'tenant:new';
    const succeeded = await runMutation(
      key,
      () =>
        tenantForm.id
          ? updateTenant(tenantForm.id, {
              displayName: tenantForm.displayName,
              enabled: tenantForm.enabled,
            })
          : createTenant(tenantForm.slug, tenantForm.displayName),
      tenantForm.id ? '테넌트 설정을 저장했습니다.' : '테넌트를 생성했습니다.',
    );
    if (succeeded) setTenantForm(null);
  };

  const submitUser = async (event: FormEvent) => {
    event.preventDefault();
    if (!userForm) return;
    const succeeded = await runMutation(
      userForm.id ? `user:${userForm.id}` : 'user:new',
      () =>
        userForm.id
          ? updateUser(userForm.id, {
              displayName: userForm.displayName,
              role: userForm.role,
              enabled: userForm.enabled,
            })
          : createLocalUser({
              username: userForm.username,
              displayName: userForm.displayName,
              role: userForm.role,
              password: userForm.password,
              tenantIds: userForm.tenantIds,
            }),
      userForm.id ? '사용자 정보를 저장했습니다.' : 'Local account를 생성했습니다.',
    );
    if (succeeded) setUserForm(null);
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!passwordForm) return;
    const succeeded = await runMutation(
      `password:${passwordForm.id}`,
      () => resetLocalUserPassword(passwordForm.id, passwordForm.password),
      `${passwordForm.displayName}의 비밀번호를 변경했습니다.`,
    );
    if (succeeded) setPasswordForm(null);
  };

  const submitRepositoryGrants = async (event: FormEvent) => {
    event.preventDefault();
    if (!repositoryGrantForm) return;
    const repositoryIds = adminRepositories
      .filter((repository) => repository.tenantId === repositoryGrantForm.tenantId)
      .map((repository) => repository.id);
    const succeeded = await runMutation(
      `repository-grants:${repositoryGrantForm.userId}`,
      async () => {
        await Promise.all(
          repositoryIds
            .filter(
              (repositoryId) =>
                repositoryGrantForm.initialRepositoryIds.includes(repositoryId) !==
                repositoryGrantForm.repositoryIds.includes(repositoryId),
            )
            .map((repositoryId) =>
              updateRepositoryGrant(
                repositoryId,
                repositoryGrantForm.userId,
                repositoryGrantForm.repositoryIds.includes(repositoryId),
              ),
            ),
        );
      },
      `${repositoryGrantForm.displayName}의 repository 접근 권한을 저장했습니다.`,
    );
    if (succeeded) setRepositoryGrantForm(null);
  };

  const submitPrompt = async () => {
    if (!selectedTenantId || promptData?.tenant.id !== selectedTenantId || busyKey) return;
    await runMutation(
      'prompt:save',
      () => saveAnalysisPrompt(selectedTenantId, promptDraft, promptSeverity),
      '새 프롬프트 버전을 활성화했습니다.',
    );
  };

  const providerInput = (): AnalysisProviderInput =>
    providerDraft.mode === 'disabled'
      ? { mode: 'disabled', timeoutMs: providerDraft.timeoutMs }
      : providerDraft.mode === 'chatgpt-account'
        ? {
            mode: 'chatgpt-account',
            chatAccountId: providerDraft.chatAccountId,
            modelName: providerDraft.modelName,
            reasoningEffort: providerDraft.reasoningEffort,
            timeoutMs: providerDraft.timeoutMs,
          }
        : {
            mode: 'openai-compatible',
            endpoint: providerDraft.endpoint,
            modelName: providerDraft.modelName,
            timeoutMs: providerDraft.timeoutMs,
            ...(providerDraft.apiKey.trim() ? { apiKey: providerDraft.apiKey.trim() } : {}),
          };

  const submitProvider = async () => {
    const succeeded = await runMutation(
      'provider:save',
      () => saveAnalysisProvider(providerInput()),
      '새 Provider 버전을 활성화했습니다.',
    );
    if (succeeded) setProviderDraft((current) => ({ ...current, apiKey: '' }));
  };

  const testProvider = async () => {
    setBusyKey('provider:test');
    setMessage(null);
    try {
      const latencyMs = await testAnalysisProvider(providerInput());
      setMessage({ tone: 'success', text: `Provider 연결을 확인했습니다. ${latencyMs}ms` });
    } catch (error) {
      setMessage({ tone: 'error', text: errorMessage(error) });
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="admin-page">
      <AppHeader user={user} />
      <div className="admin-shell">
        <aside className="admin-nav" aria-label="관리 메뉴">
          <div className="admin-nav-heading">
            <KeyRound size={16} />
            <strong>Administration</strong>
          </div>
          <button
            className={tab === 'tenants' ? 'active' : ''}
            type="button"
            onClick={() => selectTab('tenants')}
          >
            <Building2 size={16} /> 테넌트
          </button>
          <button
            className={tab === 'users' ? 'active' : ''}
            type="button"
            onClick={() => selectTab('users')}
          >
            <Users size={16} /> 사용자
          </button>
          <button
            className={tab === 'provider' ? 'active' : ''}
            type="button"
            onClick={() => selectTab('provider')}
          >
            <Cpu size={16} /> 분석 Provider
          </button>
          <button
            className={tab === 'prompt' ? 'active' : ''}
            type="button"
            onClick={() => selectTab('prompt')}
          >
            <FileText size={16} /> 분석 프롬프트
          </button>
          <button
            className={tab === 'skills' ? 'active' : ''}
            type="button"
            onClick={() => selectTab('skills')}
          >
            <FileText size={16} /> 분석 Skills
          </button>
          <button
            className={tab === 'chat' ? 'active' : ''}
            type="button"
            onClick={() => selectTab('chat')}
          >
            <MessageSquare size={16} /> ChatGPT accounts
          </button>
          <button
            className={tab === 'github' ? 'active' : ''}
            type="button"
            onClick={() => selectTab('github')}
          >
            <Github size={16} /> GHES 연결
          </button>
        </aside>

        <main className="admin-main">
          {message ? (
            <div className={`admin-message ${message.tone}`} role="status">
              {message.tone === 'success' ? <Check size={15} /> : <X size={15} />}
              <span>{message.text}</span>
              <button type="button" onClick={() => setMessage(null)} aria-label="메시지 닫기">
                <X size={14} />
              </button>
            </div>
          ) : null}

          {tab === 'tenants' ? (
            <TenantPanel
              tenants={tenants}
              loading={status === 'loading'}
              busyKey={busyKey}
              onCreate={() => setTenantForm({ slug: '', displayName: '', enabled: true })}
              onEdit={(tenant) =>
                setTenantForm({
                  id: tenant.id,
                  slug: tenant.slug,
                  displayName: tenant.displayName,
                  enabled: tenant.enabled,
                })
              }
              onToggle={(tenant) =>
                void runMutation(
                  `tenant:${tenant.id}`,
                  () => updateTenant(tenant.id, { enabled: !tenant.enabled }),
                  `${tenant.displayName} 테넌트를 ${tenant.enabled ? '비활성화' : '활성화'}했습니다.`,
                )
              }
            />
          ) : null}

          {tab === 'users' ? (
            <UserPanel
              currentUserId={user?.id ?? ''}
              users={visibleUsers}
              tenants={tenants}
              repositories={adminRepositories}
              selectedTenantId={selectedTenantId}
              search={search}
              busyKey={busyKey}
              onSearch={setSearch}
              onTenantChange={selectTenant}
              onCreate={() =>
                setUserForm({
                  username: '',
                  displayName: '',
                  role: 'reviewer',
                  password: '',
                  tenantIds: selectedTenantId ? [selectedTenantId] : [],
                  enabled: true,
                })
              }
              onEdit={(item) =>
                setUserForm({
                  id: item.id,
                  username: item.username ?? '',
                  displayName: item.displayName,
                  role: item.role,
                  password: '',
                  tenantIds: item.memberships
                    .filter((membership) => membership.enabled)
                    .map((membership) => membership.tenantId),
                  enabled: item.enabled,
                })
              }
              onResetPassword={(item) =>
                setPasswordForm({ id: item.id, displayName: item.displayName, password: '' })
              }
              onDelete={setDeleteUser}
              onManageRepositories={(item) => {
                const repositoryIds = item.repositoryGrants.map((grant) => grant.repositoryId);
                setRepositoryGrantForm({
                  userId: item.id,
                  displayName: item.displayName,
                  tenantId: selectedTenantId,
                  initialRepositoryIds: repositoryIds,
                  repositoryIds,
                });
              }}
              onAccessChange={(item, enabled) =>
                void runMutation(
                  `user:${item.id}`,
                  () => updateUser(item.id, { enabled }),
                  `${item.displayName}의 앱 접근 권한을 변경했습니다.`,
                )
              }
              onMembershipChange={(item, enabled) =>
                void runMutation(
                  `membership:${item.id}`,
                  () => updateTenantMembership(selectedTenantId, item.id, enabled),
                  `${item.displayName}의 테넌트 멤버십을 변경했습니다.`,
                )
              }
            />
          ) : null}

          {tab === 'provider' ? (
            <ProviderPanel
              accounts={chatAccounts}
              data={providerData}
              draft={providerDraft}
              busyKey={busyKey}
              onDraftChange={setProviderDraft}
              onTest={() => void testProvider()}
              onSave={() => void submitProvider()}
              onActivate={(providerId) =>
                void runMutation(
                  `provider:${providerId}`,
                  () => activateAnalysisProvider(providerId),
                  '선택한 Provider 버전을 활성화했습니다.',
                )
              }
              onReset={() => {
                if (!window.confirm('배포 환경의 Provider 설정으로 되돌릴까요?')) return;
                void runMutation(
                  'provider:reset',
                  resetAnalysisProvider,
                  '배포 환경의 Provider 설정으로 되돌렸습니다.',
                );
              }}
            />
          ) : null}

          <AnalysisSkillsPanel visible={tab === 'skills'} />
          {tab === 'prompt' ? (
            <PromptPanel
              tenants={tenants}
              selectedTenant={selectedTenant}
              selectedTenantId={selectedTenantId}
              data={promptData}
              draft={promptDraft}
              severityLevel={promptSeverity}
              onSeverityChange={setPromptSeverity}
              busyKey={busyKey}
              onTenantChange={selectTenant}
              onDraftChange={setPromptDraft}
              onSave={() => void submitPrompt()}
              onActivate={(promptId) =>
                void runMutation(
                  `prompt:${promptId}`,
                  () => activateAnalysisPrompt(selectedTenantId, promptId),
                  '선택한 프롬프트 버전을 활성화했습니다.',
                )
              }
              onReset={() => {
                if (!window.confirm('추가 지침을 비우고 분석 수준을 moderate로 되돌릴까요?'))
                  return;
                void runMutation(
                  'prompt:reset',
                  () => resetAnalysisPrompt(selectedTenantId),
                  '기본 분석 프롬프트로 되돌렸습니다.',
                );
              }}
            />
          ) : null}

          {tab === 'chat' ? (
            <ChatAccountPanel
              accounts={chatAccounts}
              tenants={tenants}
              busyKey={busyKey}
              onCreate={(values) =>
                runMutation(
                  'chat-account:create',
                  () => createChatAccount(values),
                  'ChatGPT account를 등록했습니다.',
                )
              }
              onToggle={(accountId, enabled) =>
                runMutation(
                  `chat-account:${accountId}`,
                  () => updateChatAccount(accountId, { enabled }),
                  `ChatGPT account를 ${enabled ? '활성화' : '비활성화'}했습니다.`,
                )
              }
            />
          ) : null}

          {tab === 'github' ? (
            <GitHubConnectionPanel
              connections={githubConnections}
              repositories={adminRepositories}
              tenants={tenants}
              users={users}
              busyKey={busyKey}
              onCreate={(values) =>
                runMutation(
                  'github:create',
                  () => createGitHubConnection(values),
                  'GHES access token 연결을 등록했습니다.',
                )
              }
              onTest={(connectionId) =>
                runMutation(
                  `github:test:${connectionId}`,
                  async () => {
                    await testGitHubConnection(connectionId);
                  },
                  'GHES 연결을 확인했습니다.',
                )
              }
              onUpdate={submitGitHubConnectionUpdate}
              onDeleteRepository={submitRepositoryDelete}
              onRegisterRepository={(connectionId, values) =>
                runMutation(
                  'github:repository',
                  () => registerGitHubRepository(connectionId, values),
                  'Review 대상 repository를 등록하고 polling을 예약했습니다.',
                )
              }
              onRepositoryPollingChange={(repositoryId, enabled) =>
                runMutation(
                  `repository:${repositoryId}`,
                  () => updateAdminRepository(repositoryId, { pollingEnabled: enabled }),
                  `Repository polling을 ${enabled ? '활성화' : '중지'}했습니다.`,
                )
              }
              onRepositoryPublishingChange={(repositoryId, enabled) =>
                runMutation(
                  `repository:publishing:${repositoryId}`,
                  () => updateAdminRepository(repositoryId, { reviewPublishingEnabled: enabled }),
                  `PR review 결과 게시를 ${enabled ? '활성화' : '중지'}했습니다.`,
                )
              }
              onPollNow={(repositoryId) =>
                runMutation(
                  `repository:poll:${repositoryId}`,
                  () => pollAdminRepository(repositoryId),
                  '즉시 polling을 예약했습니다.',
                )
              }
            />
          ) : null}

          {status === 'error' ? (
            <div className="admin-empty">관리 데이터를 불러오지 못했습니다.</div>
          ) : null}
        </main>
      </div>

      {deleteUser ? (
        <UserDeleteDialog
          key={deleteUser.id}
          user={deleteUser}
          busy={busyKey === `user:delete:${deleteUser.id}`}
          onClose={() => setDeleteUser(null)}
          onSubmit={submitUserDelete}
        />
      ) : null}

      {tenantForm ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setTenantForm(null)}>
          <form
            className="admin-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="tenant-dialog-title"
            onSubmit={(event) => void submitTenant(event)}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="dialog-heading">
              <h2 id="tenant-dialog-title">{tenantForm.id ? '테넌트 편집' : '테넌트 생성'}</h2>
              <button
                type="button"
                className="icon-button surface-icon"
                onClick={() => setTenantForm(null)}
                aria-label="닫기"
              >
                <X size={16} />
              </button>
            </div>
            <label className="field-label">
              표시 이름
              <input
                required
                maxLength={120}
                value={tenantForm.displayName}
                onChange={(event) =>
                  setTenantForm((current) =>
                    current ? { ...current, displayName: event.target.value } : current,
                  )
                }
              />
            </label>
            <label className="field-label">
              Slug
              <input
                required
                minLength={2}
                maxLength={63}
                pattern="[a-z0-9][a-z0-9-]+"
                disabled={Boolean(tenantForm.id)}
                value={tenantForm.slug}
                onChange={(event) =>
                  setTenantForm((current) =>
                    current
                      ? { ...current, slug: event.target.value.toLocaleLowerCase() }
                      : current,
                  )
                }
              />
            </label>
            {tenantForm.id ? (
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={tenantForm.enabled}
                  onChange={(event) =>
                    setTenantForm((current) =>
                      current ? { ...current, enabled: event.target.checked } : current,
                    )
                  }
                />
                활성
              </label>
            ) : null}
            <div className="dialog-actions">
              <button type="button" className="command-button" onClick={() => setTenantForm(null)}>
                취소
              </button>
              <button type="submit" className="command-button primary" disabled={busyKey !== null}>
                <Save size={15} /> 저장
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {userForm ? (
        <UserDialog
          value={userForm}
          tenants={tenants}
          busy={busyKey !== null}
          onChange={setUserForm}
          onClose={() => setUserForm(null)}
          onSubmit={submitUser}
        />
      ) : null}
      {passwordForm ? (
        <PasswordDialog
          value={passwordForm}
          busy={busyKey !== null}
          onChange={setPasswordForm}
          onClose={() => setPasswordForm(null)}
          onSubmit={submitPassword}
        />
      ) : null}
      {repositoryGrantForm ? (
        <RepositoryGrantDialog
          value={repositoryGrantForm}
          repositories={adminRepositories.filter(
            (repository) => repository.tenantId === repositoryGrantForm.tenantId,
          )}
          busy={busyKey !== null}
          onChange={setRepositoryGrantForm}
          onClose={() => setRepositoryGrantForm(null)}
          onSubmit={submitRepositoryGrants}
        />
      ) : null}
    </div>
  );
}

function TenantPanel({
  tenants,
  loading,
  busyKey,
  onCreate,
  onEdit,
  onToggle,
}: {
  tenants: Tenant[];
  loading: boolean;
  busyKey: string | null;
  onCreate: () => void;
  onEdit: (tenant: Tenant) => void;
  onToggle: (tenant: Tenant) => void;
}) {
  return (
    <section className="admin-section">
      <div className="admin-title-row">
        <div>
          <p className="eyebrow">Access boundary</p>
          <h1>테넌트</h1>
        </div>
        <button className="command-button primary" type="button" onClick={onCreate}>
          <Plus size={15} /> 테넌트 생성
        </button>
      </div>
      <div className="admin-table tenant-table">
        <div className="admin-table-head">
          <span>테넌트</span>
          <span>멤버</span>
          <span>저장소</span>
          <span>상태</span>
          <span />
        </div>
        {tenants.map((tenant) => (
          <div className="admin-table-row" key={tenant.id}>
            <span className="admin-primary">
              <strong>{tenant.displayName}</strong>
              <code>{tenant.slug}</code>
            </span>
            <span>{tenant.memberCount}</span>
            <span>{tenant.repositoryCount}</span>
            <label className="switch-control">
              <input
                type="checkbox"
                checked={tenant.enabled}
                disabled={busyKey === `tenant:${tenant.id}`}
                onChange={() => onToggle(tenant)}
              />
              <span aria-hidden="true" />
              <b>{tenant.enabled ? '활성' : '비활성'}</b>
            </label>
            <button
              className="icon-button surface-icon"
              type="button"
              title="편집"
              aria-label={`${tenant.displayName} 편집`}
              onClick={() => onEdit(tenant)}
            >
              <Pencil size={15} />
            </button>
          </div>
        ))}
        {loading ? <div className="admin-empty">불러오는 중</div> : null}
      </div>
    </section>
  );
}

export function UserPanel({
  currentUserId,
  users,
  tenants,
  repositories,
  selectedTenantId,
  search,
  busyKey,
  onSearch,
  onTenantChange,
  onCreate,
  onEdit,
  onResetPassword,
  onDelete,
  onManageRepositories,
  onAccessChange,
  onMembershipChange,
}: {
  currentUserId: string;
  users: AdminUser[];
  tenants: Tenant[];
  repositories: AdminRepository[];
  selectedTenantId: string;
  search: string;
  busyKey: string | null;
  onSearch: (value: string) => void;
  onTenantChange: (value: string) => void;
  onCreate: () => void;
  onEdit: (user: AdminUser) => void;
  onResetPassword: (user: AdminUser) => void;
  onDelete: (user: AdminUser) => void;
  onManageRepositories: (user: AdminUser) => void;
  onAccessChange: (user: AdminUser, enabled: boolean) => void;
  onMembershipChange: (user: AdminUser, enabled: boolean) => void;
}) {
  return (
    <section className="admin-section">
      <div className="admin-title-row">
        <div>
          <p className="eyebrow">Identity access</p>
          <h1 id="admin-users-heading" tabIndex={-1}>
            사용자
          </h1>
        </div>
        <button className="command-button primary" type="button" onClick={onCreate}>
          <Plus size={15} /> 사용자 생성
        </button>
      </div>
      <div className="admin-toolbar">
        <label className="toolbar-search">
          <Search size={15} />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="사용자 검색"
          />
        </label>
        <label className="toolbar-select">
          <span>멤버십</span>
          <select value={selectedTenantId} onChange={(event) => onTenantChange(event.target.value)}>
            {tenants.map((tenant) => (
              <option value={tenant.id} key={tenant.id}>
                {tenant.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="admin-table user-table">
        <div className="admin-table-head">
          <span>사용자</span>
          <span>역할</span>
          <span>앱 접근</span>
          <span>테넌트 멤버</span>
          <span>저장소</span>
          <span>관리</span>
        </div>
        {users.map((item) => {
          const membership = item.memberships.find((value) => value.tenantId === selectedTenantId);
          const tenantRepositories = repositories.filter(
            (repository) => repository.tenantId === selectedTenantId,
          );
          const repositoryGrantCount = tenantRepositories.filter((repository) =>
            item.repositoryGrants.some((grant) => grant.repositoryId === repository.id),
          ).length;
          return (
            <div className="admin-table-row" key={item.id}>
              <span className="admin-primary">
                <strong>{item.displayName}</strong>
                <code>{item.identityType === 'local' ? item.username : item.subject}</code>
              </span>
              <span className={`role-badge ${item.role}`}>
                {item.role === 'administrator' ? 'Administrator' : 'Reviewer'}
              </span>
              <label className="switch-control">
                <input
                  type="checkbox"
                  checked={item.enabled}
                  disabled={item.id === currentUserId || busyKey === `user:${item.id}`}
                  onChange={(event) => onAccessChange(item, event.target.checked)}
                />
                <span aria-hidden="true" />
                <b>{item.enabled ? '허용' : '차단'}</b>
              </label>
              <label className="switch-control">
                <input
                  type="checkbox"
                  checked={membership?.enabled ?? false}
                  disabled={!selectedTenantId || busyKey === `membership:${item.id}`}
                  onChange={(event) => onMembershipChange(item, event.target.checked)}
                />
                <span aria-hidden="true" />
                <b>{membership?.enabled ? '소속' : '미소속'}</b>
              </label>
              <button
                className="repository-grant-button"
                type="button"
                disabled={item.role === 'administrator' || !membership?.enabled}
                onClick={() => onManageRepositories(item)}
              >
                {item.role === 'administrator'
                  ? '전체'
                  : `${repositoryGrantCount}/${tenantRepositories.length}`}
              </button>
              <span className="user-row-actions">
                <button
                  className="icon-button surface-icon"
                  type="button"
                  title="사용자 편집"
                  aria-label={`${item.displayName} 편집`}
                  disabled={item.identityType !== 'local'}
                  onClick={() => onEdit(item)}
                >
                  <Pencil size={14} />
                </button>
                <button
                  className="icon-button surface-icon"
                  type="button"
                  title="비밀번호 재설정"
                  aria-label={`${item.displayName} 비밀번호 재설정`}
                  disabled={item.identityType !== 'local'}
                  onClick={() => onResetPassword(item)}
                >
                  <KeyRound size={14} />
                </button>
                <button
                  className="icon-button surface-icon"
                  type="button"
                  title={
                    item.id === currentUserId
                      ? '현재 로그인한 계정은 삭제할 수 없습니다.'
                      : '사용자 삭제'
                  }
                  aria-label={`${item.displayName} 삭제`}
                  disabled={item.id === currentUserId || busyKey !== null}
                  onClick={() => onDelete(item)}
                >
                  <Trash2 size={14} />
                </button>
              </span>
            </div>
          );
        })}
        {users.length === 0 ? <div className="admin-empty">일치하는 사용자가 없습니다.</div> : null}
      </div>
    </section>
  );
}

function UserDialog({
  value,
  tenants,
  busy,
  onChange,
  onClose,
  onSubmit,
}: {
  value: UserForm;
  tenants: Tenant[];
  busy: boolean;
  onChange: (value: UserForm) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const toggleTenant = (tenantId: string, selected: boolean) => {
    onChange({
      ...value,
      tenantIds: selected
        ? [...new Set([...value.tenantIds, tenantId])]
        : value.tenantIds.filter((id) => id !== tenantId),
    });
  };
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="admin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-dialog-title"
        onSubmit={onSubmit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-heading">
          <h2 id="user-dialog-title">{value.id ? '사용자 편집' : 'Local account 생성'}</h2>
          <button
            className="icon-button surface-icon"
            type="button"
            onClick={onClose}
            aria-label="닫기"
          >
            <X size={16} />
          </button>
        </div>
        {!value.id ? (
          <label className="field-label">
            사용자 이름
            <input
              required
              minLength={3}
              maxLength={64}
              pattern="[a-z0-9][a-z0-9._-]{2,63}"
              autoCapitalize="none"
              spellCheck={false}
              autoComplete="off"
              value={value.username}
              onChange={(event) =>
                onChange({ ...value, username: event.target.value.toLowerCase() })
              }
            />
          </label>
        ) : null}
        <label className="field-label">
          표시 이름
          <input
            required
            maxLength={120}
            value={value.displayName}
            onChange={(event) => onChange({ ...value, displayName: event.target.value })}
          />
        </label>
        <label className="field-label">
          역할
          <select
            value={value.role}
            onChange={(event) =>
              onChange({ ...value, role: event.target.value as UserForm['role'] })
            }
          >
            <option value="reviewer">일반사용자 (Reviewer)</option>
            <option value="administrator">시스템관리자 (Administrator)</option>
          </select>
        </label>
        {!value.id ? (
          <>
            <label className="field-label">
              초기 비밀번호
              <input
                required
                type="password"
                minLength={localPasswordMinimumLength}
                maxLength={localPasswordMaximumLength}
                autoComplete="new-password"
                value={value.password}
                onChange={(event) => onChange({ ...value, password: event.target.value })}
              />
              <small>8~128자로 입력합니다. 비밀번호 원문은 저장하지 않습니다.</small>
            </label>
            <fieldset className="tenant-checkboxes">
              <legend>초기 tenant 멤버십</legend>
              {tenants
                .filter((tenant) => tenant.enabled)
                .map((tenant) => (
                  <label className="checkbox-row" key={tenant.id}>
                    <input
                      type="checkbox"
                      checked={value.tenantIds.includes(tenant.id)}
                      onChange={(event) => toggleTenant(tenant.id, event.target.checked)}
                    />
                    {tenant.displayName}
                  </label>
                ))}
            </fieldset>
          </>
        ) : (
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
            />
            앱 접근 허용
          </label>
        )}
        <div className="dialog-actions">
          <button className="command-button" type="button" onClick={onClose}>
            취소
          </button>
          <button
            className="command-button primary"
            type="submit"
            disabled={busy || (!value.id && value.tenantIds.length === 0)}
          >
            <Save size={15} /> 저장
          </button>
        </div>
      </form>
    </div>
  );
}

function PasswordDialog({
  value,
  busy,
  onChange,
  onClose,
  onSubmit,
}: {
  value: PasswordForm;
  busy: boolean;
  onChange: (value: PasswordForm) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="admin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="password-dialog-title"
        onSubmit={onSubmit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-heading">
          <h2 id="password-dialog-title">비밀번호 재설정</h2>
          <button
            className="icon-button surface-icon"
            type="button"
            onClick={onClose}
            aria-label="닫기"
          >
            <X size={16} />
          </button>
        </div>
        <p className="dialog-description">
          {value.displayName} 계정의 활성 session은 재설정 후 종료됩니다.
        </p>
        <label className="field-label">
          새 비밀번호
          <input
            required
            type="password"
            minLength={localPasswordMinimumLength}
            maxLength={localPasswordMaximumLength}
            autoComplete="new-password"
            value={value.password}
            onChange={(event) => onChange({ ...value, password: event.target.value })}
            autoFocus
          />
          <small>8~128자로 입력합니다.</small>
        </label>
        <div className="dialog-actions">
          <button className="command-button" type="button" onClick={onClose}>
            취소
          </button>
          <button className="command-button primary" type="submit" disabled={busy}>
            <KeyRound size={15} /> 변경
          </button>
        </div>
      </form>
    </div>
  );
}

function RepositoryGrantDialog({
  value,
  repositories,
  busy,
  onChange,
  onClose,
  onSubmit,
}: {
  value: RepositoryGrantForm;
  repositories: AdminRepository[];
  busy: boolean;
  onChange: (value: RepositoryGrantForm) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const toggleRepository = (repositoryId: string, selected: boolean) => {
    onChange({
      ...value,
      repositoryIds: selected
        ? [...new Set([...value.repositoryIds, repositoryId])]
        : value.repositoryIds.filter((id) => id !== repositoryId),
    });
  };
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="admin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="repository-grant-dialog-title"
        onSubmit={onSubmit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-heading">
          <h2 id="repository-grant-dialog-title">Repository 접근 권한</h2>
          <button
            className="icon-button surface-icon"
            type="button"
            onClick={onClose}
            aria-label="닫기"
          >
            <X size={16} />
          </button>
        </div>
        <p className="dialog-description">
          {value.displayName}에게 허용할 repository를 선택합니다.
        </p>
        <fieldset className="tenant-checkboxes repository-checkboxes">
          <legend>Repository</legend>
          {repositories.map((repository) => (
            <label className="checkbox-row" key={repository.id}>
              <input
                type="checkbox"
                checked={value.repositoryIds.includes(repository.id)}
                onChange={(event) => toggleRepository(repository.id, event.target.checked)}
              />
              {repository.owner}/{repository.name}
            </label>
          ))}
          {repositories.length === 0 ? (
            <span className="dialog-description">등록된 repository가 없습니다.</span>
          ) : null}
        </fieldset>
        <div className="dialog-actions">
          <button className="command-button" type="button" onClick={onClose}>
            취소
          </button>
          <button className="command-button primary" type="submit" disabled={busy}>
            <Save size={15} /> 저장
          </button>
        </div>
      </form>
    </div>
  );
}

function PromptPanel({
  tenants,
  selectedTenant,
  selectedTenantId,
  data,
  draft,
  severityLevel,
  onSeverityChange,
  busyKey,
  onTenantChange,
  onDraftChange,
  onSave,
  onActivate,
  onReset,
}: {
  tenants: Tenant[];
  selectedTenant: Tenant | null;
  selectedTenantId: string;
  data: AnalysisPromptList | null;
  draft: string;
  severityLevel: ReviewSeverityLevel;
  onSeverityChange: (value: ReviewSeverityLevel) => void;
  busyKey: string | null;
  onTenantChange: (value: string) => void;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onActivate: (promptId: string) => void;
  onReset: () => void;
}) {
  const loading = !data || data.tenant.id !== selectedTenantId;
  const disabled = loading || busyKey !== null;
  return (
    <section className="admin-section prompt-section">
      <div className="admin-title-row">
        <div>
          <h1>분석 프롬프트</h1>
        </div>
        <label className="toolbar-select">
          <span>테넌트</span>
          <select value={selectedTenantId} onChange={(event) => onTenantChange(event.target.value)}>
            {tenants.map((tenant) => (
              <option value={tenant.id} key={tenant.id}>
                {tenant.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="prompt-status-bar">
        <span>
          <strong>{selectedTenant?.displayName ?? '-'}</strong>
          <code>{selectedTenant?.slug ?? '-'}</code>
        </span>
        <span className={data?.model.enabled ? 'model-on' : 'model-off'}>
          {data?.model.enabled ? 'Model enabled' : 'Model disabled'}
          {data?.model.name ? ` · ${data.model.name}` : ''}
        </span>
        <span>{data?.active ? `Active v${data.active.version}` : 'Built-in prompt'}</span>
      </div>
      <div className="prompt-editor" aria-busy={loading}>
        <SeverityLevelField value={severityLevel} disabled={disabled} onChange={onSeverityChange} />
        <div className="prompt-editor-heading">
          <label htmlFor="analysis-prompt-instructions">
            <strong>추가 분석 지침 · 선택 사항</strong>
          </label>
          <span>{draft.length.toLocaleString()} / 12,000</span>
        </div>
        <textarea
          id="analysis-prompt-instructions"
          disabled={disabled}
          value={draft}
          maxLength={12_000}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="이 테넌트의 코드 분석에 적용할 추가 지침"
        />
        <div className="prompt-actions">
          <button
            className="command-button"
            type="button"
            onClick={onReset}
            disabled={!data?.active || disabled}
          >
            <RotateCcw size={15} /> 기본값 복원
          </button>
          <button
            className="command-button primary"
            type="button"
            onClick={onSave}
            disabled={disabled}
          >
            <Save size={15} /> 새 버전 저장 및 활성화
          </button>
        </div>
      </div>
      <div className="prompt-history-heading">
        <strong>버전 기록</strong>
        <span>{data?.items.length ?? 0}</span>
      </div>
      <div className="prompt-history">
        {data?.items.map((prompt) => (
          <article className={`prompt-version${prompt.active ? ' active' : ''}`} key={prompt.id}>
            <div className="prompt-version-meta">
              <span>
                <strong>v{prompt.version}</strong>
                {prompt.active ? <b>Active</b> : null}
              </span>
              <time>{formatAdminDate(prompt.createdAt)}</time>
            </div>
            <p className="prompt-version-severity">
              <strong>{prompt.severityLevel}</strong> —{' '}
              {reviewSeverityLevels[prompt.severityLevel].description}
            </p>
            <pre>{prompt.instructions || '추가 지침 없음'}</pre>
            <div className="prompt-version-footer">
              <span>{prompt.createdBy.displayName}</span>
              <code>{prompt.contentHash.slice(0, 12)}</code>
              {!prompt.active ? (
                <button
                  className="command-button"
                  type="button"
                  disabled={disabled}
                  onClick={() => onActivate(prompt.id)}
                >
                  <Check size={14} /> 활성화
                </button>
              ) : null}
            </div>
          </article>
        ))}
        {data && data.items.length === 0 ? (
          <div className="admin-empty">저장된 프롬프트 버전이 없습니다.</div>
        ) : null}
      </div>
    </section>
  );
}

function ProviderPanel({
  accounts,
  data,
  draft,
  busyKey,
  onDraftChange,
  onTest,
  onSave,
  onActivate,
  onReset,
}: {
  accounts: AdminChatAccount[];
  data: AnalysisProviderSettings | null;
  draft: ProviderDraft;
  busyKey: string | null;
  onDraftChange: (value: ProviderDraft) => void;
  onTest: () => void;
  onSave: () => void;
  onActivate: (providerId: string) => void;
  onReset: () => void;
}) {
  const editable = data?.editable ?? false;
  const availableAccounts = accounts.filter(
    (account) =>
      account.enabled &&
      account.assignments.some(
        (assignment) =>
          assignment.enabled &&
          (assignment.scopeType === 'tenant' ||
            (assignment.scopeType === 'all' && assignment.scopeId === '*')),
      ),
  );
  const account = availableAccounts.find((item) => item.id === draft.chatAccountId);
  const model = account?.models.find((item) => item.id === draft.modelName && item.enabled);
  const accountComplete = Boolean(model?.allowedEfforts.includes(draft.reasoningEffort));
  const activeCredentialReusable = Boolean(
    data?.active?.mode === 'openai-compatible' && data.active.apiKeyConfigured,
  );
  const openAiComplete = Boolean(
    draft.endpoint.trim() &&
    draft.modelName.trim() &&
    (draft.apiKey.trim() || activeCredentialReusable),
  );
  const canSave =
    editable &&
    busyKey === null &&
    (draft.mode === 'disabled' ||
      (draft.mode === 'chatgpt-account' ? accountComplete : openAiComplete)) &&
    draft.timeoutMs >= 1_000 &&
    draft.timeoutMs <= 600_000;

  return (
    <section className="admin-section provider-section">
      <div className="admin-title-row">
        <div>
          <h1>분석 Provider</h1>
        </div>
      </div>

      <div className="provider-status-bar">
        <span>
          <strong>
            {data?.effective.source === 'administration' ? 'Admin 설정' : 'Deployment 설정'}
          </strong>
          <code>
            {data?.effective.version ? `v${data.effective.version}` : 'environment fallback'}
          </code>
        </span>
        <span className={data?.effective.mode === 'disabled' ? 'model-off' : 'model-on'}>
          {data?.effective.mode === 'disabled' ? 'Model disabled' : data?.effective.modelName}
        </span>
        <span>
          {data?.effective.mode === 'chatgpt-account'
            ? `${accounts.find((item) => item.id === data.effective.chatAccountId)?.displayName ?? '등록된 account'} · ${data.effective.reasoningEffort}`
            : data?.effective.apiKeyConfigured
              ? 'Credential 설정됨'
              : '별도 credential 없음'}
        </span>
      </div>

      <div className="provider-editor">
        <p className="provider-help">
          Review Chat과 별도로 새 분석에 사용할 account·model·effort를 선택합니다. Worker는
          repository의 tenant 또는 all 권한이 부여된 account만 사용합니다. 저장한 설정은 새 분석부터
          적용됩니다. 기존 report를 다시 분석하려면 Workspace에서 새로고침하세요.
        </p>
        <div className="provider-mode-control" role="group" aria-label="Provider mode">
          <button
            type="button"
            aria-pressed={draft.mode === 'chatgpt-account'}
            className={draft.mode === 'chatgpt-account' ? 'active' : ''}
            disabled={!editable || busyKey !== null}
            onClick={() =>
              onDraftChange({
                ...draft,
                mode: 'chatgpt-account',
                modelName: '',
                reasoningEffort: '',
                chatAccountId: '',
              })
            }
          >
            등록된 ChatGPT account
          </button>
          <button
            type="button"
            aria-pressed={draft.mode === 'disabled'}
            className={draft.mode === 'disabled' ? 'active' : ''}
            disabled={!editable || busyKey !== null}
            onClick={() => onDraftChange({ ...draft, mode: 'disabled' })}
          >
            비활성
          </button>
          <button
            type="button"
            aria-pressed={draft.mode === 'openai-compatible'}
            className={draft.mode === 'openai-compatible' ? 'active' : ''}
            disabled={!editable || busyKey !== null}
            onClick={() => onDraftChange({ ...draft, mode: 'openai-compatible' })}
          >
            OpenAI 호환
          </button>
        </div>

        <div className="provider-form-grid">
          {draft.mode === 'chatgpt-account' ? (
            <>
              <label className="field-label">
                ChatGPT account
                <select
                  value={draft.chatAccountId}
                  disabled={!editable || busyKey !== null}
                  onChange={(event) => {
                    const selected = availableAccounts.find(
                      (item) => item.id === event.target.value,
                    );
                    const firstModel = selected?.models.find((item) => item.enabled);
                    onDraftChange({
                      ...draft,
                      chatAccountId: event.target.value,
                      modelName: firstModel?.id ?? '',
                      reasoningEffort: firstModel?.defaultEffort ?? '',
                    });
                  }}
                >
                  <option value="">분석에 사용할 account 선택</option>
                  {availableAccounts.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                Model
                <select
                  value={draft.modelName}
                  disabled={!editable || !account || busyKey !== null}
                  onChange={(event) =>
                    onDraftChange({
                      ...draft,
                      modelName: event.target.value,
                      reasoningEffort:
                        account?.models.find((item) => item.id === event.target.value)
                          ?.defaultEffort ?? '',
                    })
                  }
                >
                  <option value="">Model 선택</option>
                  {account?.models
                    .filter((item) => item.enabled)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.displayName} · {item.id}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field-label">
                Effort
                <select
                  value={draft.reasoningEffort}
                  disabled={!editable || !model || busyKey !== null}
                  onChange={(event) =>
                    onDraftChange({ ...draft, reasoningEffort: event.target.value })
                  }
                >
                  <option value="">Effort 선택</option>
                  {model?.allowedEfforts.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <>
              <label className="field-label provider-endpoint-field">
                Endpoint
                <input
                  type="url"
                  value={draft.endpoint}
                  disabled={!editable || draft.mode === 'disabled' || busyKey !== null}
                  placeholder="https://models.example.internal/v1/"
                  onChange={(event) => onDraftChange({ ...draft, endpoint: event.target.value })}
                />
              </label>
              <label className="field-label">
                Model
                <input
                  value={draft.modelName}
                  maxLength={200}
                  disabled={!editable || draft.mode === 'disabled' || busyKey !== null}
                  placeholder="정확한 model ID"
                  onChange={(event) => onDraftChange({ ...draft, modelName: event.target.value })}
                />
              </label>
            </>
          )}
          <label className="field-label">
            Timeout (ms)
            <input
              type="number"
              min={1_000}
              max={600_000}
              step={1_000}
              value={draft.timeoutMs}
              disabled={!editable || busyKey !== null}
              onChange={(event) =>
                onDraftChange({ ...draft, timeoutMs: Number(event.target.value) })
              }
            />
          </label>
          {draft.mode !== 'chatgpt-account' ? (
            <label className="field-label provider-key-field">
              API key
              <input
                type="password"
                value={draft.apiKey}
                maxLength={16_384}
                autoComplete="new-password"
                disabled={!editable || draft.mode === 'disabled' || busyKey !== null}
                placeholder={activeCredentialReusable ? '설정됨 · 비워 두면 유지' : 'API key'}
                onChange={(event) => onDraftChange({ ...draft, apiKey: event.target.value })}
              />
            </label>
          ) : null}
        </div>

        {draft.mode !== 'chatgpt-account' ? (
          <div className="provider-origin-row">
            <strong>허용 origin</strong>
            {data?.allowedOrigins.length ? (
              data.allowedOrigins.map((origin) => <code key={origin}>{origin}</code>)
            ) : (
              <span>설정되지 않음</span>
            )}
          </div>
        ) : availableAccounts.length === 0 ? (
          <p role="status">
            분석용 account가 없습니다. ChatGPT accounts에서 account를 등록하고 all 또는 tenant
            권한을 부여하세요.
          </p>
        ) : null}

        <div className="provider-actions">
          <button
            className="command-button"
            type="button"
            disabled={!data?.active || busyKey !== null}
            onClick={onReset}
          >
            <RotateCcw size={15} /> Deployment 설정
          </button>
          <span />
          <button
            className="command-button"
            type="button"
            disabled={!canSave || draft.mode === 'disabled'}
            onClick={onTest}
          >
            <Play size={15} /> 연결 테스트
          </button>
          <button
            className="command-button primary"
            type="button"
            disabled={!canSave}
            onClick={onSave}
          >
            <Save size={15} /> 새 버전 저장 및 활성화
          </button>
        </div>
      </div>

      {!editable && data ? (
        <div className="provider-disabled-state">
          Provider 관리자 설정은 deployment configuration에서 비활성 상태입니다.
        </div>
      ) : null}

      <div className="prompt-history-heading">
        <strong>버전 기록</strong>
        <span>{data?.items.length ?? 0}</span>
      </div>
      <div className="provider-history">
        {data?.items.map((provider) => (
          <article
            className={`provider-version${provider.active ? ' active' : ''}`}
            key={provider.id}
          >
            <div className="provider-version-main">
              <span>
                <strong>v{provider.version}</strong>
                {provider.active ? <b>Active</b> : null}
              </span>
              <span>{provider.mode}</span>
              <code>{provider.modelName ?? 'disabled'}</code>
              {provider.mode === 'chatgpt-account' ? (
                <span>
                  {accounts.find((item) => item.id === provider.chatAccountId)?.displayName ??
                    '등록된 account'}{' '}
                  · {provider.reasoningEffort}
                </span>
              ) : null}
              <code>{provider.configurationHash.slice(0, 12)}</code>
            </div>
            <div className="provider-version-action">
              <time>{formatAdminDate(provider.createdAt)}</time>
              {!provider.active ? (
                <button
                  className="command-button"
                  type="button"
                  disabled={!editable || busyKey !== null}
                  onClick={() => onActivate(provider.id)}
                >
                  <Check size={14} /> 활성화
                </button>
              ) : null}
            </div>
          </article>
        ))}
        {data && data.items.length === 0 ? (
          <div className="admin-empty">저장된 Provider 버전이 없습니다.</div>
        ) : null}
      </div>
    </section>
  );
}

function ChatAccountPanel({
  accounts,
  tenants,
  busyKey,
  onCreate,
  onToggle,
}: {
  accounts: AdminChatAccount[];
  tenants: Tenant[];
  busyKey: string | null;
  onCreate: (values: {
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
  }) => Promise<unknown>;
  onToggle: (accountId: string, enabled: boolean) => Promise<unknown>;
}) {
  const [displayName, setDisplayName] = useState('');
  const [authJson, setAuthJson] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [modelName, setModelName] = useState('');
  const [efforts, setEfforts] = useState('medium,high');
  const [defaultEffort, setDefaultEffort] = useState('medium');
  const [tenantId, setTenantId] = useState(tenants[0]?.id ?? '');
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof discoverChatAccountModels>>>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogMessage, setCatalogMessage] = useState('');

  const discoverModels = async () => {
    setCatalogLoading(true);
    setCatalogMessage('');
    setCatalog([]);
    try {
      const models = await discoverChatAccountModels(authJson);
      setCatalog(models);
      setCatalogMessage(
        models.length
          ? `${models.length}개 모델을 조회했습니다. 모델을 선택하세요.`
          : '사용 가능한 모델이 없습니다. Model ID를 직접 입력할 수 있습니다.',
      );
    } catch (error) {
      setCatalogMessage(
        error instanceof Error ? error.message : '모델 목록을 조회하지 못했습니다.',
      );
    } finally {
      setCatalogLoading(false);
    }
  };

  useEffect(() => {
    if (!tenantId && tenants[0]) setTenantId(tenants[0].id);
  }, [tenantId, tenants]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const allowedEfforts = [
      ...new Set(
        efforts
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    await onCreate({
      displayName,
      ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}),
      authJson,
      models: [
        {
          id: modelName,
          displayName: catalog.find((model) => model.id === modelName)?.displayName ?? modelName,
          allowedEfforts,
          defaultEffort,
        },
      ],
      assignments: tenantId
        ? [{ scopeType: 'tenant', scopeId: tenantId }]
        : [{ scopeType: 'all', scopeId: '*' }],
    });
    setAuthJson('');
    setCatalog([]);
    setCatalogMessage('');
  };

  return (
    <section className="admin-section">
      <div className="admin-title-row">
        <div>
          <p className="eyebrow">Chat credential registry</p>
          <h1>ChatGPT accounts</h1>
        </div>
      </div>
      <p className="admin-section-description">
        Codex의 ChatGPT login으로 생성한 auth.json을 등록합니다. Credential 원문은 저장 후 다시
        표시하지 않으며 사용자는 할당받은 account에서 model과 effort를 선택합니다.
      </p>
      <form className="registry-form" onSubmit={(event) => void submit(event)}>
        <label className="field-label">
          표시 이름
          <input
            required
            maxLength={120}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <label className="field-label">
          Tenant 할당
          <select value={tenantId} onChange={(event) => setTenantId(event.target.value)}>
            <option value="">모든 사용자</option>
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.displayName}
              </option>
            ))}
          </select>
        </label>
        <div className="field-label">
          <label htmlFor="chat-account-model-id">Model ID</label>
          {catalog.length > 0 ? (
            <select
              aria-label="조회된 모델 선택"
              value={catalog.some((model) => model.id === modelName) ? modelName : ''}
              onChange={(event) => {
                const model = catalog.find((item) => item.id === event.target.value);
                if (!model) return;
                setModelName(model.id);
                setEfforts(model.allowedEfforts.join(','));
                setDefaultEffort(model.defaultEffort);
              }}
            >
              <option value="">모델을 선택하세요</option>
              {catalog.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName} · {model.id}
                </option>
              ))}
            </select>
          ) : null}
          <input
            id="chat-account-model-id"
            required
            maxLength={200}
            value={modelName}
            placeholder="Codex에서 사용할 model ID"
            onChange={(event) => setModelName(event.target.value)}
          />
        </div>
        <label className="field-label">
          허용 effort
          <input required value={efforts} onChange={(event) => setEfforts(event.target.value)} />
        </label>
        <label className="field-label">
          기본 effort
          <select value={defaultEffort} onChange={(event) => setDefaultEffort(event.target.value)}>
            {[
              ...new Set(
                efforts
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              ),
            ].map((effort) => (
              <option key={effort}>{effort}</option>
            ))}
          </select>
        </label>
        <label className="field-label">
          Codex endpoint (선택)
          <input
            type="url"
            value={endpoint}
            placeholder="기본 ChatGPT Codex endpoint 사용"
            onChange={(event) => setEndpoint(event.target.value)}
          />
        </label>
        <label className="field-label registry-secret-field">
          auth.json
          <input
            type="password"
            required
            autoComplete="new-password"
            value={authJson}
            disabled={catalogLoading}
            onChange={(event) => {
              setAuthJson(event.target.value);
              setCatalog([]);
              setCatalogMessage('');
            }}
          />
        </label>
        <div className="field-label">
          <button
            className="command-button"
            type="button"
            disabled={!authJson.trim() || catalogLoading || busyKey !== null}
            onClick={() => void discoverModels()}
          >
            <Search size={15} /> {catalogLoading ? '모델 조회 중…' : '모델 목록 조회'}
          </button>
          <small>auth.json을 입력한 뒤 조회하세요. 모델을 선택하면 지원 effort도 채워집니다.</small>
          {catalogMessage ? <small role="status">{catalogMessage}</small> : null}
        </div>
        <button
          className="command-button primary"
          type="submit"
          disabled={busyKey !== null || catalogLoading}
        >
          <Plus size={15} /> Account 등록
        </button>
      </form>
      <div className="registry-list">
        {accounts.map((account) => (
          <article className="registry-card" key={account.id}>
            <div>
              <strong>{account.displayName}</strong>
              <span>
                {account.health} · credential v{account.credentialVersion}
              </span>
            </div>
            <code>…{account.credentialFingerprint}</code>
            <span>
              {account.models
                .map((model) => `${model.displayName} (${model.allowedEfforts.join('/')})`)
                .join(', ')}
            </span>
            <div className="registry-card-actions">
              <span>
                {account.assignments
                  .map((assignment) => `${assignment.scopeType}:${assignment.scopeId}`)
                  .join(', ')}
              </span>
              <button
                className="command-button"
                type="button"
                disabled={busyKey !== null}
                onClick={() => void onToggle(account.id, !account.enabled)}
              >
                {account.enabled ? '비활성화' : '활성화'}
              </button>
            </div>
          </article>
        ))}
        {accounts.length === 0 ? (
          <div className="admin-empty">등록된 ChatGPT account가 없습니다.</div>
        ) : null}
      </div>
    </section>
  );
}

function GitHubConnectionPanel({
  connections,
  repositories,
  tenants,
  users,
  busyKey,
  onCreate,
  onUpdate,
  onTest,
  onRegisterRepository,
  onRepositoryPollingChange,
  onRepositoryPublishingChange,
  onDeleteRepository,
  onPollNow,
}: {
  connections: GitHubConnection[];
  repositories: AdminRepository[];
  tenants: Tenant[];
  users: AdminUser[];
  busyKey: string | null;
  onCreate: (values: {
    name: string;
    apiBaseUrl: string;
    webBaseUrl: string;
    credentialLabel: string;
    accessToken: string;
    expiresAt?: string;
  }) => Promise<unknown>;
  onUpdate: (connectionId: string, values: GitHubConnectionUpdateValues) => Promise<string | null>;
  onTest: (connectionId: string) => Promise<unknown>;
  onRegisterRepository: (
    connectionId: string,
    values: {
      tenantId: string;
      repositoryUrl: string;
      pollIntervalSeconds: number;
      reviewPublishingEnabled: boolean;
      grantSubjects: string[];
    },
  ) => Promise<unknown>;
  onRepositoryPollingChange: (repositoryId: string, enabled: boolean) => Promise<unknown>;
  onRepositoryPublishingChange: (repositoryId: string, enabled: boolean) => Promise<unknown>;
  onDeleteRepository: (repository: AdminRepository) => Promise<string | null>;
  onPollNow: (repositoryId: string) => Promise<unknown>;
}) {
  const [name, setName] = useState('');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [webBaseUrl, setWebBaseUrl] = useState('');
  const [credentialLabel, setCredentialLabel] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [tenantId, setTenantId] = useState(tenants[0]?.id ?? '');
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [pollIntervalSeconds, setPollIntervalSeconds] = useState(120);
  const [reviewPublishingEnabled, setReviewPublishingEnabled] = useState(true);
  const [grantSubject, setGrantSubject] = useState('');
  const [editingConnection, setEditingConnection] = useState<GitHubConnection | null>(null);
  const [deletingRepository, setDeletingRepository] = useState<AdminRepository | null>(null);
  const selectedConnection = connections.find((connection) => connection.id === connectionId);
  let repositoryPreview: ReturnType<typeof parseGitHubRepositoryUrl> | null = null;
  let repositoryUrlError = '';
  if (repositoryUrl.trim()) {
    try {
      repositoryPreview = parseGitHubRepositoryUrl(repositoryUrl, selectedConnection?.webBaseUrl);
    } catch (error) {
      repositoryUrlError = errorMessage(error);
    }
  }

  useEffect(() => {
    if (!connectionId && connections[0]) setConnectionId(connections[0].id);
    if (!tenantId && tenants[0]) setTenantId(tenants[0].id);
  }, [connectionId, connections, tenantId, tenants]);

  const submitConnection = async (event: FormEvent) => {
    event.preventDefault();
    await onCreate({
      name,
      apiBaseUrl,
      webBaseUrl,
      credentialLabel,
      accessToken,
      ...(expiresAt ? { expiresAt: new Date(`${expiresAt}T23:59:59`).toISOString() } : {}),
    });
    setAccessToken('');
  };
  const submitRepository = async (event: FormEvent) => {
    event.preventDefault();
    if (!repositoryPreview || !selectedConnection) return;
    await onRegisterRepository(connectionId, {
      tenantId,
      repositoryUrl: repositoryPreview.url,
      pollIntervalSeconds,
      reviewPublishingEnabled,
      grantSubjects: grantSubject ? [grantSubject] : [],
    });
  };

  return (
    <section className="admin-section">
      <div className="admin-title-row">
        <div>
          <p className="eyebrow">Outbound polling</p>
          <h1>GHES 연결 및 repository</h1>
        </div>
      </div>
      <p className="admin-section-description">
        GHES가 이 서비스로 inbound 요청을 보내지 않습니다. Server가 access token으로 GHES API를
        polling하고 Worker가 같은 token으로 필요한 commit을 clone하며 분석 결과를 PR timeline에
        게시합니다. Fine-grained PAT은 Metadata/Contents Read-only와 Pull requests Read and write가
        필요합니다. <a href="/guide#ghes-credential">Credential 발급·입력 방법</a>
      </p>
      <form className="registry-form" onSubmit={(event) => void submitConnection(event)}>
        <label className="field-label">
          연결 이름
          <input
            required
            placeholder="GitHub.com · org-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field-label">
          API base URL
          <input
            required
            type="url"
            placeholder="https://api.github.com"
            value={apiBaseUrl}
            onChange={(event) => setApiBaseUrl(event.target.value)}
          />
          <small>GitHub.com: https://api.github.com · 사내 GHES: https://사내-host/api/v3</small>
        </label>
        <label className="field-label">
          Web base URL
          <input
            required
            type="url"
            placeholder="https://github.com"
            value={webBaseUrl}
            onChange={(event) => setWebBaseUrl(event.target.value)}
          />
          <small>
            사이트 주소만 입력합니다. /org-name이나 /owner/repository는 붙이지 않습니다.
          </small>
        </label>
        <label className="field-label">
          Credential label
          <input
            required
            placeholder="ghes-review-publisher"
            value={credentialLabel}
            onChange={(event) => setCredentialLabel(event.target.value)}
          />
          <small>
            이 서비스 안에서 token을 구분하는 이름입니다. 등록 후에는 아래 연결 수정에서 바꿀 수
            있습니다.
          </small>
        </label>
        <label className="field-label registry-secret-field">
          Access token
          <input
            required
            type="password"
            autoComplete="new-password"
            placeholder="발급받은 token 원문"
            value={accessToken}
            onChange={(event) => setAccessToken(event.target.value)}
          />
          <small>
            <code>Bearer</code>나 따옴표 없이 token 문자열만 입력합니다. 대상 repository만 선택하고
            Pull requests를 Read and write로 발급하십시오.
          </small>
        </label>
        <label className="field-label">
          Token 만료일
          <input
            type="date"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
          />
          <small>GHES에서 지정한 만료일과 같게 입력합니다.</small>
        </label>
        <button className="command-button primary" type="submit" disabled={busyKey !== null}>
          <Plus size={15} /> 연결 등록
        </button>
      </form>
      <div className="registry-list">
        {connections.map((connection) => (
          <article className="registry-card" key={connection.id}>
            <div>
              <strong>{connection.name}</strong>
              <span>
                {connection.health} · token v{connection.credentialVersion}
              </span>
              <span>요구 권한 · Metadata/Contents Read · Pull requests Read/Write</span>
            </div>
            <code>{connection.apiBaseUrl}</code>
            <code>…{connection.tokenFingerprint}</code>
            <div className="registry-card-actions">
              <button
                className="command-button"
                type="button"
                disabled={busyKey !== null}
                onClick={() => setEditingConnection(connection)}
              >
                <Pencil size={14} /> 연결 수정
              </button>
              <button
                className="command-button"
                type="button"
                disabled={busyKey !== null}
                onClick={() => void onTest(connection.id)}
              >
                <Play size={14} /> 연결 테스트
              </button>
            </div>
          </article>
        ))}
      </div>
      <div className="prompt-history-heading">
        <strong id="review-repository-heading" tabIndex={-1}>
          Review repository 등록
        </strong>
      </div>
      <form className="registry-form" onSubmit={(event) => void submitRepository(event)}>
        <label className="field-label">
          GHES 연결
          <select
            required
            value={connectionId}
            onChange={(event) => setConnectionId(event.target.value)}
          >
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name} / {connection.credentialLabel} · {connection.webBaseUrl}
              </option>
            ))}
          </select>
          <small>
            {selectedConnection?.health === 'ready'
              ? '연결 테스트 완료. Repository별 token 권한은 등록 시 확인합니다.'
              : '연결 목록에서 연결 테스트를 먼저 완료하십시오.'}
          </small>
        </label>
        <label className="field-label">
          Tenant
          <select required value={tenantId} onChange={(event) => setTenantId(event.target.value)}>
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label repository-url-field">
          Repository URL
          <input
            required
            type="url"
            placeholder={githubRepositoryExample}
            value={repositoryUrl}
            aria-describedby="repository-url-help"
            aria-invalid={Boolean(repositoryUrlError)}
            onChange={(event) => setRepositoryUrl(event.target.value)}
          />
          <small id="repository-url-help" aria-live="polite">
            {repositoryUrlError ||
              (repositoryPreview
                ? `Owner: ${repositoryPreview.owner} · Repository: ${repositoryPreview.name}`
                : 'Repository 전체 주소를 붙여 넣으십시오. Owner와 Repository는 자동으로 채워집니다. HTTPS clone URL(.git)도 사용할 수 있습니다.')}
          </small>
        </label>
        <label className="field-label">
          Polling interval (초)
          <input
            type="number"
            min={30}
            max={86400}
            value={pollIntervalSeconds}
            onChange={(event) => setPollIntervalSeconds(Number(event.target.value))}
          />
        </label>
        <label className="field-label">
          사용자 권한
          <select value={grantSubject} onChange={(event) => setGrantSubject(event.target.value)}>
            <option value="">관리자만</option>
            {users.map((item) => (
              <option key={item.id} value={item.subject}>
                {item.displayName} ({item.subject})
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={reviewPublishingEnabled}
            onChange={(event) => setReviewPublishingEnabled(event.target.checked)}
          />
          분석 완료 후 PR timeline에 review 결과 게시
        </label>
        <button
          className="command-button primary"
          type="submit"
          disabled={!connectionId || !tenantId || !repositoryPreview || busyKey !== null}
        >
          <Plus size={15} /> Repository 등록
        </button>
      </form>
      <div className="registry-list">
        {repositories.map((repository) => (
          <article className="registry-card review-repository-card" key={repository.id}>
            <div>
              <strong>
                {repository.owner}/{repository.name}
              </strong>
              <span>
                {repository.tenantName} · {repository.credentialLabel ?? 'GitHub App/fixture'}
              </span>
            </div>
            <span>
              {repository.pollIntervalSeconds}초 · {repository.pollOutcome ?? '대기'}
            </span>
            <span>
              {repository.lastPolledAt
                ? `마지막 ${formatAdminDate(repository.lastPolledAt)}`
                : 'polling 이력 없음'}
            </span>
            <span>
              PR 게시 ·{' '}
              {repository.reviewPublishingEnabled
                ? publicationStateLabel(repository.reviewPublicationState)
                : '중지됨'}
              {repository.reviewPublicationError ? ` (${repository.reviewPublicationError})` : ''}
            </span>
            {repository.reviewCommentUrl ? (
              <a href={repository.reviewCommentUrl} target="_blank" rel="noreferrer">
                GHES 댓글 열기
              </a>
            ) : null}
            <div className="registry-card-actions">
              <button
                className="command-button"
                type="button"
                disabled={!repository.pollingEnabled || busyKey !== null}
                onClick={() => void onPollNow(repository.id)}
              >
                <RotateCcw size={14} /> 지금 Poll
              </button>
              <button
                className="command-button"
                type="button"
                disabled={busyKey !== null}
                onClick={() =>
                  void onRepositoryPollingChange(repository.id, !repository.pollingEnabled)
                }
              >
                {repository.pollingEnabled ? 'Polling 중지' : 'Polling 시작'}
              </button>
              <button
                className="command-button"
                type="button"
                disabled={busyKey !== null}
                onClick={() =>
                  void onRepositoryPublishingChange(
                    repository.id,
                    !repository.reviewPublishingEnabled,
                  )
                }
              >
                {repository.reviewPublishingEnabled ? 'PR 게시 중지' : 'PR 게시 시작'}
              </button>
              <button
                className="command-button danger"
                type="button"
                disabled={busyKey !== null}
                aria-label={`${repository.owner}/${repository.name} 등록 삭제`}
                onClick={() => setDeletingRepository(repository)}
              >
                <Trash2 size={14} /> 등록 삭제
              </button>
            </div>
          </article>
        ))}
        {repositories.length === 0 ? (
          <p className="admin-empty">등록된 review repository가 없습니다.</p>
        ) : null}
      </div>
      {deletingRepository ? (
        <RepositoryDeleteDialog
          repository={deletingRepository}
          busy={busyKey !== null}
          onClose={() => setDeletingRepository(null)}
          onSubmit={() => onDeleteRepository(deletingRepository)}
        />
      ) : null}
      {editingConnection ? (
        <GitHubConnectionDialog
          connection={editingConnection}
          sharedCredentialCount={
            connections.filter((item) => item.instanceId === editingConnection.instanceId).length
          }
          busy={busyKey !== null}
          onClose={() => setEditingConnection(null)}
          onSubmit={(values) => onUpdate(editingConnection.id, values)}
        />
      ) : null}
    </section>
  );
}

function RepositoryDeleteDialog({
  repository,
  busy,
  onClose,
  onSubmit,
}: {
  repository: AdminRepository;
  busy: boolean;
  onClose: () => void;
  onSubmit: () => Promise<string | null>;
}) {
  const fullName = `${repository.owner}/${repository.name}`;
  const [confirmation, setConfirmation] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    cancelRef.current?.focus();
    return () => {
      dialog?.close();
      if (opener?.isConnected) opener.focus();
      else document.getElementById('review-repository-heading')?.focus();
    };
  }, []);

  useEffect(() => {
    if (submitError) errorRef.current?.focus();
  }, [submitError]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || submitting.current || confirmation.trim() !== fullName) return;
    submitting.current = true;
    setSubmitError(null);
    try {
      const error = await onSubmit();
      if (error) setSubmitError(error);
      else onClose();
    } catch (error) {
      setSubmitError(errorMessage(error));
    } finally {
      submitting.current = false;
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="admin-dialog repository-delete-dialog"
      aria-labelledby="repository-delete-title"
      aria-describedby="repository-delete-description"
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="dialog-heading">
          <h2 id="repository-delete-title">Review 등록 삭제</h2>
          <button
            className="icon-button"
            type="button"
            aria-label="삭제 취소"
            disabled={busy}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <div id="repository-delete-description" className="repository-delete-description">
          <p>
            <strong>{fullName}</strong>을 review 목록에서 제거하고 사용자 접근 권한·polling·대기
            작업을 정리합니다.
          </p>
          <p>
            GitHub 원본 repository, GHES connection과 token, 이미 게시한 PR 댓글은 삭제하지
            않습니다.
          </p>
          <p>
            기존 분석·Chat 기록은 retention 정책에 따라 보관합니다. 같은 repository를 다시 등록하면
            남아 있는 기록을 사용할 수 있으며 사용자 권한은 다시 지정해야 합니다.
          </p>
          <p>
            실행 중인 분석이나 PR 게시가 있으면 삭제하지 않습니다. Polling을 중지하고 작업 완료 후
            다시 시도해 주세요.
          </p>
        </div>
        {submitError ? (
          <div
            className="admin-message error dialog-message"
            role="alert"
            tabIndex={-1}
            ref={errorRef}
          >
            {submitError}
          </div>
        ) : null}
        <label className="field-label">
          확인을 위해 {fullName} 입력
          <input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
            disabled={busy}
          />
        </label>
        <div className="dialog-actions">
          <button
            ref={cancelRef}
            className="command-button"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            취소
          </button>
          <button
            className="command-button danger"
            type="submit"
            disabled={busy || confirmation.trim() !== fullName}
          >
            <Trash2 size={14} /> {busy ? '삭제 중…' : '등록 삭제'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function GitHubConnectionDialog({
  connection,
  sharedCredentialCount,
  busy,
  onClose,
  onSubmit,
}: {
  connection: GitHubConnection;
  sharedCredentialCount: number;
  busy: boolean;
  onClose: () => void;
  onSubmit: (values: GitHubConnectionUpdateValues) => Promise<string | null>;
}) {
  const [name, setName] = useState(connection.name);
  const [apiBaseUrl, setApiBaseUrl] = useState(connection.apiBaseUrl);
  const [webBaseUrl, setWebBaseUrl] = useState(connection.webBaseUrl);
  const [credentialLabel, setCredentialLabel] = useState(connection.credentialLabel);
  const [accessToken, setAccessToken] = useState('');
  const [expiresAt, setExpiresAt] = useState(localDateInputValue(connection.expiresAt));
  const [submitError, setSubmitError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const initialFocus =
      dialog?.querySelector<HTMLElement>('[autofocus]:not(:disabled)') ??
      dialog?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)');
    initialFocus?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      const currentDialog = dialogRef.current;
      if (!currentDialog) return;
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [
        ...currentDialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled)',
        ),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (
        event.shiftKey &&
        (document.activeElement === first || !currentDialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      opener?.focus();
    };
  }, []);

  useEffect(() => {
    if (submitError) errorRef.current?.focus();
  }, [submitError]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitError(null);
    const error = await onSubmit({
      name,
      apiBaseUrl,
      webBaseUrl,
      credentialLabel,
      ...(accessToken.trim() ? { accessToken: accessToken.trim() } : {}),
      expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
    });
    if (error) setSubmitError(error);
    else onClose();
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (!busy) onClose();
      }}
    >
      <form
        ref={dialogRef}
        className="admin-dialog github-connection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="github-connection-dialog-title"
        onSubmit={(event) => void submit(event)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-heading">
          <h2 id="github-connection-dialog-title">GHES 연결 수정</h2>
          <button
            className="icon-button surface-icon"
            type="button"
            onClick={onClose}
            aria-label="닫기"
            disabled={busy}
          >
            <X size={16} />
          </button>
        </div>
        <p className="dialog-description">
          저장 후 연결 상태가 미검증으로 바뀝니다. 저장된 access token은 표시하지 않습니다.
        </p>
        {sharedCredentialCount > 1 ? (
          <p className="connection-shared-note">
            이 GHES instance를 credential {sharedCredentialCount}개가 함께 사용하므로 연결 이름과
            API/Web URL은 잠겨 있습니다. Credential label, token과 만료일은 수정할 수 있습니다.
          </p>
        ) : null}
        {submitError ? (
          <div
            ref={errorRef}
            className="admin-message error dialog-message"
            role="alert"
            tabIndex={-1}
          >
            <X size={15} />
            <span>{submitError}</span>
          </div>
        ) : null}
        <div className="github-connection-dialog-grid">
          <label className="field-label">
            연결 이름
            <input
              required
              autoFocus
              disabled={sharedCredentialCount > 1}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="field-label">
            Credential label
            <input
              required
              value={credentialLabel}
              onChange={(event) => setCredentialLabel(event.target.value)}
            />
          </label>
          <label className="field-label">
            API base URL
            <input
              required
              type="url"
              disabled={sharedCredentialCount > 1}
              placeholder="https://api.github.com"
              value={apiBaseUrl}
              onChange={(event) => setApiBaseUrl(event.target.value)}
            />
            <small>GitHub.com: https://api.github.com · 사내 GHES: https://사내-host/api/v3</small>
          </label>
          <label className="field-label">
            Web base URL
            <input
              required
              type="url"
              disabled={sharedCredentialCount > 1}
              placeholder="https://github.com"
              value={webBaseUrl}
              onChange={(event) => setWebBaseUrl(event.target.value)}
            />
            <small>사이트 주소만 입력합니다. Organization이나 repository 경로는 제외합니다.</small>
          </label>
          <label className="field-label registry-secret-field">
            새 access token (선택)
            <input
              type="password"
              autoComplete="new-password"
              placeholder={`현재 token · …${connection.tokenFingerprint}`}
              value={accessToken}
              onChange={(event) => setAccessToken(event.target.value)}
            />
            <small>
              비워 두면 현재 token과 credential version을 유지합니다. API/Web origin 변경 시에는 새
              token이 필요합니다. 새 token도 Pull requests Read and write 권한이 있어야 합니다.
            </small>
          </label>
          <label className="field-label">
            Token 만료일
            <input
              type="date"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
            <small>비워 두면 만료일을 제거합니다.</small>
          </label>
        </div>
        <div className="dialog-actions">
          <button className="command-button" type="button" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button className="command-button primary" type="submit" disabled={busy}>
            <Save size={15} /> {busy ? '저장 중' : '연결 설정 저장'}
          </button>
        </div>
      </form>
    </div>
  );
}

function localDateInputValue(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function readTab(): AdminTab {
  const value = new URLSearchParams(window.location.search).get('tab');
  return value === 'users' ||
    value === 'provider' ||
    value === 'prompt' ||
    value === 'skills' ||
    value === 'chat' ||
    value === 'github'
    ? value
    : 'tenants';
}

function providerDraftFrom(settings: AnalysisProviderSettings): ProviderDraft {
  return {
    chatAccountId: settings.effective.chatAccountId ?? '',
    reasoningEffort: settings.effective.reasoningEffort ?? '',
    mode: settings.effective.mode,
    endpoint: settings.effective.endpoint ?? '',
    modelName: settings.effective.modelName ?? '',
    timeoutMs: settings.effective.timeoutMs,
    apiKey: '',
  };
}

function formatAdminDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function publicationStateLabel(value: AdminRepository['reviewPublicationState']): string {
  return value
    ? {
        pending: '대기',
        publishing: '게시 중',
        published: '게시 완료',
        failed: '게시 실패',
        disabled: '중지됨',
      }[value]
    : '게시 이력 없음';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '요청을 처리하지 못했습니다.';
}
