import {
  BadgeCheck,
  Building2,
  CircleAlert,
  KeyRound,
  Save,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { localPasswordMaximumLength, localPasswordMinimumLength } from '@gcr/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { changeOwnPassword, loadProfile, updateProfile, type Profile } from './api.ts';
import { AppHeader } from './AppHeader.tsx';

type Notice = { tone: 'success' | 'error'; text: string };

export function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pending, setPending] = useState<'profile' | 'password' | null>(null);
  const [profileNotice, setProfileNotice] = useState<Notice | null>(null);
  const [passwordNotice, setPasswordNotice] = useState<Notice | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const profileNoticeRef = useRef<HTMLDivElement>(null);
  const passwordNoticeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void loadProfile(controller.signal).then(
      (value) => {
        setProfile(value);
        setDisplayName(value.displayName);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          console.error(error);
          setLoadFailed(true);
        }
      },
    );
    return () => controller.abort();
  }, []);

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    if (!profile?.profileEditable) return;
    setPending('profile');
    setProfileNotice(null);
    try {
      const updated = await updateProfile(displayName);
      setProfile(updated);
      setDisplayName(updated.displayName);
      setProfileNotice({ tone: 'success', text: '표시 이름을 저장했습니다.' });
    } catch (error) {
      setProfileNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : '프로필을 저장하지 못했습니다.',
      });
      window.requestAnimationFrame(() => profileNoticeRef.current?.focus());
    } finally {
      setPending(null);
    }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!profile?.passwordChangeAllowed) return;
    if (newPassword !== confirmPassword) {
      setPasswordNotice({ tone: 'error', text: '새 비밀번호와 확인 값이 일치하지 않습니다.' });
      window.requestAnimationFrame(() => passwordNoticeRef.current?.focus());
      return;
    }
    if (newPassword.length < localPasswordMinimumLength) {
      setPasswordNotice({ tone: 'error', text: '새 비밀번호는 8자 이상 입력해 주세요.' });
      window.requestAnimationFrame(() => passwordNoticeRef.current?.focus());
      return;
    }
    setPending('password');
    setPasswordNotice(null);
    try {
      await changeOwnPassword(currentPassword, newPassword);
      window.location.replace('/login?passwordChanged=1');
    } catch (error) {
      setPasswordNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : '비밀번호를 변경하지 못했습니다.',
      });
      setPending(null);
      window.requestAnimationFrame(() => passwordNoticeRef.current?.focus());
    }
  };

  return (
    <div className="profile-page">
      <AppHeader user={profile} />
      <main className="profile-main">
        <header className="profile-heading">
          <h1>내 프로필</h1>
          <p>계정 정보와 표시 이름을 확인하고 로그인 비밀번호를 관리합니다.</p>
        </header>

        {loadFailed ? (
          <div className="profile-load-error" role="alert">
            <CircleAlert size={16} /> 프로필을 불러오지 못했습니다. 페이지를 새로고침해 주세요.
          </div>
        ) : null}

        {profile ? (
          <div className="profile-surface">
            <aside className="profile-summary" aria-label="계정 요약">
              <div className="profile-avatar" aria-hidden="true">
                {initials(profile.displayName)}
              </div>
              <h2>{profile.displayName}</h2>
              <p>{profile.username ?? profile.subject}</p>
              <div className="profile-badges">
                <span>
                  <BadgeCheck size={13} />
                  {profile.role === 'administrator' ? '시스템관리자' : '일반사용자'}
                </span>
                <span>
                  <ShieldCheck size={13} />
                  {profile.identityType === 'local' ? 'Local account' : 'External identity'}
                </span>
              </div>
              <div className="profile-tenants">
                <strong>
                  <Building2 size={14} /> Tenant
                </strong>
                {profile.tenants.length > 0 ? (
                  <ul>
                    {profile.tenants.map((tenant) => (
                      <li key={tenant.id}>{tenant.displayName}</li>
                    ))}
                  </ul>
                ) : (
                  <p>할당된 tenant가 없습니다.</p>
                )}
              </div>
            </aside>

            <div className="profile-settings">
              <section className="profile-section" aria-labelledby="profile-identity-title">
                <div className="profile-section-heading">
                  <UserRound size={18} />
                  <div>
                    <h2 id="profile-identity-title">프로필 정보</h2>
                    <p>사용자 이름과 역할은 시스템관리자가 관리합니다.</p>
                  </div>
                </div>
                {profileNotice ? (
                  <div
                    className={`profile-notice ${profileNotice.tone}`}
                    role={profileNotice.tone === 'error' ? 'alert' : 'status'}
                    tabIndex={-1}
                    ref={profileNoticeRef}
                  >
                    {profileNotice.text}
                  </div>
                ) : null}
                <form onSubmit={(event) => void saveProfile(event)}>
                  <div className="profile-form-grid">
                    <label className="field-label">
                      {profile.identityType === 'local' ? '사용자 이름' : 'Subject'}
                      <input value={profile.username ?? profile.subject} disabled />
                    </label>
                    <label className="field-label">
                      표시 이름
                      <input
                        required
                        maxLength={120}
                        autoComplete="name"
                        value={displayName}
                        disabled={!profile.profileEditable}
                        onChange={(event) => setDisplayName(event.target.value)}
                      />
                    </label>
                  </div>
                  {!profile.profileEditable ? (
                    <p className="profile-managed-note">
                      표시 이름은 연결된 Identity Provider에서 변경해 주세요.
                    </p>
                  ) : (
                    <div className="profile-actions">
                      <button
                        className={`command-button primary ${pending === 'profile' ? 'pending' : ''}`}
                        type="submit"
                        disabled={pending !== null || displayName.trim() === profile.displayName}
                      >
                        <Save size={15} /> {pending === 'profile' ? '저장 중' : '표시 이름 저장'}
                      </button>
                    </div>
                  )}
                </form>
              </section>

              <section className="profile-section" aria-labelledby="profile-password-title">
                <div className="profile-section-heading">
                  <KeyRound size={18} />
                  <div>
                    <h2 id="profile-password-title">비밀번호 변경</h2>
                    <p>변경이 완료되면 모든 session이 종료되고 다시 로그인해야 합니다.</p>
                  </div>
                </div>
                {passwordNotice ? (
                  <div
                    className={`profile-notice ${passwordNotice.tone}`}
                    role={passwordNotice.tone === 'error' ? 'alert' : 'status'}
                    tabIndex={-1}
                    ref={passwordNoticeRef}
                  >
                    {passwordNotice.text}
                  </div>
                ) : null}
                {profile.passwordChangeAllowed ? (
                  <form onSubmit={(event) => void changePassword(event)}>
                    <label className="field-label">
                      현재 비밀번호
                      <input
                        required
                        type="password"
                        maxLength={localPasswordMaximumLength}
                        autoComplete="current-password"
                        value={currentPassword}
                        onChange={(event) => setCurrentPassword(event.target.value)}
                      />
                    </label>
                    <div className="profile-form-grid">
                      <label className="field-label">
                        새 비밀번호
                        <input
                          required
                          type="password"
                          minLength={localPasswordMinimumLength}
                          maxLength={localPasswordMaximumLength}
                          autoComplete="new-password"
                          value={newPassword}
                          onChange={(event) => setNewPassword(event.target.value)}
                        />
                        <small>8~128자로 입력합니다.</small>
                      </label>
                      <label className="field-label">
                        새 비밀번호 확인
                        <input
                          required
                          type="password"
                          minLength={localPasswordMinimumLength}
                          maxLength={localPasswordMaximumLength}
                          autoComplete="new-password"
                          value={confirmPassword}
                          onChange={(event) => setConfirmPassword(event.target.value)}
                        />
                      </label>
                    </div>
                    <div className="profile-actions">
                      <button
                        className={`command-button primary ${pending === 'password' ? 'pending' : ''}`}
                        type="submit"
                        disabled={pending !== null}
                      >
                        <KeyRound size={15} />
                        {pending === 'password' ? '변경 중' : '비밀번호 변경'}
                      </button>
                    </div>
                  </form>
                ) : (
                  <p className="profile-managed-note">
                    이 계정의 비밀번호는 연결된 Identity Provider에서 변경해 주세요.
                  </p>
                )}
              </section>
            </div>
          </div>
        ) : !loadFailed ? (
          <div className="profile-loading">프로필을 불러오는 중입니다.</div>
        ) : null}
      </main>
    </div>
  );
}

function initials(displayName: string): string {
  return (
    displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || '--'
  );
}
