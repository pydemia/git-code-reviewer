import { KeyRound, ShieldCheck } from 'lucide-react';
import { localPasswordMaximumLength, localPasswordMinimumLength } from '@gcr/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { loginLocalAccount } from './api.ts';

export function LoginPage() {
  const [authMode, setAuthMode] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('logoutFailed') === '1')
      return {
        tone: 'error',
        text: '로그아웃 완료를 확인하지 못했습니다. 로그인 상태가 남아 있을 수 있습니다. 다시 로그인한 뒤 로그아웃을 시도해 주세요.',
      };
    return params.get('passwordChanged') === '1'
      ? { tone: 'success', text: '비밀번호를 변경했습니다. 새 비밀번호로 로그인해 주세요.' }
      : null;
  });

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/v1/system', { signal: controller.signal, credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok)
          throw new Error('로그인 방식을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.');
        const data: unknown = await response.json();
        if (
          typeof data !== 'object' ||
          data === null ||
          !('authMode' in data) ||
          typeof data.authMode !== 'string' ||
          !['local', 'saml', 'oidc', 'proxy', 'development'].includes(data.authMode)
        )
          throw new Error('로그인 설정을 확인할 수 없습니다. 관리자에게 문의해 주세요.');
        if (!controller.signal.aborted) setAuthMode(data.authMode);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setNotice({
            tone: 'error',
            text: '로그인 방식을 확인할 수 없습니다. 잠시 후 페이지를 새로고침해 주세요.',
          });
      });
    return () => controller.abort();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setNotice(null);
    try {
      const target = await loginLocalAccount(username, password, returnPath());
      window.location.replace(target);
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : '로그인하지 못했습니다.',
      });
      setPending(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand">
          <ShieldCheck size={24} />
          <span>Git Code Reviewer</span>
        </div>
        <div className="login-heading">
          <p className="eyebrow">Private review workspace</p>
          <h1 id="login-title">로그인</h1>
          <p>
            {authMode === 'saml' || authMode === 'oidc'
              ? '조직의 로그인 화면에서 계정을 인증해 주세요.'
              : authMode === 'local'
                ? '시스템관리자가 등록한 계정으로 접속해 주세요.'
                : '로그인 방식을 확인하고 있습니다.'}
          </p>
        </div>
        {authMode === 'local' ? (
          <form onSubmit={(event) => void submit(event)}>
            <label className="field-label">
              사용자 이름
              <input
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                minLength={3}
                maxLength={64}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoFocus
              />
            </label>
            <label className="field-label">
              비밀번호
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={localPasswordMinimumLength}
                maxLength={localPasswordMaximumLength}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {notice ? (
              <div
                className={`login-${notice.tone}`}
                role={notice.tone === 'error' ? 'alert' : 'status'}
              >
                {notice.text}
              </div>
            ) : null}
            <button
              className="command-button primary login-submit"
              type="submit"
              disabled={pending}
            >
              <KeyRound size={15} /> {pending ? '확인 중' : '로그인'}
            </button>
          </form>
        ) : (
          <>
            {notice?.tone === 'error' ? (
              <div className="login-error" role="alert">
                {notice.text}
              </div>
            ) : null}
            {authMode ? (
              <a
                className="command-button primary login-submit"
                href={`/auth/login?returnTo=${encodeURIComponent(returnPath())}`}
              >
                <KeyRound size={15} />
                {authMode === 'saml' || authMode === 'oidc' ? '조직 계정으로 로그인' : '계속'}
              </a>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}

function returnPath(): string {
  const value = new URLSearchParams(window.location.search).get('returnTo');
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/';
}
