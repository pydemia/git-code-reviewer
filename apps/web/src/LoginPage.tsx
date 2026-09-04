import { KeyRound, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { loginLocalAccount } from './api.ts';

export function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setMessage('');
    try {
      const target = await loginLocalAccount(username, password, returnPath());
      window.location.replace(target);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '로그인하지 못했습니다.');
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
          <p>시스템관리자가 등록한 계정으로 접속해 주세요.</p>
        </div>
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
              minLength={12}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {message ? (
            <div className="login-error" role="alert">
              {message}
            </div>
          ) : null}
          <button className="command-button primary login-submit" type="submit" disabled={pending}>
            <KeyRound size={15} /> {pending ? '확인 중' : '로그인'}
          </button>
        </form>
      </section>
    </main>
  );
}

function returnPath(): string {
  const value = new URLSearchParams(window.location.search).get('returnTo');
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/';
}
