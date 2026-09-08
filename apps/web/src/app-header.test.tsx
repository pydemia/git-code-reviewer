import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppHeader } from './AppHeader.tsx';
import type { User } from './api.ts';

const administrator: User = {
  schemaVersion: 1,
  id: 'user',
  subject: 'local:user',
  displayName: 'Test Admin',
  role: 'administrator',
  enabled: true,
  tenants: [],
};

beforeEach(() => {
  vi.stubGlobal('window', { location: { pathname: '/reviews/repository/42' } });
});
afterEach(() => vi.unstubAllGlobals());

it.each([false, true])('keeps administrator actions in the GNB (compact=%s)', (compact) => {
  const html = renderToStaticMarkup(<AppHeader compact={compact} user={administrator} />);
  expect(html).toContain('href="/admin" title="관리" aria-label="관리"');
  expect(html).toContain('href="/guide"');
  expect(html).toContain('href="/profile"');
  expect(html).toContain('aria-label="로그아웃"');
  expect(html.indexOf('href="/admin"')).toBeLessThan(html.indexOf('href="/guide"'));
});

it.each([false, true])(
  'does not expose administrator settings to reviewers (compact=%s)',
  (compact) => {
    const html = renderToStaticMarkup(
      <AppHeader compact={compact} user={{ ...administrator, role: 'reviewer' }} />,
    );
    expect(html).not.toContain('href="/admin"');
    expect(html).toContain('href="/guide"');
    expect(html).toContain('href="/profile"');
  },
);

it.each([false, true])(
  'does not expose settings without a signed-in user (compact=%s)',
  (compact) => {
    expect(renderToStaticMarkup(<AppHeader compact={compact} />)).not.toContain('href="/admin"');
  },
);

it('renders identical administrator GNB actions on worklist and reviews', () => {
  const review = renderToStaticMarkup(<AppHeader compact user={administrator} />);
  vi.stubGlobal('window', { location: { pathname: '/' } });
  expect(review).toBe(renderToStaticMarkup(<AppHeader user={administrator} />));
});

it('keeps tenant switching out of a revision-bound compact review header', () => {
  const user = {
    ...administrator,
    tenants: [{ id: 'tenant', slug: 'tenant', displayName: 'Test tenant' }],
  };
  expect(renderToStaticMarkup(<AppHeader user={user} onTenantChange={() => {}} />)).toContain(
    'tenant-picker',
  );
  const compact = renderToStaticMarkup(<AppHeader compact user={user} onTenantChange={() => {}} />);
  expect(compact).not.toContain('tenant-picker');
  expect(compact).toContain('href="/admin"');
});
