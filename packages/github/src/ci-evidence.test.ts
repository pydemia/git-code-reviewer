import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GitHubAccessTokenClient } from './index.js';
const target = {
  apiBaseUrl: 'https://github.example/api/v3/',
  owner: 'team',
  name: 'repo',
  installationId: '1',
};
const head = 'a'.repeat(40),
  name = 'Signed evidence';
const check = {
  id: 1,
  name,
  head_sha: head,
  app: { id: 2 },
  status: 'completed',
  conclusion: 'success',
  output: { text: '{}' },
};
describe('GitHub CI reads', () => {
  it('uses authenticated bounded GETs with explicit ref, name, pagination and no redirects', async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const client = new GitHubAccessTokenClient('synthetic-token', async (url, init) => {
      calls.push({ url: new URL(String(url)), init: init! });
      return Response.json({ total_count: 1, check_runs: [check] });
    });
    expect(await client.listValidationChecks(target, head, name)).toEqual([check]);
    expect(calls[0]!.url.pathname).toBe(`/api/v3/repos/team/repo/commits/${head}/check-runs`);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      check_name: name,
      filter: 'all',
      per_page: '100',
      page: '1',
    });
    expect(calls[0]!.init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(calls[0]!.init.signal).toBeDefined();
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer synthetic-token');
  });
  it.each([401, 403, 404, 429, 500, 302])('refuses status %s', async (status) => {
    const client = new GitHubAccessTokenClient(
      'synthetic',
      async () => new Response(null, { status }),
    );
    await expect(client.listValidationChecks(target, head, name)).rejects.toThrow();
  });
  it.each([
    { total_count: 2, check_runs: [check] },
    { total_count: 2, check_runs: [check, check] },
  ])('rejects truncated or duplicate discovery', async (value) => {
    const client = new GitHubAccessTokenClient('synthetic', async () => Response.json(value));
    await expect(client.listValidationChecks(target, head, name)).rejects.toThrow();
  });
  it('caps response bytes and rejects invalid UTF-8', async () => {
    for (const bytes of [' '.repeat(2 * 1024 * 1024 + 1), new Uint8Array([0xff])]) {
      const client = new GitHubAccessTokenClient('synthetic', async () => new Response(bytes));
      await expect(client.listValidationChecks(target, head, name)).rejects.toThrow();
    }
  });
  it('hashes exact workflow bytes at the requested commit and rejects noncanonical encoding', async () => {
    const bytes = Buffer.from('name: owned\non: pull_request\n'),
      workflow = '.github/workflows/review.yml';
    const fetch = vi.fn(async () =>
      Response.json({
        type: 'file',
        path: workflow,
        encoding: 'base64',
        content: bytes.toString('base64') + '\n',
        size: bytes.length,
      }),
    );
    const client = new GitHubAccessTokenClient('synthetic', fetch);
    expect(await client.readValidationWorkflowHash(target, head, workflow)).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.searchParams.get('ref')).toBe(head);
    fetch.mockImplementation(async () =>
      Response.json({
        type: 'file',
        path: workflow,
        encoding: 'base64',
        content: '!' + bytes.toString('base64'),
        size: bytes.length,
      }),
    );
    await expect(client.readValidationWorkflowHash(target, head, workflow)).rejects.toThrow(
      'encoding',
    );
  });
  it('refuses unbounded run attempts and workflow path traversal before network access', async () => {
    const fetch = vi.fn(),
      client = new GitHubAccessTokenClient('synthetic', fetch);
    await expect(client.readValidationRun(target, '1', 1001)).rejects.toThrow();
    await expect(
      client.readValidationWorkflowHash(target, head, '.github/workflows/../secrets'),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
