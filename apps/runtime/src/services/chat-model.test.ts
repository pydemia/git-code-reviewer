import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { ChatModelError, RegisteredChatGptAccountModel, createChatModel } from './chat-model.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('ChatGPT account chat model', () => {
  it('uses the model and reasoning effort selected for a registered account', async () => {
    const accessToken = jwt({ exp: Math.floor(Date.now() / 1_000) + 3_600 });
    let capturedBody: Record<string, unknown> = {};
    const model = new RegisteredChatGptAccountModel({
      name: 'gpt-selected',
      endpoint: 'https://chatgpt.example.test/backend-api/codex/',
      timeoutMs: 10_000,
      authJson: JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: accessToken, refresh_token: 'refresh-secret' },
        last_refresh: new Date().toISOString(),
      }),
      installationId: '71ca4ebc-44ae-4f98-a84e-4f4fb5ea4138',
      refreshUrl: 'https://auth.example.test/oauth/token',
      proactiveRefreshMinutes: 5,
      persistAuthJson: async () => undefined,
      fetch: mockFetch(async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return codexStream('선택 적용');
      }),
    });

    await expect(
      model.generate({
        cacheKey: 'session-selected',
        reasoningEffort: 'high',
        messages: [{ role: 'user', content: '검토해 줘' }],
      }),
    ).resolves.toBe('선택 적용');
    expect(capturedBody).toMatchObject({
      model: 'gpt-selected',
      reasoning: { effort: 'high', summary: 'auto' },
    });
  });

  it('uses Codex account headers and converts messages to a Responses request', async () => {
    const home = await codexHome({
      accessToken: jwt({
        exp: Math.floor(Date.now() / 1_000) + 3_600,
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct_test',
          chatgpt_account_is_fedramp: true,
        },
      }),
      refreshToken: 'refresh-secret',
    });
    let capturedUrl = '';
    let capturedHeaders = new Headers();
    let capturedBody: Record<string, unknown> = {};
    const fetcher = mockFetch(async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init?.headers);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return codexStream('검토 답변');
    });
    const model = createChatModel(accountConfig(home), { fetch: fetcher });

    const result = await model!.generate({
      cacheKey: 'session-1',
      messages: [
        { role: 'system', content: 'Use report evidence.' },
        { role: 'user', content: 'report context' },
        { role: 'assistant', content: 'previous answer' },
        { role: 'user', content: 'explain it' },
      ],
    });

    expect(result).toBe('검토 답변');
    expect(capturedUrl).toBe('https://chatgpt.example.test/backend-api/codex/responses');
    expect(capturedHeaders.get('authorization')).toMatch(/^Bearer /);
    expect(capturedHeaders.get('chatgpt-account-id')).toBe('acct_test');
    expect(capturedHeaders.get('x-openai-fedramp')).toBe('true');
    expect(capturedHeaders.get('x-codex-installation-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(capturedHeaders.get('originator')).toBe('git-code-reviewer');
    expect(capturedBody).toMatchObject({
      model: 'gpt-test',
      instructions: 'Use report evidence.',
      stream: true,
      store: false,
      prompt_cache_key: 'session-1',
      reasoning: { effort: 'medium', summary: 'auto' },
    });
    expect(capturedBody.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'report context' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'previous answer' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'explain it' }],
      },
    ]);
  });

  it('refreshes an expired account token and persists rotated credentials', async () => {
    const expiredToken = jwt({ exp: Math.floor(Date.now() / 1_000) - 60 });
    const freshToken = jwt({ exp: Math.floor(Date.now() / 1_000) + 3_600 });
    const home = await codexHome({
      accessToken: expiredToken,
      refreshToken: 'old-refresh',
    });
    const calls: string[] = [];
    const fetcher = mockFetch(async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://auth.example.test/oauth/token') {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          grant_type: 'refresh_token',
          refresh_token: 'old-refresh',
        });
        return Response.json({
          access_token: freshToken,
          id_token: freshToken,
          refresh_token: 'new-refresh',
        });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${freshToken}`);
      return codexStream('fresh response');
    });
    const model = createChatModel(
      accountConfig(home, {
        CHATGPT_ACCOUNT_REFRESH_ENDPOINT: 'https://auth.example.test/oauth/token',
      }),
      { fetch: fetcher },
    );

    await expect(
      model!.generate({ cacheKey: 'session-2', messages: [{ role: 'user', content: 'hi' }] }),
    ).resolves.toBe('fresh response');

    expect(calls).toEqual([
      'https://auth.example.test/oauth/token',
      'https://chatgpt.example.test/backend-api/codex/responses',
    ]);
    const persisted = JSON.parse(await readFile(path.join(home, 'auth.json'), 'utf8')) as {
      tokens: { access_token: string; refresh_token: string };
    };
    expect(persisted.tokens.access_token).toBe(freshToken);
    expect(persisted.tokens.refresh_token).toBe('new-refresh');
  });

  it('refreshes once after an unauthorized provider response', async () => {
    const firstToken = jwt({ exp: Math.floor(Date.now() / 1_000) + 3_600 });
    const secondToken = jwt({ exp: Math.floor(Date.now() / 1_000) + 7_200 });
    const home = await codexHome({ accessToken: firstToken, refreshToken: 'first-refresh' });
    const authorization: string[] = [];
    let providerCalls = 0;
    const fetcher = mockFetch(async (input, init) => {
      const url = String(input);
      if (url === 'https://auth.example.test/oauth/token') {
        return Response.json({
          access_token: secondToken,
          id_token: secondToken,
          refresh_token: 'second-refresh',
        });
      }
      providerCalls += 1;
      authorization.push(new Headers(init?.headers).get('authorization') ?? '');
      return providerCalls === 1 ? new Response('', { status: 401 }) : codexStream('retried');
    });
    const model = createChatModel(
      accountConfig(home, {
        CHATGPT_ACCOUNT_REFRESH_ENDPOINT: 'https://auth.example.test/oauth/token',
      }),
      { fetch: fetcher },
    );

    await expect(
      model!.generate({ cacheKey: 'session-3', messages: [{ role: 'user', content: 'hi' }] }),
    ).resolves.toBe('retried');
    expect(authorization).toEqual([`Bearer ${firstToken}`, `Bearer ${secondToken}`]);
  });

  it('reports missing account auth without exposing a filesystem path', async () => {
    const home = await temporaryDirectory();
    const model = createChatModel(accountConfig(home), {
      fetch: mockFetch(async () => codexStream('unused')),
    });

    await expect(
      model!.generate({ cacheKey: 'session-4', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject<Partial<ChatModelError>>({ code: 'missing_auth' });
    await model!
      .generate({ cacheKey: 'session-4', messages: [{ role: 'user', content: 'hi' }] })
      .catch((error: unknown) => expect(String(error)).not.toContain(home));
  });
});

function accountConfig(home: string, overrides: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: 'postgresql://example.invalid/reviewer',
    CHAT_MODEL_MODE: 'chatgpt-account',
    CHAT_MODEL_ENDPOINT: 'https://chatgpt.example.test/backend-api/codex/',
    CHAT_MODEL_NAME: 'gpt-test',
    CHATGPT_ACCOUNT_HOME: home,
    ...overrides,
  });
}

async function codexHome(options: { accessToken: string; refreshToken: string }) {
  const home = await temporaryDirectory();
  await writeFile(
    path.join(home, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: options.accessToken,
        access_token: options.accessToken,
        refresh_token: options.refreshToken,
      },
      last_refresh: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  return home;
}

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gcr-chatgpt-account-'));
  temporaryDirectories.push(directory);
  return directory;
}

function codexStream(content: string) {
  return new Response(
    [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: content })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'response-1' } })}\n\n`,
    ].join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function jwt(payload: Record<string, unknown>) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function mockFetch(handler: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>) {
  return handler as typeof fetch;
}
