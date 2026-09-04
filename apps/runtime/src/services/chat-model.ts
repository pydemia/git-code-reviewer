import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../config.js';

// Keep account auth and Codex Responses wire behavior compatible with Demian's provider.
const codexOauthClientId = 'app_EMoamEEZ73f0CkXaXp7hrann';
const defaultCodexBaseUrl = 'https://chatgpt.com/backend-api/codex/';
const defaultRefreshUrl = 'https://auth.openai.com/oauth/token';

export type ChatModelMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type ChatModelRequest = {
  messages: ChatModelMessage[];
  cacheKey: string;
  reasoningEffort?: string;
};

export interface ChatModel {
  readonly name: string;
  generate(request: ChatModelRequest): Promise<string>;
}

type CodexAuthPayload = {
  auth_mode?: string;
  tokens?: {
    id_token?: string | { raw_jwt?: string };
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
  [key: string]: unknown;
};

type CodexCredential = {
  accessToken: string;
  accountId?: string;
  fedramp: boolean;
};

export class ChatModelError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ChatModelError';
  }
}

export function createChatModel(
  config: AppConfig,
  options: { fetch?: typeof fetch } = {},
): ChatModel | null {
  if (config.CHAT_MODEL_MODE === 'disabled' || config.CHAT_MODEL_MODE === 'registry') return null;
  if (config.CHAT_MODEL_MODE === 'openai-compatible') {
    return new OpenAiCompatibleChatModel(config, options.fetch ?? fetch);
  }
  return new ChatGptAccountChatModel(config, options.fetch ?? fetch);
}

class OpenAiCompatibleChatModel implements ChatModel {
  readonly name: string;

  constructor(
    private readonly config: AppConfig,
    private readonly fetcher: typeof fetch,
  ) {
    this.name = config.CHAT_MODEL_NAME!;
  }

  async generate(request: ChatModelRequest): Promise<string> {
    const response = await this.fetcher(
      new URL('chat/completions', ensureTrailingSlash(this.config.CHAT_MODEL_ENDPOINT!)),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.CHAT_MODEL_API_KEY!}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.name,
          temperature: 0,
          messages: request.messages,
        }),
        signal: AbortSignal.timeout(this.config.CHAT_MODEL_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new ChatModelError(
        'provider_request_failed',
        `Chat model failed with HTTP ${response.status}`,
      );
    }
    const value = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = value.choices?.[0]?.message?.content?.trim();
    if (!content)
      throw new ChatModelError('empty_response', 'Chat model returned an empty response');
    return content;
  }
}

export class ChatGptAccountChatModel implements ChatModel {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly auth: CodexAccountAuthStore;
  private installationId?: string;

  constructor(
    private readonly config: AppConfig,
    private readonly fetcher: typeof fetch,
  ) {
    this.name = config.CHAT_MODEL_NAME!;
    this.baseUrl = ensureTrailingSlash(config.CHAT_MODEL_ENDPOINT ?? defaultCodexBaseUrl);
    this.auth = new CodexAccountAuthStore({
      home: resolveCodexHome(config.CHATGPT_ACCOUNT_HOME),
      proactiveRefreshMinutes: config.CHATGPT_ACCOUNT_PROACTIVE_REFRESH_MINUTES,
      refreshUrl: config.CHATGPT_ACCOUNT_REFRESH_ENDPOINT,
      fetch: fetcher,
    });
  }

  async generate(request: ChatModelRequest): Promise<string> {
    this.installationId ??= await loadOrCreateInstallationId(this.auth.home);
    const body = JSON.stringify(toCodexResponsesPayload(this.name, request, this.installationId));
    let response = await this.send(body, this.installationId);
    if (response.status === 401) {
      await response.text().catch(() => '');
      await this.auth.refresh();
      response = await this.send(body, this.installationId);
    }
    if (!response.ok) {
      throw new ChatModelError(
        'provider_request_failed',
        `ChatGPT account model failed with HTTP ${response.status}`,
      );
    }
    return readCodexResponse(response);
  }

  private async send(body: string, installationId: string): Promise<Response> {
    return this.fetcher(new URL('responses', this.baseUrl), {
      method: 'POST',
      headers: {
        ...(await this.auth.requestHeaders(installationId)),
        accept: 'text/event-stream',
        'content-type': 'application/json',
        originator: 'git-code-reviewer',
        'user-agent': 'git-code-reviewer',
      },
      body,
      signal: AbortSignal.timeout(this.config.CHAT_MODEL_TIMEOUT_MS),
    });
  }
}

export class RegisteredChatGptAccountModel implements ChatModel {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly auth: RegisteredCodexAccountAuthStore;

  constructor(options: {
    name: string;
    endpoint?: string | null;
    timeoutMs: number;
    authJson: string;
    installationId: string;
    refreshUrl: string;
    proactiveRefreshMinutes: number;
    persistAuthJson: (authJson: string) => Promise<void>;
    fetch?: typeof fetch;
  }) {
    this.name = options.name;
    this.baseUrl = ensureTrailingSlash(options.endpoint || defaultCodexBaseUrl);
    this.auth = new RegisteredCodexAccountAuthStore(options);
    this.options = options;
  }

  private readonly options: {
    name: string;
    endpoint?: string | null;
    timeoutMs: number;
    authJson: string;
    installationId: string;
    refreshUrl: string;
    proactiveRefreshMinutes: number;
    persistAuthJson: (authJson: string) => Promise<void>;
    fetch?: typeof fetch;
  };

  async generate(request: ChatModelRequest): Promise<string> {
    const body = JSON.stringify(
      toCodexResponsesPayload(this.name, request, this.options.installationId),
    );
    let response = await this.send(body);
    if (response.status === 401) {
      await response.text().catch(() => '');
      await this.auth.refresh();
      response = await this.send(body);
    }
    if (!response.ok) {
      throw new ChatModelError(
        'provider_request_failed',
        `ChatGPT account model failed with HTTP ${response.status}`,
      );
    }
    return readCodexResponse(response);
  }

  private async send(body: string): Promise<Response> {
    return (this.options.fetch ?? fetch)(new URL('responses', this.baseUrl), {
      method: 'POST',
      headers: {
        ...(await this.auth.requestHeaders(this.options.installationId)),
        accept: 'text/event-stream',
        'content-type': 'application/json',
        originator: 'git-code-reviewer',
        'user-agent': 'git-code-reviewer',
      },
      body,
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
  }
}

class RegisteredCodexAccountAuthStore {
  private auth: CodexAuthPayload;
  private refreshPromise: Promise<CodexCredential> | undefined;

  constructor(
    private readonly options: {
      authJson: string;
      refreshUrl: string;
      proactiveRefreshMinutes: number;
      persistAuthJson: (authJson: string) => Promise<void>;
      fetch?: typeof fetch;
    },
  ) {
    this.auth = parseCodexAuthJson(options.authJson);
  }

  async requestHeaders(installationId: string): Promise<Record<string, string>> {
    const credential = needsRefresh(this.auth, this.options.proactiveRefreshMinutes)
      ? await this.refresh()
      : normalizeCredential(this.auth);
    return {
      authorization: `Bearer ${credential.accessToken}`,
      ...(credential.accountId ? { 'ChatGPT-Account-ID': credential.accountId } : {}),
      ...(credential.fedramp ? { 'X-OpenAI-Fedramp': 'true' } : {}),
      'x-codex-installation-id': installationId,
    };
  }

  async refresh(): Promise<CodexCredential> {
    this.refreshPromise ??= this.refreshOnce().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  private async refreshOnce(): Promise<CodexCredential> {
    this.auth = await refreshCodexAuth(
      this.auth,
      this.options.refreshUrl,
      this.options.fetch ?? fetch,
    );
    await this.options.persistAuthJson(JSON.stringify(this.auth));
    return normalizeCredential(this.auth);
  }
}

export function validateChatGptAuthJson(value: string): void {
  normalizeCredential(parseCodexAuthJson(value));
}

export class CodexAccountAuthStore {
  readonly home: string;
  private refreshPromise: Promise<CodexCredential> | undefined;

  constructor(
    private readonly options: {
      home: string;
      proactiveRefreshMinutes: number;
      refreshUrl: string;
      fetch: typeof fetch;
    },
  ) {
    this.home = options.home;
  }

  async credential(): Promise<CodexCredential> {
    const auth = await this.load();
    if (needsRefresh(auth, this.options.proactiveRefreshMinutes)) return this.refresh();
    return normalizeCredential(auth);
  }

  async refresh(): Promise<CodexCredential> {
    this.refreshPromise ??= this.refreshOnce().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  async requestHeaders(installationId: string): Promise<Record<string, string>> {
    const credential = await this.credential();
    return {
      authorization: `Bearer ${credential.accessToken}`,
      ...(credential.accountId ? { 'ChatGPT-Account-ID': credential.accountId } : {}),
      ...(credential.fedramp ? { 'X-OpenAI-Fedramp': 'true' } : {}),
      'x-codex-installation-id': installationId,
    };
  }

  private async refreshOnce(): Promise<CodexCredential> {
    const auth = await this.load();
    const refreshToken = auth.tokens?.refresh_token;
    if (!refreshToken) {
      throw new ChatModelError(
        'refresh_unavailable',
        'ChatGPT account does not include a refresh token. Run `codex login` again.',
      );
    }
    const response = await this.options.fetch(this.options.refreshUrl || defaultRefreshUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: codexOauthClientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    const responseText = await response.text();
    if (!response.ok) {
      if (response.status === 401 && refreshTokenReused(responseText)) {
        const reloaded = await this.load();
        if (reloaded.tokens?.refresh_token !== refreshToken) return normalizeCredential(reloaded);
      }
      throw new ChatModelError(
        'refresh_failed',
        `ChatGPT account token refresh failed with HTTP ${response.status}. Run \`codex login\` again.`,
      );
    }

    const refreshed = parseRefreshResponse(responseText);
    const updated: CodexAuthPayload = {
      ...auth,
      tokens: {
        ...(auth.tokens ?? {}),
        ...(refreshed.id_token ? { id_token: refreshed.id_token } : {}),
        ...(refreshed.access_token ? { access_token: refreshed.access_token } : {}),
        ...(refreshed.refresh_token ? { refresh_token: refreshed.refresh_token } : {}),
      },
      last_refresh: new Date().toISOString(),
    };
    await writeAuthFileAtomic(this.home, updated);
    return normalizeCredential(updated);
  }

  private async load(): Promise<CodexAuthPayload> {
    try {
      return JSON.parse(
        await readFile(path.join(this.home, 'auth.json'), 'utf8'),
      ) as CodexAuthPayload;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        throw new ChatModelError(
          'missing_auth',
          'ChatGPT account is not connected. Run `codex login` and provision its auth.json.',
        );
      }
      if (error instanceof SyntaxError) {
        throw new ChatModelError('invalid_auth', 'ChatGPT account auth.json is invalid.');
      }
      throw error;
    }
  }
}

function toCodexResponsesPayload(
  model: string,
  request: ChatModelRequest,
  installationId: string,
): Record<string, unknown> {
  const instructions = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const input = request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      type: 'message',
      role: message.role,
      content: [
        {
          type: message.role === 'assistant' ? 'output_text' : 'input_text',
          text: message.content,
        },
      ],
    }));
  return {
    model,
    instructions,
    input,
    stream: true,
    store: false,
    parallel_tool_calls: false,
    reasoning: { effort: request.reasoningEffort ?? 'medium', summary: 'auto' },
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: request.cacheKey,
    client_metadata: { 'x-codex-installation-id': installationId },
  };
}

async function readCodexResponse(response: Response): Promise<string> {
  if (!response.body)
    throw new ChatModelError('empty_response', 'ChatGPT account returned no body');
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let fallbackContent = '';
  let completed = false;

  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    consumeFrames(false);
  }
  buffer += decoder.decode();
  consumeFrames(true);
  const result = (content || fallbackContent).trim();
  if (!completed) {
    throw new ChatModelError(
      'stream_disconnected',
      'ChatGPT account response ended before completion',
    );
  }
  if (!result)
    throw new ChatModelError('empty_response', 'ChatGPT account returned an empty response');
  return result;

  function consumeFrames(final: boolean) {
    while (true) {
      const boundary = /\r?\n\r?\n/.exec(buffer);
      if (!boundary) break;
      consumeFrame(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index + boundary[0].length);
    }
    if (final && buffer.trim()) {
      consumeFrame(buffer);
      buffer = '';
    }
  }

  function consumeFrame(frame: string) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');
    if (!data) return;
    if (data === '[DONE]') {
      completed = true;
      return;
    }
    const event = JSON.parse(data) as {
      type?: string;
      delta?: string;
      item?: { type?: string; content?: Array<{ type?: string; text?: string }> };
      response?: { error?: { code?: string }; incomplete_details?: { reason?: string } };
    };
    if (event.type === 'response.output_text.delta') content += event.delta ?? '';
    if (event.type === 'response.output_item.done' && event.item?.type === 'message') {
      fallbackContent = (event.item.content ?? [])
        .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
        .map((item) => item.text)
        .join('');
    }
    if (event.type === 'response.completed') completed = true;
    if (event.type === 'response.failed' || event.type === 'response.incomplete') {
      throw new ChatModelError(
        'provider_response_failed',
        `ChatGPT account response failed: ${event.response?.error?.code ?? event.response?.incomplete_details?.reason ?? 'unknown'}`,
      );
    }
  }
}

function normalizeCredential(auth: CodexAuthPayload): CodexCredential {
  const mode = (auth.auth_mode ?? '').replace(/[-_]/g, '').toLowerCase();
  if (mode !== 'chatgpt' && mode !== 'chatgptauthtokens') {
    throw new ChatModelError(
      'unsupported_auth',
      'Codex auth.json must contain a ChatGPT account login.',
    );
  }
  const accessToken = auth.tokens?.access_token;
  if (!accessToken) {
    throw new ChatModelError('missing_auth', 'Codex auth.json has no ChatGPT access token.');
  }
  const idClaims = decodeJwt(rawIdToken(auth.tokens?.id_token));
  const accessClaims = decodeJwt(accessToken);
  const idAuth = nestedAuthClaims(idClaims);
  const accessAuth = nestedAuthClaims(accessClaims);
  const accountId =
    auth.tokens?.account_id ??
    stringValue(idAuth.chatgpt_account_id) ??
    stringValue(accessAuth.chatgpt_account_id);
  return {
    accessToken,
    ...(accountId ? { accountId } : {}),
    fedramp:
      idAuth.chatgpt_account_is_fedramp === true || accessAuth.chatgpt_account_is_fedramp === true,
  };
}

function needsRefresh(auth: CodexAuthPayload, proactiveRefreshMinutes: number): boolean {
  const accessToken = auth.tokens?.access_token;
  const expiration = accessToken ? decodeJwt(accessToken).exp : undefined;
  if (
    typeof expiration === 'number' &&
    expiration * 1_000 - Date.now() <= proactiveRefreshMinutes * 60_000
  ) {
    return true;
  }
  const lastRefresh = auth.last_refresh ? Date.parse(auth.last_refresh) : Number.NaN;
  return Number.isFinite(lastRefresh) && Date.now() - lastRefresh > 8 * 60 * 60 * 1_000;
}

function parseRefreshResponse(value: string): {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
} {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const idToken = stringValue(parsed.id_token);
    const accessToken = stringValue(parsed.access_token);
    const refreshToken = stringValue(parsed.refresh_token);
    return {
      ...(idToken ? { id_token: idToken } : {}),
      ...(accessToken ? { access_token: accessToken } : {}),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    };
  } catch {
    throw new ChatModelError('refresh_failed', 'ChatGPT account token refresh was invalid.');
  }
}

function parseCodexAuthJson(value: string): CodexAuthPayload {
  try {
    return JSON.parse(value) as CodexAuthPayload;
  } catch {
    throw new ChatModelError('invalid_auth', 'ChatGPT account auth.json is invalid.');
  }
}

async function refreshCodexAuth(
  auth: CodexAuthPayload,
  refreshUrl: string,
  fetcher: typeof fetch,
): Promise<CodexAuthPayload> {
  const refreshToken = auth.tokens?.refresh_token;
  if (!refreshToken) {
    throw new ChatModelError('refresh_unavailable', 'ChatGPT account has no refresh token.');
  }
  const response = await fetcher(refreshUrl || defaultRefreshUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: codexOauthClientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new ChatModelError(
      'refresh_failed',
      `ChatGPT account token refresh failed with HTTP ${response.status}.`,
    );
  }
  const refreshed = parseRefreshResponse(responseText);
  return {
    ...auth,
    tokens: {
      ...(auth.tokens ?? {}),
      ...(refreshed.id_token ? { id_token: refreshed.id_token } : {}),
      ...(refreshed.access_token ? { access_token: refreshed.access_token } : {}),
      ...(refreshed.refresh_token ? { refresh_token: refreshed.refresh_token } : {}),
    },
    last_refresh: new Date().toISOString(),
  };
}

function refreshTokenReused(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as { code?: unknown; error?: unknown };
    const code =
      stringValue(parsed.code) ??
      stringValue(parsed.error) ??
      (parsed.error && typeof parsed.error === 'object'
        ? stringValue((parsed.error as { code?: unknown }).code)
        : undefined);
    return code?.toLowerCase() === 'refresh_token_reused';
  } catch {
    return false;
  }
}

function rawIdToken(value: string | { raw_jwt?: string } | undefined) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'raw_jwt' in value) {
    return stringValue((value as { raw_jwt?: unknown }).raw_jwt);
  }
  return undefined;
}

function decodeJwt(value: string | undefined): Record<string, unknown> {
  const payload = value?.split('.')[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function nestedAuthClaims(claims: Record<string, unknown>): Record<string, unknown> {
  const nested = claims['https://api.openai.com/auth'];
  return nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : claims;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function resolveCodexHome(configured: string | undefined): string {
  const value = configured || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

async function loadOrCreateInstallationId(home: string): Promise<string> {
  const file = path.join(home, 'installation_id');
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)
    ) {
      return existing;
    }
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
  const id = randomUUID();
  await mkdir(home, { recursive: true });
  try {
    await writeFile(file, `${id}\n`, { mode: 0o600, flag: 'wx' });
    return id;
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
    return (await readFile(file, 'utf8')).trim();
  }
}

async function writeAuthFileAtomic(home: string, auth: CodexAuthPayload): Promise<void> {
  await mkdir(home, { recursive: true });
  const file = path.join(home, 'auth.json');
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
