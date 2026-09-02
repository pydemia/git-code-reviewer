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
  DEV_USER_SUBJECT: z.string().default('local-reviewer'),
  DEV_USER_NAME: z.string().default('Local Reviewer'),
  DEV_USER_ROLE: z.enum(['reviewer', 'administrator', 'admin']).default('reviewer'),
  TRUST_PROXY: booleanString,
  RETENTION_REPORT_DAYS: z.coerce.number().int().positive().default(90),
  RETENTION_CHAT_DAYS: z.coerce.number().int().positive().default(30),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
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
  return result.data;
}
