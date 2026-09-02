import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(4000),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(4001),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  WEB_DIST: z.string().default('/app/apps/web/dist'),
  MIGRATIONS_DIR: z.string().optional(),
  ARTIFACT_ROOT: z.string().default('/var/lib/git-code-reviewer/artifacts'),
  WORKSPACE_ROOT: z.string().default('/tmp/git-code-reviewer/workspaces'),
  AUTH_MODE: z.enum(['development', 'oidc', 'proxy']).default('development'),
  SESSION_SECRET: z.string().default('development-only-session-secret-32'),
  DEV_USER_SUBJECT: z.string().default('local-reviewer'),
  DEV_USER_NAME: z.string().default('Local Reviewer'),
  DEV_USER_ROLE: z.enum(['reviewer', 'administrator', 'admin']).default('reviewer'),
  GITHUB_MODE: z.enum(['disabled', 'fixture', 'app']).default('fixture'),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_PRIVATE_KEY_FILE: z.string().optional(),
  GITHUB_API_BASE_URL: z.string().url().optional(),
  GITHUB_WEB_BASE_URL: z.string().url().optional(),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  OIDC_ADMIN_GROUP: z.string().default('git-code-reviewer-admins'),
  PROXY_IDENTITY_PUBLIC_KEY_FILE: z.string().optional(),
  PROXY_IDENTITY_ISSUER: z.string().optional(),
  PROXY_IDENTITY_AUDIENCE: z.string().default('git-code-reviewer'),
  TRUST_PROXY: booleanString,
  RETENTION_REPORT_DAYS: z.coerce.number().int().positive().default(90),
  RETENTION_CHAT_DAYS: z.coerce.number().int().positive().default(30),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  command: 'serve' | 'worker' | 'migrate' | 'retention' = 'serve',
): AppConfig {
  const result = configSchema.safeParse(environment);
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
  return result.data;
}
