import { describe, expect, it, vi } from 'vitest';
import { discoverChatAccountModels } from './chat-model.js';

const authJson = JSON.stringify({
  auth_mode: 'chatgpt',
  tokens: {
    access_token: 'synthetic-access',
    account_id: 'synthetic-account',
    refresh_token: 'synthetic-refresh',
  },
});
const options = { clientVersion: '0.153.0', allowedEfforts: ['low', 'medium', 'high', 'xhigh'] };
const model = {
  slug: 'model-from-api',
  display_name: 'API Model',
  visibility: 'list',
  supported_reasoning_levels: [
    { effort: 'medium' },
    { effort: 'high' },
    { effort: 'future-effort' },
  ],
  default_reasoning_level: 'high',
};

describe('ChatGPT model discovery', () => {
  it('fetches the account catalog and returns only selectable, supported metadata', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        models: [
          model,
          model,
          { ...model, slug: 'hidden', visibility: 'hide' },
          {
            ...model,
            slug: 'unsupported',
            supported_reasoning_levels: [{ effort: 'future-effort' }],
          },
        ],
      }),
    );
    const items = await discoverChatAccountModels(authJson, { ...options, fetch: fetcher });
    expect(items).toEqual([
      {
        id: 'model-from-api',
        displayName: 'API Model',
        allowedEfforts: ['medium', 'high'],
        defaultEffort: 'high',
      },
    ]);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.153.0');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-access');
    expect(new Headers(init?.headers).get('ChatGPT-Account-ID')).toBe('synthetic-account');
    expect(init?.redirect).toBe('error');
    expect(init?.body).toBeUndefined();
    expect(JSON.stringify(items)).not.toContain('synthetic');
  });

  it.each([401, 403, 429, 500])(
    'handles HTTP %s without exposing upstream bodies or refreshing draft credentials',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('synthetic-access secret error', { status }));
      let error: unknown;
      try {
        await discoverChatAccountModels(authJson, { ...options, fetch: fetcher });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ statusCode: 502 });
      expect(String(error)).not.toContain('synthetic-access');
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it('rejects invalid credentials before any network request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      discoverChatAccountModels('{}', { ...options, fetch: fetcher }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports malformed catalog and network failures concisely', async () => {
    for (const fetcher of [
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ models: 'bad' })),
      vi.fn<typeof fetch>().mockRejectedValue(new Error('private network details')),
    ]) {
      await expect(
        discoverChatAccountModels(authJson, { ...options, fetch: fetcher }),
      ).rejects.toMatchObject({ statusCode: 502 });
    }
  });
});
