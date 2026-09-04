import { readFileSync } from 'node:fs';
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const optionalUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().url().optional(),
);

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(4000),
  PUBLIC_BASE_URL: optionalUrl,
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(4001),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  WEB_DIST: z.string().default('/app/apps/web/dist'),
  MIGRATIONS_DIR: z.string().optional(),
  ARTIFACT_ROOT: z.string().default('/var/lib/git-code-reviewer/artifacts'),
  WORKSPACE_ROOT: z.string().default('/tmp/git-code-reviewer/workspaces'),
  AUTH_MODE: z.enum(['development', 'local', 'oidc', 'proxy']).default('development'),
  AUTHORIZATION_MODE: z.enum(['local', 'cerbos']).default('local'),
  CERBOS_URL: optionalUrl,
  CERBOS_TIMEOUT_MS: z.coerce.number().int().positive().max(10_000).default(2_000),
  SESSION_SECRET: z.string().default('development-only-session-secret-32'),
  DEV_USER_SUBJECT: z.string().default('local-reviewer'),
  DEV_USER_NAME: z.string().default('Local Reviewer'),
  DEV_USER_ROLE: z.enum(['reviewer', 'administrator', 'admin']).default('reviewer'),
  LOCAL_BOOTSTRAP_ADMIN_USERNAME: z.string().optional(),
  LOCAL_BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),
  LOCAL_BOOTSTRAP_ADMIN_NAME: z.string().default('시스템 관리자'),
  LOCAL_BOOTSTRAP_REVIEWER_USERNAME: z.string().optional(),
  LOCAL_BOOTSTRAP_REVIEWER_PASSWORD: z.string().optional(),
  LOCAL_BOOTSTRAP_REVIEWER_NAME: z.string().default('일반 사용자'),
  GITHUB_MODE: z.enum(['disabled', 'fixture', 'app', 'registry']).default('fixture'),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_PRIVATE_KEY_FILE: z.string().optional(),
  GITHUB_API_BASE_URL: optionalUrl,
  GITHUB_WEB_BASE_URL: optionalUrl,
  MODEL_MODE: z.enum(['disabled', 'openai-compatible']).default('disabled'),
  MODEL_ENDPOINT: optionalUrl,
  MODEL_API_KEY: z.string().optional(),
  MODEL_NAME: z.string().optional(),
  MODEL_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  MODEL_ADMIN_ENABLED: booleanString,
  MODEL_CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  MODEL_PROVIDER_ALLOWED_ORIGINS: z.string().default(''),
  CHAT_MODEL_MODE: z
    .enum(['disabled', 'openai-compatible', 'chatgpt-account', 'registry'])
    .default('disabled'),
  CHAT_MODEL_ENDPOINT: optionalUrl,
  CHAT_MODEL_API_KEY: z.string().optional(),
  CHAT_MODEL_NAME: z.string().optional(),
  CHAT_MODEL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  CHATGPT_ACCOUNT_HOME: z.string().optional(),
  CHATGPT_ACCOUNT_REFRESH_ENDPOINT: z.string().url().default('https://auth.openai.com/oauth/token'),
  CHATGPT_ACCOUNT_PROACTIVE_REFRESH_MINUTES: z.coerce.number().int().min(1).max(60).default(5),
  CHAT_CONCURRENCY_LIMIT: z.coerce.number().int().positive().default(2),
  CHAT_HOURLY_LIMIT: z.coerce.number().int().positive().default(30),
  CHAT_SESSION_MESSAGE_LIMIT: z.coerce.number().int().positive().default(200),
  CREDENTIAL_REGISTRY_ENABLED: booleanString,
  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  ANALYSIS_MAX_FILES: z.coerce.number().int().positive().default(500),
  ANALYSIS_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  ANALYSIS_MAX_MODEL_CALLS: z.coerce.number().int().nonnegative().default(4),
  OIDC_ISSUER: optionalUrl,
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: optionalUrl,
  OIDC_ADMIN_GROUP: z.string().default('git-code-reviewer-admins'),
  OIDC_ADMIN_ROLE: z.string().default('git-code-reviewer-admin'),
  DEFAULT_TENANT_SLUG: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
    .default('default'),
  AUTO_JOIN_DEFAULT_TENANT: booleanString,
  PROXY_IDENTITY_PUBLIC_KEY_FILE: z.string().optional(),
  PROXY_IDENTITY_ISSUER: z.string().optional(),
  PROXY_IDENTITY_AUDIENCE: z.string().default('git-code-reviewer'),
  TRUST_PROXY: booleanString,
  RETENTION_REPORT_DAYS: z.coerce.number().int().positive().default(90),
  RETENTION_CHAT_DAYS: z.coerce.number().int().positive().default(30),
  RETENTION_EVENT_LOG_HOURS: z.coerce.number().int().positive().default(24),
  RETENTION_ORPHAN_GRACE_HOURS: z.coerce.number().int().positive().default(24),
  RETENTION_DELETE_GRACE_HOURS: z.coerce.number().int().nonnegative().default(1),
  RETENTION_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(500),
});

export type AppConfig = z.infer<typeof configSchema>;

function withDatabaseUrl(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (environment.DATABASE_URL) return environment;

  const host = environment.DATABASE_HOST;
  const port = environment.DATABASE_PORT;
  const database = environment.DATABASE_NAME;
  const username = environment.DATABASE_USER;
  const passwordFile = environment.DATABASE_PASSWORD_FILE;
  if (!host || !port || !database || !username || !passwordFile) return environment;

  let password: string;
  try {
    password = readFileSync(passwordFile, 'utf8').trim();
  } catch {
    throw new Error('Invalid configuration: DATABASE_PASSWORD_FILE');
  }
  if (!password) throw new Error('Invalid configuration: DATABASE_PASSWORD_FILE');

  const url = new URL('postgresql://localhost');
  url.hostname = host;
  url.port = port;
  url.username = username;
  url.password = password;
  url.pathname = `/${database}`;
  return { ...environment, DATABASE_URL: url.toString() };
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  command: 'serve' | 'worker' | 'migrate' | 'retention' = 'serve',
): AppConfig {
  const result = configSchema.safeParse(withDatabaseUrl(environment));
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid configuration: ${fields}`);
  }
  if (result.data.RETENTION_CHAT_DAYS > result.data.RETENTION_REPORT_DAYS) {
    throw new Error(
      'Invalid configuration: RETENTION_CHAT_DAYS must not exceed RETENTION_REPORT_DAYS',
    );
  }
  if (
    command === 'serve' &&
    result.data.AUTH_MODE !== 'development' &&
    result.data.SESSION_SECRET.length < 32
  ) {
    throw new Error('Invalid configuration: SESSION_SECRET must contain at least 32 characters');
  }
  if (
    command === 'serve' &&
    result.data.AUTH_MODE === 'local' &&
    (!result.data.LOCAL_BOOTSTRAP_ADMIN_USERNAME ||
      !result.data.LOCAL_BOOTSTRAP_ADMIN_PASSWORD ||
      result.data.LOCAL_BOOTSTRAP_ADMIN_PASSWORD.length < 12 ||
      Boolean(result.data.LOCAL_BOOTSTRAP_REVIEWER_USERNAME) !==
        Boolean(result.data.LOCAL_BOOTSTRAP_REVIEWER_PASSWORD) ||
      (result.data.LOCAL_BOOTSTRAP_REVIEWER_PASSWORD?.length ?? 12) < 12)
  ) {
    throw new Error('Invalid configuration: local auth requires valid bootstrap credentials');
  }
  if (
    ['serve', 'worker'].includes(command) &&
    (result.data.CREDENTIAL_REGISTRY_ENABLED ||
      result.data.GITHUB_MODE === 'registry' ||
      result.data.CHAT_MODEL_MODE === 'registry') &&
    !validEncryptionKey(result.data.CREDENTIAL_ENCRYPTION_KEY)
  ) {
    throw new Error(
      'Invalid configuration: credential registry requires a 32-byte base64 encryption key',
    );
  }
  if (
    command === 'serve' &&
    result.data.AUTHORIZATION_MODE === 'cerbos' &&
    !result.data.CERBOS_URL
  ) {
    throw new Error('Invalid configuration: CERBOS_URL is required for cerbos authorization');
  }
  if (
    command === 'serve' &&
    result.data.AUTH_MODE === 'oidc' &&
    (!result.data.OIDC_ISSUER ||
      !result.data.OIDC_CLIENT_ID ||
      !result.data.OIDC_CLIENT_SECRET ||
      !result.data.OIDC_REDIRECT_URI)
  ) {
    throw new Error('Invalid configuration: OIDC settings are required for oidc auth mode');
  }
  if (
    command === 'serve' &&
    result.data.AUTH_MODE === 'proxy' &&
    (!result.data.PROXY_IDENTITY_PUBLIC_KEY_FILE || !result.data.PROXY_IDENTITY_ISSUER)
  ) {
    throw new Error(
      'Invalid configuration: proxy identity settings are required for proxy auth mode',
    );
  }
  if (
    ['serve', 'worker'].includes(command) &&
    result.data.GITHUB_MODE === 'app' &&
    (!result.data.GITHUB_APP_ID || !result.data.GITHUB_PRIVATE_KEY_FILE)
  ) {
    throw new Error('Invalid configuration: GitHub App settings are required for app mode');
  }
  if (
    command === 'worker' &&
    result.data.MODEL_MODE === 'openai-compatible' &&
    (!result.data.MODEL_ENDPOINT || !result.data.MODEL_API_KEY || !result.data.MODEL_NAME)
  ) {
    throw new Error('Invalid configuration: model endpoint, API key, and name are required');
  }
  if (
    ['serve', 'worker'].includes(command) &&
    result.data.MODEL_ADMIN_ENABLED &&
    (!validEncryptionKey(result.data.MODEL_CREDENTIAL_ENCRYPTION_KEY) ||
      providerAllowedOrigins(result.data.MODEL_PROVIDER_ALLOWED_ORIGINS).length === 0)
  ) {
    throw new Error(
      'Invalid configuration: model administration requires a 32-byte base64 encryption key and allowed origins',
    );
  }
  if (
    command === 'serve' &&
    result.data.CHAT_MODEL_MODE === 'openai-compatible' &&
    (!result.data.CHAT_MODEL_ENDPOINT ||
      !result.data.CHAT_MODEL_API_KEY ||
      !result.data.CHAT_MODEL_NAME)
  ) {
    throw new Error('Invalid configuration: Chat model endpoint, API key, and name are required');
  }
  if (
    command === 'serve' &&
    result.data.CHAT_MODEL_MODE === 'chatgpt-account' &&
    !result.data.CHAT_MODEL_NAME
  ) {
    throw new Error('Invalid configuration: ChatGPT account model name is required');
  }
  return result.data;
}

export function providerAllowedOrigins(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].map((item) => {
    const url = new URL(item);
    if (url.origin !== item.replace(/\/$/, '')) {
      throw new Error('Invalid configuration: MODEL_PROVIDER_ALLOWED_ORIGINS');
    }
    return url.origin;
  });
}

function validEncryptionKey(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return Buffer.from(value, 'base64').byteLength === 32;
  } catch {
    return false;
  }
}
