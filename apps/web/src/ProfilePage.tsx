import {
  BadgeCheck,
  Building2,
  CircleAlert,
  KeyRound,
  Laptop,
  MessageSquareText,
  Save,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { localPasswordMaximumLength, localPasswordMinimumLength } from '@gcr/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { changeOwnPassword, loadProfile, updateProfile, type Profile } from './api.ts';
import { AppHeader } from './AppHeader.tsx';
import { PersonalPromptForm } from './PersonalPromptForm.tsx';
import { ClientCredentialsPanel } from './ClientCredentialsPanel.tsx';

type ProfileTab = 'profile' | 'prompt' | 'clients';
const profileTabs = [
  { id: 'profile', label: '프로필 · 비밀번호 변경', icon: UserRound },
  { id: 'prompt', label: 'Prompt', icon: MessageSquareText },
  { id: 'clients', label: '클라이언트 설정', icon: Laptop },
] as const;

function readProfileTab(): ProfileTab {
  const tab = new URLSearchParams(window.location.search).get('tab');
  return tab === 'prompt' || tab === 'clients' ? tab : 'profile';
}

type Notice = { tone: 'success' | 'error'; text: string };

export function ProfilePage() {
  const [tab, setTab] = useState<ProfileTab>(readProfileTab);
  const pageRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    const restoreTab = () => {
      setTab(readProfileTab());
      pageRef.current?.scrollTo({ top: 0 });
    };
    window.addEventListener('popstate', restoreTab);
    return () => window.removeEventListener('popstate', restoreTab);
  }, []);

  const selectTab = (nextTab: ProfileTab) => {
    if (nextTab === tab) return;
    const url = new URL(window.location.href);
    url.searchParams.set('tab', nextTab);
    window.history.pushState(null, '', url);
    setTab(nextTab);
    pageRef.current?.scrollTo({ top: 0 });
  };

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
    <div className="profile-page" ref={pageRef}>
      <AppHeader user={profile} />
      <main className="profile-main">
        <header className="profile-heading">
          <h1>내 설정</h1>
          <p>
            계정 정보, 클라이언트 연결, Review Chat의 개인 Prompt와 로그인 비밀번호를 관리합니다.
          </p>
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
              <nav className="profile-nav" aria-label="개인 설정 메뉴">
                {profileTabs.map(({ id, label, icon: Icon }) => (
                  <a
                    key={id}
                    id={`profile-nav-${id}`}
                    href={`?tab=${id}`}
                    aria-current={tab === id ? 'page' : undefined}
                    aria-controls={`profile-pane-${id}`}
                    onClick={(event) => {
                      if (
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
                      event.preventDefault();
                      selectTab(id);
                    }}
                  >
                    <Icon size={16} aria-hidden="true" />
                    <span>{label}</span>
                  </a>
                ))}
              </nav>
            </aside>

            <div className="profile-settings">
              <div
                id="profile-pane-profile"
                className="profile-pane"
                hidden={tab !== 'profile'}
                aria-labelledby="profile-nav-profile"
                role="region"
              >
                <section className="profile-section" aria-labelledby="profile-identity-title">
                  <div className="profile-section-heading">
                    <UserRound size={18} />
                    <div>
                      <h2 id="profile-identity-title">프로필 정보</h2>
                      <p>사용자 이름과 역할은 시스템관리자가 관리합니다.</p>
                    </div>
                  </div>
                  <div className="profile-badges">
                    <span>
                      <BadgeCheck size={13} />
                      {profile.role === 'administrator' ? '시스템관리자' : '일반사용자'}
                    </span>
                    <span>
                      <ShieldCheck size={13} />
                      {profile.identityType === 'saml'
                        ? '조직 계정'
                        : profile.identityType === 'local'
                          ? 'Local account'
                          : 'External identity'}
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
              <div
                id="profile-pane-prompt"
                className="profile-pane"
                hidden={tab !== 'prompt'}
                aria-labelledby="profile-nav-prompt"
                role="region"
              >
                <PersonalPromptForm key={profile.id} initialPrompt={profile.personalPrompt} />
              </div>
              <div
                id="profile-pane-clients"
                className="profile-pane"
                hidden={tab !== 'clients'}
                aria-labelledby="profile-nav-clients"
                role="region"
              >
                <ClientCredentialsPanel key={`client-${profile.id}`} />
              </div>
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
