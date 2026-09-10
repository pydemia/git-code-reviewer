import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Trash2, X } from 'lucide-react';
import type { AdminUser } from './api';

export function UserDeleteDialog({
  user,
  busy,
  onClose,
  onSubmit,
}: {
  user: AdminUser;
  busy: boolean;
  onClose: () => void;
  onSubmit: (confirmation: string) => Promise<string | null>;
}) {
  const identity = user.username ?? user.subject;
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
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
      else document.getElementById('admin-users-heading')?.focus();
    };
  }, []);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const close = () => {
    if (!busy && !submitting.current) onClose();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || submitting.current || confirmation.trim() !== identity) return;
    submitting.current = true;
    setError(null);
    try {
      const failure = await onSubmit(confirmation.trim());
      if (failure) setError(failure);
      else onClose();
    } catch {
      setError('사용자를 삭제하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.');
    } finally {
      submitting.current = false;
    }
  };
  return (
    <dialog
      ref={dialogRef}
      className="admin-dialog repository-delete-dialog"
      aria-labelledby="user-delete-title"
      aria-describedby="user-delete-description"
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="dialog-heading">
          <h2 id="user-delete-title">사용자 삭제</h2>
          <button
            className="icon-button"
            type="button"
            aria-label="삭제 취소"
            disabled={busy}
            onClick={close}
          >
            <X size={16} />
          </button>
        </div>
        <div id="user-delete-description" className="repository-delete-description">
          <p>
            <strong>{user.displayName}</strong> (<code>{identity}</code>) 계정을 사용자 목록에서
            삭제하고 모든 로그인 세션과 개별 접근 권한을 해제합니다. 개인 Prompt와 Local 비밀번호도
            제거합니다.
          </p>
          <p>
            기존 개인 Chat 이력은 retention 정책에 따라 보관하며 다른 사용자에게 이전하지 않습니다.
            공동 PR report·분석 설정·audit 기록은 유지합니다.
          </p>
          <p>
            삭제 후에는 이 화면에서 복원하거나 같은 사용자 이름·Subject로 다시 등록할 수 없습니다.
            일시적으로 접근만 막으려면 앱 접근을 차단해 주세요.
          </p>
          {user.identityType !== 'local' ? (
            <p>
              외부 Identity Provider의 원본 계정은 삭제하지 않습니다. 같은 Subject로 다시 로그인해도
              앱 접근은 차단됩니다.
            </p>
          ) : null}
        </div>
        {error ? (
          <div
            className="admin-message error dialog-message"
            role="alert"
            tabIndex={-1}
            ref={errorRef}
          >
            {error}
          </div>
        ) : null}
        <label className="field-label">
          확인을 위해 {identity} 입력
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
            onClick={close}
          >
            취소
          </button>
          <button
            className="command-button danger"
            type="submit"
            disabled={busy || confirmation.trim() !== identity}
          >
            <Trash2 size={14} /> {busy ? '삭제 중…' : '사용자 삭제'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
