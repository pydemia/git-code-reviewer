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
  Users,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  activateAnalysisProvider,
  activateAnalysisPrompt,
  createTenant,
  createChatAccount,
  createGitHubConnection,
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
  saveAnalysisProvider,
  saveAnalysisPrompt,
  testAnalysisProvider,
  testGitHubConnection,
  updateAdminRepository,
  updateChatAccount,
  updateTenant,
  updateTenantMembership,
  updateUserAccess,
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

type AdminTab = 'tenants' | 'users' | 'provider' | 'prompt' | 'chat' | 'github';
type TenantForm = {
  id?: string;
  slug: string;
  displayName: string;
  enabled: boolean;
};
type ProviderDraft = {
  mode: 'disabled' | 'openai-compatible';
  endpoint: string;
  modelName: string;
  timeoutMs: number;
  apiKey: string;
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
  const [providerData, setProviderData] = useState<AnalysisProviderSettings | null>(null);
  const [chatAccounts, setChatAccounts] = useState<AdminChatAccount[]>([]);
  const [githubConnections, setGithubConnections] = useState<GitHubConnection[]>([]);
  const [adminRepositories, setAdminRepositories] = useState<AdminRepository[]>([]);
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>({
    mode: 'disabled',
    endpoint: '',
    modelName: '',
    timeoutMs: 120_000,
    apiKey: '',
  });
  const [tenantForm, setTenantForm] = useState<TenantForm | null>(null);
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
      return;
    }
    const controller = new AbortController();
    setPromptData(null);
    void loadAnalysisPrompts(selectedTenantId, controller.signal).then(
      (value) => {
        setPromptData(value);
        setPromptDraft(value.active?.instructions ?? '');
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

  const submitPrompt = async () => {
    if (!selectedTenantId || !promptDraft.trim()) return;
    await runMutation(
      'prompt:save',
      () => saveAnalysisPrompt(selectedTenantId, promptDraft),
      '새 프롬프트 버전을 활성화했습니다.',
    );
  };

  const providerInput = (): AnalysisProviderInput =>
    providerDraft.mode === 'disabled'
      ? { mode: 'disabled', timeoutMs: providerDraft.timeoutMs }
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
              selectedTenantId={selectedTenantId}
              search={search}
              busyKey={busyKey}
              onSearch={setSearch}
              onTenantChange={selectTenant}
              onAccessChange={(item, enabled) =>
                void runMutation(
                  `user:${item.id}`,
                  () => updateUserAccess(item.id, enabled),
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

          {tab === 'prompt' ? (
            <PromptPanel
              tenants={tenants}
              selectedTenant={selectedTenant}
              selectedTenantId={selectedTenantId}
              data={promptData}
              draft={promptDraft}
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
                if (!window.confirm('테넌트 프롬프트를 기본 분석 프롬프트로 되돌릴까요?')) return;
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

function UserPanel({
  currentUserId,
  users,
  tenants,
  selectedTenantId,
  search,
  busyKey,
  onSearch,
  onTenantChange,
  onAccessChange,
  onMembershipChange,
}: {
  currentUserId: string;
  users: AdminUser[];
  tenants: Tenant[];
  selectedTenantId: string;
  search: string;
  busyKey: string | null;
  onSearch: (value: string) => void;
  onTenantChange: (value: string) => void;
  onAccessChange: (user: AdminUser, enabled: boolean) => void;
  onMembershipChange: (user: AdminUser, enabled: boolean) => void;
}) {
  return (
    <section className="admin-section">
      <div className="admin-title-row">
        <div>
          <p className="eyebrow">Identity access</p>
          <h1>사용자</h1>
        </div>
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
        </div>
        {users.map((item) => {
          const membership = item.memberships.find((value) => value.tenantId === selectedTenantId);
          return (
            <div className="admin-table-row" key={item.id}>
              <span className="admin-primary">
                <strong>{item.displayName}</strong>
                <code>{item.subject}</code>
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
            </div>
          );
        })}
        {users.length === 0 ? <div className="admin-empty">일치하는 사용자가 없습니다.</div> : null}
      </div>
    </section>
  );
}

function PromptPanel({
  tenants,
  selectedTenant,
  selectedTenantId,
  data,
  draft,
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
  busyKey: string | null;
  onTenantChange: (value: string) => void;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onActivate: (promptId: string) => void;
  onReset: () => void;
}) {
  return (
    <section className="admin-section prompt-section">
      <div className="admin-title-row">
        <div>
          <p className="eyebrow">Analysis policy</p>
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
      <div className="prompt-editor">
        <div className="prompt-editor-heading">
          <strong>추가 분석 지침</strong>
          <span>{draft.length.toLocaleString()} / 12,000</span>
        </div>
        <textarea
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
            disabled={!data?.active || busyKey !== null}
          >
            <RotateCcw size={15} /> 기본값 복원
          </button>
          <button
            className="command-button primary"
            type="button"
            onClick={onSave}
            disabled={!draft.trim() || busyKey !== null}
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
            <pre>{prompt.instructions}</pre>
            <div className="prompt-version-footer">
              <span>{prompt.createdBy.displayName}</span>
              <code>{prompt.contentHash.slice(0, 12)}</code>
              {!prompt.active ? (
                <button
                  className="command-button"
                  type="button"
                  disabled={busyKey !== null}
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
  data,
  draft,
  busyKey,
  onDraftChange,
  onTest,
  onSave,
  onActivate,
  onReset,
}: {
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
    (draft.mode === 'disabled' || openAiComplete) &&
    draft.timeoutMs >= 1_000 &&
    draft.timeoutMs <= 600_000;

  return (
    <section className="admin-section provider-section">
      <div className="admin-title-row">
        <div>
          <p className="eyebrow">Analysis runtime</p>
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
        <span>{data?.effective.apiKeyConfigured ? 'Credential configured' : 'No credential'}</span>
      </div>

      <div className="provider-editor">
        <div className="provider-mode-control" role="group" aria-label="Provider mode">
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
        </div>

        <div className="provider-origin-row">
          <strong>허용 origin</strong>
          {data?.allowedOrigins.length ? (
            data.allowedOrigins.map((origin) => <code key={origin}>{origin}</code>)
          ) : (
            <span>설정되지 않음</span>
          )}
        </div>

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
      models: [{ id: modelName, displayName: modelName, allowedEfforts, defaultEffort }],
      assignments: tenantId
        ? [{ scopeType: 'tenant', scopeId: tenantId }]
        : [{ scopeType: 'all', scopeId: '*' }],
    });
    setAuthJson('');
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
        <label className="field-label">
          Model ID
          <input
            required
            maxLength={200}
            value={modelName}
            placeholder="Codex에서 사용할 model ID"
            onChange={(event) => setModelName(event.target.value)}
          />
        </label>
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
            onChange={(event) => setAuthJson(event.target.value)}
          />
        </label>
        <button className="command-button primary" type="submit" disabled={busyKey !== null}>
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
  onTest,
  onRegisterRepository,
  onRepositoryPollingChange,
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
  }) => Promise<unknown>;
  onTest: (connectionId: string) => Promise<unknown>;
  onRegisterRepository: (
    connectionId: string,
    values: {
      tenantId: string;
      owner: string;
      name: string;
      pollIntervalSeconds: number;
      grantSubjects: string[];
    },
  ) => Promise<unknown>;
  onRepositoryPollingChange: (repositoryId: string, enabled: boolean) => Promise<unknown>;
  onPollNow: (repositoryId: string) => Promise<unknown>;
}) {
  const [name, setName] = useState('');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [webBaseUrl, setWebBaseUrl] = useState('');
  const [credentialLabel, setCredentialLabel] = useState('default');
  const [accessToken, setAccessToken] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [tenantId, setTenantId] = useState(tenants[0]?.id ?? '');
  const [owner, setOwner] = useState('');
  const [repositoryName, setRepositoryName] = useState('');
  const [pollIntervalSeconds, setPollIntervalSeconds] = useState(120);
  const [grantSubject, setGrantSubject] = useState('');

  useEffect(() => {
    if (!connectionId && connections[0]) setConnectionId(connections[0].id);
    if (!tenantId && tenants[0]) setTenantId(tenants[0].id);
  }, [connectionId, connections, tenantId, tenants]);

  const submitConnection = async (event: FormEvent) => {
    event.preventDefault();
    await onCreate({ name, apiBaseUrl, webBaseUrl, credentialLabel, accessToken });
    setAccessToken('');
  };
  const submitRepository = async (event: FormEvent) => {
    event.preventDefault();
    await onRegisterRepository(connectionId, {
      tenantId,
      owner,
      name: repositoryName,
      pollIntervalSeconds,
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
        polling하고 Worker가 같은 token으로 필요한 commit만 clone합니다.
      </p>
      <form className="registry-form" onSubmit={(event) => void submitConnection(event)}>
        <label className="field-label">
          연결 이름
          <input required value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field-label">
          API base URL
          <input
            required
            type="url"
            placeholder="https://ghes.example/api/v3/"
            value={apiBaseUrl}
            onChange={(event) => setApiBaseUrl(event.target.value)}
          />
        </label>
        <label className="field-label">
          Web base URL
          <input
            required
            type="url"
            placeholder="https://ghes.example/"
            value={webBaseUrl}
            onChange={(event) => setWebBaseUrl(event.target.value)}
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
        <label className="field-label registry-secret-field">
          Access token
          <input
            required
            type="password"
            autoComplete="new-password"
            value={accessToken}
            onChange={(event) => setAccessToken(event.target.value)}
          />
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
            </div>
            <code>{connection.apiBaseUrl}</code>
            <code>…{connection.tokenFingerprint}</code>
            <button
              className="command-button"
              type="button"
              disabled={busyKey !== null}
              onClick={() => void onTest(connection.id)}
            >
              <Play size={14} /> 연결 테스트
            </button>
          </article>
        ))}
      </div>
      <div className="prompt-history-heading">
        <strong>Review repository 등록</strong>
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
                {connection.name} / {connection.credentialLabel}
              </option>
            ))}
          </select>
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
        <label className="field-label">
          Owner
          <input required value={owner} onChange={(event) => setOwner(event.target.value)} />
        </label>
        <label className="field-label">
          Repository
          <input
            required
            value={repositoryName}
            onChange={(event) => setRepositoryName(event.target.value)}
          />
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
        <button
          className="command-button primary"
          type="submit"
          disabled={!connectionId || !tenantId || busyKey !== null}
        >
          <Plus size={15} /> Repository 등록
        </button>
      </form>
      <div className="registry-list">
        {repositories.map((repository) => (
          <article className="registry-card" key={repository.id}>
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
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function readTab(): AdminTab {
  const value = new URLSearchParams(window.location.search).get('tab');
  return value === 'users' ||
    value === 'provider' ||
    value === 'prompt' ||
    value === 'chat' ||
    value === 'github'
    ? value
    : 'tenants';
}

function providerDraftFrom(settings: AnalysisProviderSettings): ProviderDraft {
  return {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '요청을 처리하지 못했습니다.';
}
