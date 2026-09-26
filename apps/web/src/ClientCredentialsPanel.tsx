import { useEffect, useRef, useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import type { ClientCredential, Repository } from '@gcr/contracts';
import { loadCriteriaRepositories } from './api.ts';
import {
  loadClientAuthConfig,
  loadClientCredentials,
  issueClientCredential,
  revokeClientCredential,
  loadClientConnectionConfig,
} from './client-credentials-api.ts';

export function ClientCredentialsPanel() {
  const [state, setState] = useState<'loading' | 'disabled' | 'ready' | 'failed'>('loading');
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [items, setItems] = useState<ClientCredential[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [repositoryId, setRepositoryId] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [repositoryIds, setRepositoryIds] = useState<string[]>([]);
  const [allRepositories, setAllRepositories] = useState(false);
  const [connection, setConnection] = useState<{ serverUrl: string; ca: string | null } | null>(
    null,
  );
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [name, setName] = useState('');
  const [clientId, setClientId] = useState<'commit-defender' | 'gcr-cli'>('commit-defender');
  const [lifetimeDays, setLifetimeDays] = useState(30);
  const [noExpiration, setNoExpiration] = useState(false);
  const [issued, setIssued] = useState<{ id: string; token: string } | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    const clearSecret = () => {
      active.abort();
      setIssued(null);
      setRevealed(false);
    };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener('pagehide', clearSecret);
    window.addEventListener('pageshow', restore);
    void (async () => {
      try {
        const config = await loadClientAuthConfig(active.signal);
        if (active.signal.aborted) return;
        if (!config.methods.includes('api-key')) {
          setState('disabled');
          return;
        }
        const [repos, keys] = await Promise.all([
          loadCriteriaRepositories(active.signal),
          loadClientCredentials(active.signal),
        ]);
        if (active.signal.aborted) return;
        setRepositories(repos);
        setRepositoryId(repos[0]?.id ?? '');
        setTenantId(repos[0]?.tenantId ?? '');
        setRepositoryIds(repos[0] ? [repos[0].id] : []);
        setItems(keys.items);
        setCursor(keys.nextCursor);
        setState('ready');
      } catch {
        if (!active.signal.aborted) setState('failed');
      }
    })();
    return () => {
      active.abort();
      window.removeEventListener('pagehide', clearSecret);
      window.removeEventListener('pageshow', restore);
    };
  }, []);

  useEffect(() => {
    setConnection(null);
    setConnectionFailed(false);
    if (!repositoryId) return;
    const active = new AbortController();
    void loadClientConnectionConfig(repositoryId, active.signal)
      .then((value) => {
        if (!active.signal.aborted) setConnection(value);
      })
      .catch(() => {
        if (!active.signal.aborted) setConnectionFailed(true);
      });
    return () => active.abort();
  }, [repositoryId]);

  async function action(work: (signal: AbortSignal) => Promise<void>, failure: string) {
    const active = controller.current;
    if (busy.current || !active || active.signal.aborted) return;
    busy.current = true;
    setPending(true);
    setNotice(null);
    try {
      await work(active.signal);
    } catch {
      if (!active.signal.aborted) setNotice({ error: true, text: failure });
    } finally {
      busy.current = false;
      if (!active.signal.aborted) setPending(false);
    }
  }
  const selected = repositories.find((repository) => repository.id === repositoryId);
  const tenants = [
    ...new Map(repositories.map((repo) => [repo.tenantId, repo.tenantName])).entries(),
  ];
  const tenantRepositories = repositories.filter((repo) => repo.tenantId === tenantId);
  const effectiveIds = allRepositories ? tenantRepositories.map((repo) => repo.id) : repositoryIds;
  const validScope = effectiveIds.length > 0 && effectiveIds.length <= 100;
  const create = (event: FormEvent) => {
    event.preventDefault();
    if (!validScope || issued) return;
    void action(async (signal) => {
      const result = await issueClientCredential({
        name,
        clientId,
        tenantId,
        repositoryIds: effectiveIds,
        lifetimeDays: noExpiration ? null : lifetimeDays,
        scopes: ['knowledge:read'],
      });
      if (signal.aborted) return;
      setItems((previous) => [result.credential, ...previous]);
      setIssued({ id: result.credential.id, token: result.token });
      setRevealed(false);
      setName('');
    }, '발급 결과를 확인하지 못했습니다. 목록을 새로 불러와 발급 여부를 확인해 주세요. 원문을 받지 못한 key는 폐기한 후 다시 발급해 주세요.');
  };
  const download = () =>
    void action(async (signal) => {
      const config = await loadClientConnectionConfig(repositoryId, signal);
      if (signal.aborted) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(config, null, 2) + '\n'], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `gcr-connection-${repositoryId}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice({
        error: false,
        text: '연결 설정을 내려받았습니다. 클라이언트에서 서버 주소와 공개키를 확인한 뒤 연결해 주세요.',
      });
    }, '연결 설정을 내려받지 못했습니다. 저장소 접근 권한을 확인해 주세요.');

  return (
    <section
      className="profile-section client-credentials"
      aria-labelledby="client-credentials-title"
    >
      <div className="profile-section-heading">
        <KeyRound size={18} />
        <div>
          <h2 id="client-credentials-title">클라이언트 연결</h2>
          <p>
            Commit Defender와 GCR CLI에 원문 이력·Skill·프롬프트·활성 지침의 읽기 권한을 부여합니다.
            모델 계정은 클라이언트에서 따로 선택합니다.
          </p>
          <p>
            <a href="/getting-started">설치·연결 절차와 사용 예시</a>
          </p>
        </div>
      </div>
      {state === 'loading' && <p role="status">연결 정보를 불러오는 중입니다.</p>}
      {state === 'disabled' && (
        <p>이 서버에서는 클라이언트 API key 연결을 아직 제공하지 않습니다.</p>
      )}
      {state === 'failed' && (
        <p role="alert">연결 정보를 불러오지 못했습니다. 페이지를 새로고침해 주세요.</p>
      )}
      {state === 'ready' && (
        <>
          {notice && (
            <p
              className={`profile-notice ${notice.error ? 'error' : 'success'}`}
              role={notice.error ? 'alert' : 'status'}
            >
              {notice.text}
            </p>
          )}
          <ol>
            <li>클라이언트와 접근할 저장소를 선택하고 API key를 발급합니다.</li>
            <li>
              CD의 Central Review Connection → Connect with API key…에서 서버 주소와 key를
              입력합니다.
            </li>
            <li>조회된 저장소 중 현재 로컬 작업 폴더에 연결할 저장소를 선택합니다.</li>
          </ol>
          <form onSubmit={create}>
            <fieldset disabled={pending || !!issued}>
              <legend>새 API key</legend>
              <label className="field-label">
                이름
                <input
                  required
                  maxLength={100}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="예: 업무용 Mac"
                />
              </label>
              <div className="profile-form-grid">
                <label className="field-label">
                  클라이언트
                  <select
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value as typeof clientId)}
                  >
                    <option value="commit-defender">Commit Defender</option>
                    <option value="gcr-cli">GCR CLI</option>
                  </select>
                </label>
                <div>
                  <label className="field-label">
                    만료 설정
                    <select
                      value={noExpiration ? 'none' : 'days'}
                      onChange={(event) => setNoExpiration(event.target.value === 'none')}
                    >
                      <option value="days">기간 지정</option>
                      <option value="none">No expiration (만료 없음)</option>
                    </select>
                  </label>
                  {!noExpiration && (
                    <label className="field-label">
                      유효 기간 (일)
                      <input
                        type="number"
                        required
                        min={1}
                        max={90}
                        step={1}
                        value={lifetimeDays}
                        onChange={(event) => setLifetimeDays(Number(event.target.value))}
                      />
                    </label>
                  )}
                </div>
              </div>
              <label className="field-label">
                Tenant
                <select
                  value={tenantId}
                  onChange={(event) => {
                    const id = event.target.value;
                    const first = repositories.find((repo) => repo.tenantId === id);
                    setTenantId(id);
                    setRepositoryId(first?.id ?? '');
                    setRepositoryIds(first ? [first.id] : []);
                    setAllRepositories(false);
                  }}
                >
                  {!tenants.length && <option value="">접근 가능한 저장소가 없습니다.</option>}
                  {tenants.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="client-repository-selection">
                <legend>저장소 접근 범위</legend>
                <label className="client-repository-option">
                  <input
                    type="checkbox"
                    checked={allRepositories}
                    onChange={(event) => setAllRepositories(event.target.checked)}
                  />
                  현재 접근 가능한 모든 저장소 ({tenantRepositories.length}개)
                </label>
                <p>
                  선택한 tenant의 발급 시점 저장소에 적용됩니다. 이후 추가되는 저장소는 새 key를
                  발급해 주세요.
                </p>
                <div className="client-repository-list">
                  {tenantRepositories.map((repo) => (
                    <label className="client-repository-option" key={repo.id}>
                      <input
                        type="checkbox"
                        checked={allRepositories || repositoryIds.includes(repo.id)}
                        disabled={allRepositories}
                        onChange={(event) =>
                          setRepositoryIds((ids) =>
                            event.target.checked
                              ? [...ids, repo.id]
                              : ids.filter((id) => id !== repo.id),
                          )
                        }
                      />
                      <span>
                        {repo.owner}/{repo.name}
                      </span>
                    </label>
                  ))}
                </div>
                <p aria-live="polite">
                  {effectiveIds.length}개 저장소 선택 · API key 하나당 최대 100개
                </p>
                {effectiveIds.length > 100 && (
                  <p role="alert">
                    100개 이하로 선택해 주세요. 저장소를 나누어 key를 발급할 수 있습니다.
                  </p>
                )}
              </fieldset>
              <p>권한: 중앙 리뷰·프롬프트 읽기. 로컬 결과와 소스는 전송하지 않습니다.</p>
              <div className="profile-actions">
                <button
                  className="command-button primary"
                  type="submit"
                  disabled={!validScope || !name.trim()}
                >
                  API key 발급
                </button>
              </div>
            </fieldset>
          </form>
          {connection && (
            <div className="client-connection-address">
              <label className="field-label">
                CD에 입력할 서버 주소
                <input readOnly value={connection.serverUrl} />
              </label>
              <p>
                API key는 CD의 비밀번호 입력란에 입력하며 OS 자격 증명 저장소에 보관합니다. JSON은
                필요하지 않습니다.
              </p>
              {connection.ca && (
                <button
                  type="button"
                  className="command-button"
                  onClick={() => {
                    const url = URL.createObjectURL(
                      new Blob([connection.ca!], { type: 'application/x-pem-file' }),
                    );
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = 'gcr-ca.pem';
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                >
                  CA 인증서 다운로드
                </button>
              )}
              {connection.ca && (
                <p>
                  사설 CA를 사용하는 서버에서 인증서 오류가 나면 CD의 Choose CA certificate…에서 이
                  공개 인증서 파일을 선택해 주세요. TLS 검증은 유지됩니다.
                </p>
              )}
            </div>
          )}
          {connectionFailed && (
            <p role="alert">
              서버 연결 정보를 불러오지 못했습니다. 저장소 접근 권한과 서버 상태를 확인해 주세요.
            </p>
          )}
          <details>
            <summary>기존 클라이언트용 공개 연결 JSON</summary>
            <p>
              서버 주소·저장소 ID·서명 공개키·CA가 담긴 공개 설정 파일입니다. API key 원문은
              포함되지 않습니다. 새 CD 연결에는 필요하지 않습니다.
            </p>
            <label className="field-label">
              JSON에 포함할 저장소
              <select
                value={repositoryId}
                onChange={(event) => setRepositoryId(event.target.value)}
              >
                {tenantRepositories.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.owner}/{repo.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="command-button"
              type="button"
              disabled={pending || !selected}
              onClick={download}
            >
              선택한 저장소의 연결 설정 다운로드
            </button>
          </details>
          {issued && (
            <div className="client-key-issued" role="region" aria-label="API key 원문 확인">
              <p>
                API key 원문은 지금만 확인할 수 있습니다. 화면을 닫으면 다시 조회할 수 없습니다.
              </p>
              <label className="field-label">
                발급된 API key
                <input
                  type={revealed ? 'text' : 'password'}
                  readOnly
                  value={issued.token}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <div className="profile-actions">
                <button
                  className="command-button"
                  type="button"
                  onClick={() => setRevealed((value) => !value)}
                >
                  {revealed ? '원문 숨기기' : '원문 보기'}
                </button>
                <button
                  className="command-button"
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    void action(async (signal) => {
                      await navigator.clipboard.writeText(issued.token);
                      if (!signal.aborted)
                        setNotice({ error: false, text: 'API key를 복사했습니다.' });
                    }, '복사하지 못했습니다. 원문 보기 후 직접 복사해 주세요.')
                  }
                >
                  API key 복사
                </button>
                <button
                  className="command-button"
                  type="button"
                  onClick={() => {
                    setIssued(null);
                    setRevealed(false);
                  }}
                >
                  원문 닫기
                </button>
              </div>
            </div>
          )}
          <div className="client-credentials-list-heading">
            <h3>발급한 API key</h3>
            <button
              className="command-button"
              type="button"
              disabled={pending}
              onClick={() =>
                void action(async (signal) => {
                  const result = await loadClientCredentials(signal);
                  if (!signal.aborted) {
                    setItems(result.items);
                    setCursor(result.nextCursor);
                  }
                }, '목록을 불러오지 못했습니다.')
              }
            >
              목록 새로고침
            </button>
          </div>
          {!items.length && <p>발급한 API key가 없습니다.</p>}
          <ul className="client-credentials-list">
            {items.map((item) => {
              const expired = item.expiresAt !== null && Date.parse(item.expiresAt) <= Date.now();
              return (
                <li key={item.id}>
                  <strong>{item.name}</strong>
                  <p>{item.scopes.join(', ')}</p>
                  <span>
                    {item.clientId === 'commit-defender' ? 'Commit Defender' : 'GCR CLI'} ·{' '}
                    {item.revokedAt ? '폐기됨' : expired ? '만료됨' : '발급됨'}
                  </span>
                  <span>
                    만료:{' '}
                    {item.expiresAt === null
                      ? 'No expiration (만료 없음)'
                      : new Date(item.expiresAt).toLocaleString('ko-KR')}
                  </span>
                  <span>
                    저장소:{' '}
                    {item.repositoryIds
                      .map((id) => {
                        const repo = repositories.find((candidate) => candidate.id === id);
                        return repo ? `${repo.owner}/${repo.name}` : id;
                      })
                      .join(', ')}
                  </span>
                  {!item.revokedAt &&
                    (revokeId === item.id ? (
                      <div>
                        <p>이 key를 사용하는 클라이언트의 연결 권한을 폐기하시겠습니까?</p>
                        <div className="profile-actions">
                          <button
                            className="command-button"
                            disabled={pending}
                            type="button"
                            onClick={() =>
                              void action(async (signal) => {
                                await revokeClientCredential(item.id);
                                if (signal.aborted) return;
                                setItems((previous) =>
                                  previous.map((key) =>
                                    key.id === item.id
                                      ? { ...key, revokedAt: new Date().toISOString() }
                                      : key,
                                  ),
                                );
                                if (issued?.id === item.id) {
                                  setIssued(null);
                                  setRevealed(false);
                                }
                                setRevokeId(null);
                                setNotice({
                                  error: false,
                                  text: 'API key를 폐기했습니다. 이미 내려받은 지식의 오프라인 사용은 발급된 사용 기한까지 허용될 수 있습니다.',
                                });
                              }, '폐기 결과를 확인하지 못했습니다. 목록을 새로 불러와 확인해 주세요.')
                            }
                          >
                            폐기 확인
                          </button>
                          <button
                            className="command-button"
                            type="button"
                            disabled={pending}
                            onClick={() => setRevokeId(null)}
                          >
                            취소
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        className="command-button"
                        type="button"
                        disabled={pending}
                        onClick={() => setRevokeId(item.id)}
                      >
                        {item.name} 폐기
                      </button>
                    ))}
                </li>
              );
            })}
          </ul>
          {cursor && (
            <button
              className="command-button"
              type="button"
              disabled={pending}
              onClick={() =>
                void action(async (signal) => {
                  const result = await loadClientCredentials(signal, cursor);
                  if (!signal.aborted) {
                    setItems((previous) => [
                      ...previous,
                      ...result.items.filter((item) => !previous.some((key) => key.id === item.id)),
                    ]);
                    setCursor(result.nextCursor);
                  }
                }, '다음 목록을 불러오지 못했습니다.')
              }
            >
              이전 key 더 보기
            </button>
          )}
        </>
      )}
    </section>
  );
}
