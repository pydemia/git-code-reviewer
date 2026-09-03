import { Settings, ShieldCheck } from 'lucide-react';
import type { User } from './api.ts';

type AppHeaderProps = {
  compact?: boolean;
  user?: User | null;
  selectedTenantId?: string;
  onTenantChange?: (tenantId: string) => void;
};

export function AppHeader({
  compact = false,
  user,
  selectedTenantId,
  onTenantChange,
}: AppHeaderProps) {
  const initials = user?.displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

  return (
    <header className="app-header">
      <div className="brand-row">
        <a className="brand" href="/" aria-label="Git Code Reviewer 홈">
          <ShieldCheck size={19} strokeWidth={2.2} />
          <span>Git Code Reviewer</span>
        </a>
        {!compact ? (
          <div className="header-actions">
            {user && user.tenants.length > 0 && onTenantChange ? (
              <label className="tenant-picker">
                <span className="sr-only">Tenant</span>
                <select
                  value={selectedTenantId ?? user.tenants[0]?.id}
                  onChange={(event) => onTenantChange(event.target.value)}
                >
                  {user.tenants.map((tenant) => (
                    <option value={tenant.id} key={tenant.id}>
                      {tenant.displayName}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {user?.role === 'administrator' ? (
              <a className="icon-button" href="/admin" title="관리" aria-label="관리">
                <Settings size={17} />
              </a>
            ) : null}
            <span className="avatar" role="img" aria-label={user?.displayName ?? '사용자'}>
              {initials || '--'}
            </span>
          </div>
        ) : null}
      </div>
    </header>
  );
}
