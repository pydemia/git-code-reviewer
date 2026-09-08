import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { UserDeleteDialog } from './UserDeleteDialog';
import { UserPanel } from './AdminPage';
import { deleteAdminUser, type AdminUser } from './api';

const user: AdminUser = {
  id: '00000000-0000-4000-8000-000000000001',
  subject: 'local:sample-user',
  username: 'sample-user',
  displayName: '검증 사용자',
  role: 'reviewer',
  identityType: 'local',
  enabled: true,
  groups: [],
  memberships: [],
  repositoryGrants: [],
  createdAt: '',
  updatedAt: '',
};
describe('user deletion UI and API', () => {
  it('explains retained records, identity reservation and confirmation before deletion', () => {
    const html = renderToStaticMarkup(
      <UserDeleteDialog user={user} busy={false} onClose={() => {}} onSubmit={async () => null} />,
    );
    expect(html).toContain('aria-labelledby="user-delete-title"');
    expect(html).toContain('retention');
    expect(html).toContain('같은 사용자 이름·Subject로 다시 등록할 수 없습니다');
    expect(html).toMatch(/type="submit" disabled=""/);
    expect(html).not.toContain('Identity Provider의 원본');
  });
  it('keeps external identity semantics and busy state explicit', () => {
    const html = renderToStaticMarkup(
      <UserDeleteDialog
        user={{ ...user, username: null, identityType: 'external', subject: 'external:subject' }}
        busy
        onClose={() => {}}
        onSubmit={async () => null}
      />,
    );
    expect(html).toContain('external:subject');
    expect(html).toContain('Identity Provider의 원본 계정은 삭제하지 않습니다');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('삭제 중…');
  });
  it('disables self deletion but allows another user to be selected', () => {
    const html = renderToStaticMarkup(
      <UserPanel
        currentUserId={user.id}
        users={[user, { ...user, id: 'other', displayName: '다른 사용자' }]}
        tenants={[]}
        repositories={[]}
        selectedTenantId=""
        search=""
        busyKey={null}
        onSearch={() => {}}
        onTenantChange={() => {}}
        onCreate={() => {}}
        onEdit={() => {}}
        onResetPassword={() => {}}
        onDelete={() => {}}
        onManageRepositories={() => {}}
        onAccessChange={() => {}}
        onMembershipChange={() => {}}
      />,
    );
    expect(html).toMatch(/aria-label="검증 사용자 삭제" disabled=""/);
    expect(html).toMatch(/aria-label="다른 사용자 삭제"/);
    expect(html).not.toMatch(/aria-label="다른 사용자 삭제" disabled/);
  });
  it('sends the typed identity and accepts an empty 204 response', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    try {
      await deleteAdminUser(user.id, 'sample-user');
      expect(fetcher).toHaveBeenCalledWith(
        `/api/v1/admin/users/${user.id}`,
        expect.objectContaining({
          method: 'DELETE',
          body: JSON.stringify({ confirmIdentity: 'sample-user' }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
