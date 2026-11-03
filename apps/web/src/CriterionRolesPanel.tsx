import { useEffect, useState } from 'react';
import type { CriterionRoleAssignment } from '@gcr/contracts';
import { assignCriterionRole, loadCriterionRoles } from './api.ts';
const roles = {
  maintainer: '유지관리자',
  'security-owner': '보안 책임자',
  'domain-owner': '도메인 책임자',
};
export function CriterionRolesPanel({ repositoryId }: { repositoryId: string }) {
  const [users, setUsers] = useState<Awaited<ReturnType<typeof loadCriterionRoles>>['users']>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<CriterionRoleAssignment | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void loadCriterionRoles(repositoryId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setUsers(result.users);
          setError('');
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '역할을 불러오지 못했습니다.');
      });
    return () => controller.abort();
  }, [repositoryId, refresh]);
  const update = async (input: CriterionRoleAssignment) => {
    setPending(input);
    setBusy(true);
    setError('');
    try {
      await assignCriterionRole(repositoryId, input);
      const result = await loadCriterionRoles(repositoryId, new AbortController().signal);
      setUsers(result.users);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '역할을 저장하지 못했습니다.');
    } finally {
      setBusy(false);
      setPending(null);
    }
  };
  return (
    <details className="criteria-roles">
      <summary>저장소 유지관리자·책임자 지정</summary>
      <p>
        기존 저장소 접근 권한이 있는 사용자에게 역할을 부여합니다. 지정 책임자는 다른 사람이 작성한
        고위험 기준이나 예외를 승인할 수 있습니다.
      </p>
      {busy ? <p role="status">역할을 저장하고 있습니다.</p> : null}
      {error ? (
        <p role="alert">
          {error}{' '}
          <button disabled={busy} onClick={() => setRefresh((value) => value + 1)}>
            역할 새로고침
          </button>
        </p>
      ) : null}
      <ul>
        {users.map((user) => (
          <li key={user.id}>
            <strong>{user.displayName}</strong>{' '}
            {!user.eligible ? <span>현재 저장소 접근 불가</span> : null}
            <small>{user.id}</small>
            <fieldset disabled={busy}>
              <legend className="sr-only">{user.displayName} 역할</legend>
              {Object.entries(roles).map(([role, label]) => (
                <label className="criteria-role-choice" key={role}>
                  <input
                    type="checkbox"
                    aria-label={`${user.displayName} ${label}`}
                    checked={
                      pending?.userId === user.id && pending.role === role
                        ? pending.enabled
                        : user.roles.includes(role as CriterionRoleAssignment['role'])
                    }
                    disabled={
                      !user.eligible &&
                      !user.roles.includes(role as CriterionRoleAssignment['role'])
                    }
                    onChange={(event) =>
                      void update({
                        userId: user.id,
                        role: role as CriterionRoleAssignment['role'],
                        enabled: event.target.checked,
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
          </li>
        ))}
      </ul>
      {!users.length && !error ? <p>지정할 수 있는 사용자가 없습니다.</p> : null}
    </details>
  );
}
