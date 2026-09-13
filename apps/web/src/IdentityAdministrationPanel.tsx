import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  AdminUser,
  Tenant,
  IdentityOperationView,
  IdentityPreview,
  IdentityProvisioningRequest,
  IdentityLifecycleRequest,
} from '@gcr/contracts';
import {
  loadIdentityOperations,
  previewKeycloakIdentity,
  requestIdentityOperation,
  retryIdentityOperation,
} from './api.ts';

type Action = IdentityProvisioningRequest['kind'] | IdentityLifecycleRequest['kind'];
type Request = IdentityProvisioningRequest | IdentityLifecycleRequest;
const defaultActions: Action[] = ['create', 'link', 'invite', 'password-reset'];
const actionLabel: Record<Action, string> = {
  create: '조직 계정 생성',
  link: '기존 계정 연결',
  invite: '초대 메일',
  'password-reset': '비밀번호 재설정 메일',
  disable: '조직 계정 차단',
  enable: '조직 계정 재활성화',
  'logout-all': '전체 기기 로그아웃',
};
const stateLabel = { pending: '대기', running: '처리 중', succeeded: '완료', failed: '실패' };
const explanation: Record<string, string> = {
  IDENTITY_EMAIL_UNCONFIRMED:
    '메일이 발송됐을 수 있습니다. 수신 여부를 확인한 뒤 필요한 경우 새 메일을 요청해 주세요.',
  IDENTITY_ACCOUNT_CONFLICT:
    '확인한 Keycloak 계정 정보가 요청과 다릅니다. 계정을 다시 확인해 주세요.',
  IDENTITY_ADMIN_UNAVAILABLE: 'Keycloak에 연결하지 못했습니다.',
  IDENTITY_ADMIN_FORBIDDEN: 'Keycloak 사용자 관리 권한을 확인해 주세요.',
  IDENTITY_ADMIN_CREDENTIAL_INVALID: 'Keycloak 서비스 계정 인증을 확인해 주세요.',
  IDENTITY_ACCESS_CHANGED: '앱 접근 권한이 변경되어 작업을 중단했습니다.',
  IDENTITY_OPERATION_FORBIDDEN: '요청한 관리자의 현재 권한을 확인해 주세요.',
  IDENTITY_SECURITY_UNAVAILABLE: '보안 이벤트 수집 상태를 확인한 뒤 다시 요청해 주세요.',
  IDENTITY_OPERATION_CONFLICT:
    '작업 도중 계정 상태가 달라졌습니다. 현재 상태를 확인한 뒤 다시 요청해 주세요.',
  IDENTITY_RESULT_UNCONFIRMED:
    'Keycloak 처리 결과를 확인하지 못했습니다. 앱 접근은 계속 차단됩니다.',
};
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : '계정 작업을 처리하지 못했습니다.';

export function IdentityAdministrationPanel({
  users,
  tenants,
  onChanged,
  actions = defaultActions,
}: {
  users: AdminUser[];
  tenants: Tenant[];
  onChanged: () => void;
  actions?: Action[];
}) {
  const [items, setItems] = useState<IdentityOperationView[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [action, setAction] = useState<Action | null>(null);
  const [targetId, setTargetId] = useState('new');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<'reviewer' | 'administrator'>('reviewer');
  const [tenantIds, setTenantIds] = useState<string[]>([]);
  const [keycloakId, setKeycloakId] = useState('');
  const [preview, setPreview] = useState<IdentityPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<Request | null>(null);
  const submittedRequest = useRef<Request | null>(null);
  const [revokeConfirmed, setRevokeConfirmed] = useState(false);
  const previousStates = useRef(new Map<string, string>());
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const next = await loadIdentityOperations(controller.signal);
        if (controller.signal.aborted) return;
        const completed = next.some(
          (item) =>
            ['succeeded', 'failed'].includes(item.state) &&
            previousStates.current.get(item.id) !== item.state,
        );
        previousStates.current = new Map(next.map((item) => [item.id, item.state]));
        setItems(next);
        if (completed) onChanged();
        if (next.some((item) => ['pending', 'running'].includes(item.state)))
          timer = setTimeout(() => void refresh(), 3000);
      } catch (failure) {
        if (!controller.signal.aborted) setError(messageOf(failure));
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [reload, onChanged]);
  const open = (next: Action) => {
    setAction(next);
    setSubmitted(null);
    submittedRequest.current = null;
    setRevokeConfirmed(false);
    setPreview(null);
    setError('');
    setNotice('');
    setTargetId(next === 'create' ? 'new' : '');
    setUsername('');
    setEmail('');
    setDisplayName('');
    setRole('reviewer');
    setTenantIds([]);
    setKeycloakId('');
  };
  const target = users.find((user) => user.id === targetId);
  const lifecycle = action === 'disable' || action === 'enable' || action === 'logout-all';
  const eligibleUsers = users.filter((user) =>
    lifecycle
      ? user.identityState?.provisioningState === 'provisioned' &&
        (action !== 'enable' || !user.enabled || !user.identityState.enabled)
      : action === 'invite' || action === 'password-reset'
        ? user.enabled &&
          user.identityState?.enabled &&
          user.identityState.provisioningState === 'provisioned'
        : !user.identityState,
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!action || busy) return;
    let input = submittedRequest.current;
    if (!input) {
      const requestId = crypto.randomUUID();
      const existing = target
        ? { kind: 'existing' as const, userId: target.id, expectedSubject: target.subject }
        : null;
      if (action === 'create') {
        if (targetId !== 'new' && !existing) return;
        input = {
          kind: 'create',
          requestId,
          username,
          email,
          displayName,
          target: existing ?? { kind: 'new', role, tenantIds },
        };
      } else if (action === 'link' && existing && preview) {
        input = {
          kind: 'link',
          requestId,
          target: existing,
          keycloakUserId: preview.keycloakUserId,
          expectedUsername: preview.username,
          expectedEmail: preview.email,
          expectedNameId: preview.nameId,
        };
      } else if ((action === 'invite' || action === 'password-reset') && existing) {
        if (action === 'password-reset' && !revokeConfirmed) return;
        input =
          action === 'invite'
            ? { kind: 'invite', requestId, target: existing, expectedEmail: email }
            : {
                kind: 'password-reset',
                requestId,
                target: existing,
                expectedEmail: email,
                revokeAllSessions: true,
              };
      } else if (
        (action === 'disable' || action === 'enable' || action === 'logout-all') &&
        existing
      ) {
        if (!revokeConfirmed) return;
        input = { kind: action, requestId, target: existing, revokeAllSessions: true };
      } else return;
      submittedRequest.current = input;
      setSubmitted(input);
    }
    setBusy(true);
    setError('');
    try {
      await requestIdentityOperation(input);
      setAction(null);
      setSubmitted(null);
      submittedRequest.current = null;
      setReload((value) => value + 1);
      onChanged();
      setNotice('작업을 접수했습니다. 아래 목록에서 처리 상태를 확인할 수 있습니다.');
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };
  const lookup = async () => {
    setBusy(true);
    setError('');
    setPreview(null);
    try {
      setPreview(await previewKeycloakIdentity(keycloakId));
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };
  const retry = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      await retryIdentityOperation(id);
      setReload((value) => value + 1);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="identity-administration" aria-labelledby="identity-administration-heading">
      <div className="admin-title-row">
        <div>
          <h2 id="identity-administration-heading">조직 계정 관리</h2>
          <p>
            계정 연결이 완료된 뒤 별도로 초대를 보낼 수 있습니다. 비밀번호는 Keycloak에서
            설정합니다.
          </p>
        </div>
        <button
          type="button"
          className="command-button"
          disabled={busy}
          onClick={() => setReload((value) => value + 1)}
        >
          작업 새로고침
        </button>
      </div>
      <div className="identity-actions">
        {actions.map((value) => (
          <button
            key={value}
            type="button"
            className="command-button"
            disabled={busy || action !== null}
            onClick={() => open(value)}
          >
            {actionLabel[value]}
          </button>
        ))}
      </div>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {action ? (
        <form aria-label={actionLabel[action]} onSubmit={(event) => void submit(event)}>
          <h3>{actionLabel[action]}</h3>
          <fieldset disabled={busy || submitted !== null} className="identity-form">
            <label>
              GCR 사용자
              <select
                required
                value={targetId}
                onChange={(event) => {
                  const id = event.target.value;
                  setTargetId(id);
                  setRevokeConfirmed(false);
                  const user = users.find((entry) => entry.id === id);
                  setDisplayName(user?.displayName ?? '');
                  setEmail(items.find((item) => item.userId === id)?.email ?? '');
                }}
              >
                {action === 'create' ? (
                  <option value="new">새 사용자</option>
                ) : (
                  <option value="">사용자 선택</option>
                )}
                {eligibleUsers.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.displayName} · {user.username ?? user.subject}
                  </option>
                ))}
              </select>
            </label>
            {target ? <p>기존 사용자 ID, 역할, 권한과 리뷰 이력을 유지합니다.</p> : null}
            {action === 'create' ? (
              <>
                <label>
                  로그인 이름
                  <input
                    required
                    minLength={3}
                    maxLength={64}
                    pattern="[a-z0-9][a-z0-9._-]{2,63}"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="off"
                  />
                </label>
                <label>
                  표시 이름
                  <input
                    required
                    maxLength={120}
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </label>
              </>
            ) : null}
            {['create', 'invite', 'password-reset'].includes(action) ? (
              <label>
                {action === 'invite' || action === 'password-reset'
                  ? '현재 등록된 이메일'
                  : '이메일'}
                <input
                  required
                  type="email"
                  maxLength={320}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
            ) : null}
            {action === 'create' && targetId === 'new' ? (
              <>
                <label>
                  GCR 역할
                  <select
                    value={role}
                    onChange={(event) => setRole(event.target.value as typeof role)}
                  >
                    <option value="reviewer">Reviewer</option>
                    <option value="administrator">Administrator</option>
                  </select>
                </label>
                <fieldset>
                  <legend>소속 테넌트</legend>
                  {tenants
                    .filter((tenant) => tenant.enabled)
                    .map((tenant) => (
                      <label key={tenant.id} className="identity-tenant">
                        <input
                          type="checkbox"
                          checked={tenantIds.includes(tenant.id)}
                          onChange={(event) =>
                            setTenantIds((current) =>
                              event.target.checked
                                ? [...current, tenant.id]
                                : current.filter((id) => id !== tenant.id),
                            )
                          }
                        />
                        {tenant.displayName}
                      </label>
                    ))}
                </fieldset>
              </>
            ) : null}
            {action === 'link' ? (
              <>
                <label>
                  Keycloak 사용자 ID
                  <input
                    required
                    value={keycloakId}
                    onChange={(event) => {
                      setKeycloakId(event.target.value);
                      setPreview(null);
                    }}
                    autoComplete="off"
                  />
                </label>
                <button
                  type="button"
                  className="command-button"
                  disabled={!keycloakId}
                  onClick={() => void lookup()}
                >
                  계정 조회
                </button>
                {preview ? (
                  <p role="status">
                    연결 대상: {preview.displayName} · {preview.username} · {preview.email} ·{' '}
                    {preview.enabled ? '활성' : '비활성'}
                  </p>
                ) : null}
              </>
            ) : null}
          </fieldset>
          {action === 'password-reset' || lifecycle ? (
            <label className="identity-tenant">
              <input
                type="checkbox"
                required
                checked={revokeConfirmed}
                disabled={busy || submitted !== null}
                onChange={(event) => setRevokeConfirmed(event.target.checked)}
              />
              {action === 'disable'
                ? '앱 접근을 즉시 차단하고 조직 계정을 비활성화하며 모든 로그인 세션을 종료합니다.'
                : action === 'enable'
                  ? '기존 로그인 세션을 종료하고, 조직 계정과 보안 이벤트 확인이 끝난 뒤 앱 접근을 다시 허용합니다.'
                  : action === 'logout-all'
                    ? '이 사용자의 모든 GCR 세션과 조직 계정의 기기 세션을 종료합니다. 계정 활성 상태는 유지합니다.'
                    : '이 사용자의 모든 GCR 세션을 종료하고 비밀번호 재설정 메일을 요청합니다.'}
            </label>
          ) : null}
          {submitted ? (
            <p>
              재시도하면 같은 요청의 결과를 확인합니다. 새 작업을 만들기 전 목록에서 기존 요청을
              확인해 주세요.
            </p>
          ) : null}
          <div className="identity-actions">
            <button
              type="submit"
              className="command-button primary"
              disabled={
                busy ||
                (!submitted &&
                  ((action === 'link' && (!target || !preview)) ||
                    ((action === 'invite' || action === 'password-reset') && !target) ||
                    (action === 'password-reset' && !revokeConfirmed) ||
                    (lifecycle && (!target || !revokeConfirmed)) ||
                    (action === 'create' && targetId === 'new' && tenantIds.length === 0)))
              }
            >
              {busy
                ? '요청 중'
                : submitted
                  ? '같은 요청 다시 확인'
                  : action === 'link'
                    ? '확인한 계정 연결'
                    : actionLabel[action]}
            </button>
            <button
              type="button"
              className="command-button"
              disabled={busy}
              onClick={() => {
                setAction(null);
                setSubmitted(null);
                submittedRequest.current = null;
              }}
            >
              닫기
            </button>
          </div>
        </form>
      ) : null}
      <div className="identity-operation-list">
        {items.length === 0 ? (
          <p>등록된 계정 작업이 없습니다.</p>
        ) : (
          items.map((item) => (
            <article key={item.id} className="identity-operation">
              <div>
                <strong>
                  {item.displayName ??
                    users.find((user) => user.id === item.userId)?.displayName ??
                    item.username ??
                    '사용자'}
                </strong>
                <span>
                  {actionLabel[item.kind as Action] ?? item.kind} ·{' '}
                  {item.mailDelivery === 'accepted' ? '메일 요청 접수' : stateLabel[item.state]}
                </span>
                {item.email ? <span>{item.email}</span> : null}
                {item.errorCode ? (
                  <p>
                    {explanation[item.errorCode] ??
                      '계정 정보를 확인한 뒤 작업을 다시 요청해 주세요.'}
                  </p>
                ) : null}
              </div>
              {item.retryAllowed ? (
                <button
                  type="button"
                  className="command-button"
                  disabled={busy}
                  onClick={() => void retry(item.id)}
                >
                  작업 재시도
                </button>
              ) : null}
            </article>
          ))
        )}
      </div>
    </section>
  );
}
