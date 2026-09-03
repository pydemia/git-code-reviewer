import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { OpenAICompatibleReviewModel, type ReviewModel } from '@gcr/analysis-engine';
import type { Database } from '@gcr/db';
import type { AppConfig } from '../config.js';
import { providerAllowedOrigins } from '../config.js';

const credentialAad = Buffer.from('git-code-reviewer:analysis-provider:v1', 'utf8');

export type AnalysisProviderMode = 'disabled' | 'openai-compatible';

export type AnalysisProviderRow = {
  id: string;
  version: number;
  mode: AnalysisProviderMode;
  endpoint: string | null;
  modelName: string | null;
  timeoutMs: number;
  credentialCiphertext: Buffer | null;
  credentialIv: Buffer | null;
  credentialAuthTag: Buffer | null;
  configurationHash: string;
  active: boolean;
  createdBySubject: string;
  createdByName: string;
  activatedBySubject: string | null;
  activatedByName: string | null;
  activatedAt: Date | string | null;
  createdAt: Date | string;
};

export type AnalysisProviderInput = {
  mode: AnalysisProviderMode;
  endpoint?: string | undefined;
  modelName?: string | undefined;
  timeoutMs: number;
  apiKey?: string | undefined;
};

export type PreparedAnalysisProvider = {
  mode: AnalysisProviderMode;
  endpoint: string | null;
  modelName: string | null;
  timeoutMs: number;
  credentialCiphertext: Buffer | null;
  credentialIv: Buffer | null;
  credentialAuthTag: Buffer | null;
  configurationHash: string;
};

export type ResolvedAnalysisProvider = {
  source: 'administration' | 'deployment';
  versionId: string | null;
  version: number | null;
  mode: AnalysisProviderMode;
  endpoint: string | null;
  modelName: string | null;
  timeoutMs: number;
  apiKey: string | null;
  configurationHash: string;
  profile: string;
};

export const analysisProviderColumns = `
  provider.id, provider.version, provider.mode, provider.endpoint,
  provider.model_name as "modelName", provider.timeout_ms as "timeoutMs",
  provider.credential_ciphertext as "credentialCiphertext",
  provider.credential_iv as "credentialIv",
  provider.credential_auth_tag as "credentialAuthTag",
  provider.configuration_hash as "configurationHash", provider.active,
  creator.oidc_subject as "createdBySubject", creator.display_name as "createdByName",
  activator.oidc_subject as "activatedBySubject", activator.display_name as "activatedByName",
  provider.activated_at as "activatedAt", provider.created_at as "createdAt"`;

export async function listAnalysisProviderRows(database: Pick<Database, 'query'>) {
  return database.query<AnalysisProviderRow>(
    `select ${analysisProviderColumns}
     from analysis_provider_versions provider
     join users creator on creator.id = provider.created_by
     left join users activator on activator.id = provider.activated_by
     order by provider.version desc`,
  );
}

export async function getActiveAnalysisProviderRow(database: Pick<Database, 'query'>) {
  const result = await database.query<AnalysisProviderRow>(
    `select ${analysisProviderColumns}
     from analysis_provider_versions provider
     join users creator on creator.id = provider.created_by
     left join users activator on activator.id = provider.activated_by
     where provider.active limit 1`,
  );
  return result.rows[0] ?? null;
}

export async function getAnalysisProviderRow(
  database: Pick<Database, 'query'>,
  providerId: string,
) {
  const result = await database.query<AnalysisProviderRow>(
    `select ${analysisProviderColumns}
     from analysis_provider_versions provider
     join users creator on creator.id = provider.created_by
     left join users activator on activator.id = provider.activated_by
     where provider.id = $1`,
    [providerId],
  );
  return result.rows[0] ?? null;
}

export function prepareAnalysisProvider(
  input: AnalysisProviderInput,
  config: AppConfig,
  reusableCredential?: string,
): PreparedAnalysisProvider {
  if (!config.MODEL_ADMIN_ENABLED) {
    throw new AnalysisProviderConfigurationError('Provider 관리자 설정이 비활성화되어 있습니다.');
  }
  if (input.mode === 'disabled') {
    return {
      mode: 'disabled',
      endpoint: null,
      modelName: null,
      timeoutMs: input.timeoutMs,
      credentialCiphertext: null,
      credentialIv: null,
      credentialAuthTag: null,
      configurationHash: hashProviderConfiguration({
        mode: 'disabled',
        endpoint: null,
        modelName: null,
        timeoutMs: input.timeoutMs,
        apiKey: null,
      }),
    };
  }

  const endpoint = normalizeAllowedEndpoint(input.endpoint, config);
  const modelName = input.modelName?.trim();
  if (!modelName) throw new AnalysisProviderConfigurationError('Model 이름이 필요합니다.');
  const apiKey = input.apiKey?.trim() || reusableCredential;
  if (!apiKey) throw new AnalysisProviderConfigurationError('새 API key가 필요합니다.');
  const encrypted = encryptProviderCredential(apiKey, config.MODEL_CREDENTIAL_ENCRYPTION_KEY);
  return {
    mode: 'openai-compatible',
    endpoint,
    modelName,
    timeoutMs: input.timeoutMs,
    ...encrypted,
    configurationHash: hashProviderConfiguration({
      mode: 'openai-compatible',
      endpoint,
      modelName,
      timeoutMs: input.timeoutMs,
      apiKey,
    }),
  };
}

export function reusableProviderCredential(row: AnalysisProviderRow | null, config: AppConfig) {
  if (!row || row.mode !== 'openai-compatible') return undefined;
  return decryptProviderCredential(row, config.MODEL_CREDENTIAL_ENCRYPTION_KEY);
}

export async function resolveAnalysisProvider(
  database: Pick<Database, 'query'>,
  config: AppConfig,
  versionId: string | null,
): Promise<ResolvedAnalysisProvider> {
  if (!versionId) return deploymentAnalysisProvider(config);
  const result = await database.query<AnalysisProviderRow>(
    `select ${analysisProviderColumns}
     from analysis_provider_versions provider
     join users creator on creator.id = provider.created_by
     left join users activator on activator.id = provider.activated_by
     where provider.id = $1`,
    [versionId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Bound analysis provider version is unavailable');
  const apiKey =
    row.mode === 'openai-compatible'
      ? decryptProviderCredential(row, config.MODEL_CREDENTIAL_ENCRYPTION_KEY)
      : null;
  return {
    source: 'administration',
    versionId: row.id,
    version: row.version,
    mode: row.mode,
    endpoint: row.endpoint,
    modelName: row.modelName,
    timeoutMs: row.timeoutMs,
    apiKey,
    configurationHash: row.configurationHash,
    profile: providerProfile(row.mode, row.modelName),
  };
}

export function deploymentAnalysisProvider(config: AppConfig): ResolvedAnalysisProvider {
  const endpoint = config.MODEL_ENDPOINT ? ensureTrailingSlash(config.MODEL_ENDPOINT) : null;
  const modelName = config.MODEL_NAME?.trim() || null;
  const apiKey = config.MODEL_API_KEY?.trim() || null;
  return {
    source: 'deployment',
    versionId: null,
    version: null,
    mode: config.MODEL_MODE,
    endpoint,
    modelName,
    timeoutMs: config.MODEL_TIMEOUT_MS,
    apiKey,
    configurationHash: hashProviderConfiguration({
      mode: config.MODEL_MODE,
      endpoint,
      modelName,
      timeoutMs: config.MODEL_TIMEOUT_MS,
      apiKey,
    }),
    profile: providerProfile(config.MODEL_MODE, modelName),
  };
}

export function createReviewModel(provider: ResolvedAnalysisProvider): ReviewModel | undefined {
  if (provider.mode === 'disabled') return undefined;
  if (!provider.endpoint || !provider.modelName || !provider.apiKey) {
    throw new Error('Analysis provider credential is unavailable');
  }
  return new OpenAICompatibleReviewModel(
    provider.endpoint,
    provider.apiKey,
    provider.modelName,
    provider.timeoutMs,
  );
}

export async function testAnalysisProvider(
  provider: ResolvedAnalysisProvider,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  if (
    provider.mode !== 'openai-compatible' ||
    !provider.endpoint ||
    !provider.modelName ||
    !provider.apiKey
  ) {
    throw new AnalysisProviderConfigurationError('테스트할 Provider 설정이 없습니다.');
  }
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetcher(new URL('chat/completions', provider.endpoint), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: provider.modelName,
        temperature: 0,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
      }),
      signal: AbortSignal.timeout(provider.timeoutMs),
    });
  } catch {
    throw new AnalysisProviderConfigurationError('Provider에 연결할 수 없습니다.');
  }
  if (!response.ok) {
    throw new AnalysisProviderConfigurationError(
      `Provider 연결 테스트가 HTTP ${response.status}로 실패했습니다.`,
    );
  }
  return Math.max(0, Math.round(performance.now() - startedAt));
}

export function analysisProviderView(row: AnalysisProviderRow) {
  return {
    id: row.id,
    version: row.version,
    mode: row.mode,
    endpoint: row.endpoint,
    modelName: row.modelName,
    timeoutMs: row.timeoutMs,
    apiKeyConfigured: row.credentialCiphertext !== null,
    configurationHash: row.configurationHash,
    active: row.active,
    createdBy: { subject: row.createdBySubject, displayName: row.createdByName },
    activatedBy:
      row.activatedBySubject && row.activatedByName
        ? { subject: row.activatedBySubject, displayName: row.activatedByName }
        : null,
    activatedAt: row.activatedAt,
    createdAt: row.createdAt,
  };
}

export class AnalysisProviderConfigurationError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'AnalysisProviderConfigurationError';
  }
}

function normalizeAllowedEndpoint(value: string | undefined, config: AppConfig): string {
  if (!value) throw new AnalysisProviderConfigurationError('Provider endpoint가 필요합니다.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AnalysisProviderConfigurationError('Provider endpoint URL이 올바르지 않습니다.');
  }
  if (url.username || url.password) {
    throw new AnalysisProviderConfigurationError(
      'Provider endpoint에 credential을 넣을 수 없습니다.',
    );
  }
  const allowed = providerAllowedOrigins(config.MODEL_PROVIDER_ALLOWED_ORIGINS);
  if (!allowed.includes(url.origin)) {
    throw new AnalysisProviderConfigurationError('허용되지 않은 Provider origin입니다.');
  }
  return ensureTrailingSlash(url.toString());
}

function encryptProviderCredential(value: string, encodedKey: string | undefined) {
  const key = encryptionKey(encodedKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(credentialAad);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    credentialCiphertext: ciphertext,
    credentialIv: iv,
    credentialAuthTag: cipher.getAuthTag(),
  };
}

function decryptProviderCredential(
  row: Pick<AnalysisProviderRow, 'credentialCiphertext' | 'credentialIv' | 'credentialAuthTag'>,
  encodedKey: string | undefined,
): string {
  if (!row.credentialCiphertext || !row.credentialIv || !row.credentialAuthTag) {
    throw new Error('Analysis provider credential is unavailable');
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(encodedKey), row.credentialIv);
  decipher.setAAD(credentialAad);
  decipher.setAuthTag(row.credentialAuthTag);
  return Buffer.concat([decipher.update(row.credentialCiphertext), decipher.final()]).toString(
    'utf8',
  );
}

function encryptionKey(value: string | undefined): Buffer {
  if (!value) throw new Error('Analysis provider encryption key is unavailable');
  const key = Buffer.from(value, 'base64');
  if (key.byteLength !== 32) throw new Error('Analysis provider encryption key is invalid');
  return key;
}

function hashProviderConfiguration(value: {
  mode: AnalysisProviderMode;
  endpoint: string | null;
  modelName: string | null;
  timeoutMs: number;
  apiKey: string | null;
}): string {
  const credentialHash = value.apiKey
    ? createHash('sha256').update(value.apiKey).digest('hex')
    : null;
  return createHash('sha256')
    .update(
      JSON.stringify([
        value.mode,
        value.endpoint,
        value.modelName,
        value.timeoutMs,
        credentialHash,
      ]),
    )
    .digest('hex');
}

function providerProfile(mode: AnalysisProviderMode, modelName: string | null): string {
  return mode === 'openai-compatible' && modelName ? `openai-compatible:${modelName}` : 'disabled';
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
