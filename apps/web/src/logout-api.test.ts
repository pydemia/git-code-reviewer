import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { logout } from './api.ts';

const assign = vi.fn(),
  request = vi.fn<typeof fetch>();
beforeEach(() => {
  assign.mockReset();
  request.mockReset();
  vi.stubGlobal('window', { location: { assign } });
  vi.stubGlobal('fetch', request);
});
afterEach(() => vi.unstubAllGlobals());
it('navigates the browser to the server-issued HTTPS IdP logout URL', async () => {
  const redirectTo = 'https://idp.test/saml?SAMLRequest=synthetic&RelayState=synthetic';
  request.mockResolvedValue(Response.json({ redirectTo }));
  await logout();
  expect(request).toHaveBeenCalledWith('/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
  });
  expect(assign).toHaveBeenCalledWith(redirectTo);
});
it.each([204, 401])('returns to login after local logout status %s', async (status) => {
  request.mockResolvedValue(new Response(null, { status }));
  await logout();
  expect(assign).toHaveBeenCalledWith('/login');
});
it.each([
  'http://idp.test/saml',
  'javascript:alert(1)',
  'https://secret:password@idp.test/saml',
  '/relative',
])('does not navigate to an unsafe logout URL %s', async (redirectTo) => {
  request.mockResolvedValue(Response.json({ redirectTo }));
  await logout();
  expect(assign).toHaveBeenCalledWith('/login?logoutFailed=1');
});
it('preserves uncertainty after a transport failure instead of claiming logout success', async () => {
  request.mockRejectedValue(Error('synthetic network failure'));
  await logout();
  expect(assign).toHaveBeenCalledWith('/login?logoutFailed=1');
});
it.each([
  Response.json(
    { error: { code: 'IDENTITY_UNAVAILABLE', message: 'unavailable' } },
    { status: 503 },
  ),
  Response.json({}),
])('handles a failed or malformed response visibly', async (response) => {
  request.mockResolvedValue(response);
  await logout();
  expect(assign).toHaveBeenCalledWith('/login?logoutFailed=1');
});
