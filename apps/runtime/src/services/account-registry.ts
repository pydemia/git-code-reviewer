import type { Database } from '@gcr/db';
import { createHash } from 'node:crypto';
import { admittedFetch } from './model-admission.js';
import { normalizeGitHubBaseUrl, parseGitHubRepositoryUrl } from '@gcr/contracts';
import {
  GitHubAccessTokenClient,
  type GitHubReader,
  type GitHubReviewPublisher,
} from '@gcr/github';
import type { AppConfig } from '../config.js';
import {
  RegisteredChatGptAccountModel,
  validateChatGptAuthJson,
  chatGptQuotaIdentity,
  refreshChatGptAuthJson,
  type ChatModel,
} from './chat-model.js';
import {
  credentialFingerprint,
  decryptCredential,
  encryptCredential,
  type EncryptedCredential,
} from './credential-crypto.js';

export const reasoningEfforts = ['low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];

type CredentialColumns = {
  credentialCiphertext: Buffer;
  credentialIv: Buffer;
  credentialAuthTag: Buffer;
};

type ChatAccountSelectionRow = CredentialColumns & {
  id: string;
  displayName: string;
  endpoint: string | null;
  installationId: string;
  credentialVersion: number;
  modelName: string;
  modelDisplayName: string;
  allowedEfforts: string[];
  defaultEffort: string;
};

export type ChatAccountSelection = {
  accountId: string;
  accountName: string;
  modelName: string;
  modelDisplayName: string;
  reasoningEffort: string;
  credentialVersion: number;
  model: ChatModel;
};

export async function listAvailableChatAccounts(database: Database, userId: string) {
  const result = await database.query<{
    id: string;
    displayName: string;
    health: string;
    modelName: string;
    modelDisplayName: string;
    allowedEfforts: string[];
    defaultEffort: string;
  }>(
    `select account.id, account.display_name as "displayName", account.health,
            model.model_id as "modelName", model.display_name as "modelDisplayName",
            model.allowed_efforts as "allowedEfforts", model.default_effort as "defaultEffort"
     from chat_accounts account
     join chat_account_models model on model.account_id = account.id and model.enabled
     where account.enabled and account.deleted_at is null and exists (
       select 1 from chat_account_assignments assignment
       where assignment.account_id = account.id and assignment.enabled and (
         (assignment.scope_type = 'all' and assignment.scope_id = '*') or
         (assignment.scope_type = 'user' and assignment.scope_id = ($1::uuid)::text) or
         (assignment.scope_type = 'tenant' and exists (
           select 1 from tenants tenant where tenant.id::text = assignment.scope_id and tenant.enabled
             and (exists (select 1 from users app_user where app_user.id = $1::uuid
                          and app_user.enabled and app_user.role = 'administrator')
               or exists (select 1 from tenant_memberships membership
                          where membership.user_id = $1::uuid and membership.tenant_id = tenant.id
                            and membership.enabled))
         )) or
         (assignment.scope_type = 'group' and exists (
           select 1 from users app_user
           where app_user.id = $1::uuid and app_user.groups_json ? assignment.scope_id
         ))
       )
     )
     order by account.display_name, model.display_name`,
    [userId],
  );
  const accounts = new Map<
    string,
    {
      id: string;
      displayName: string;
      health: string;
      models: Array<{
        id: string;
        displayName: string;
        allowedEfforts: string[];
        defaultEffort: string;
      }>;
    }
  >();
  for (const row of result.rows) {
    const account = accounts.get(row.id) ?? {
      id: row.id,
      displayName: row.displayName,
      health: row.health,
      models: [],
    };
    account.models.push({
      id: row.modelName,
      displayName: row.modelDisplayName,
      allowedEfforts: row.allowedEfforts,
      defaultEffort: row.defaultEffort,
    });
    accounts.set(row.id, account);
  }
  return [...accounts.values()];
}

export async function resolveChatAccountSelection(
  database: Database,
  config: AppConfig,
  userId: string,
  accountId: string,
  modelName: string,
  effort: string,
  timeoutMs = config.CHAT_MODEL_TIMEOUT_MS,
): Promise<ChatAccountSelection | null> {
  const result = await database.query<ChatAccountSelectionRow>(
    `select account.id, account.display_name as "displayName", account.endpoint,
            account.installation_id as "installationId",
            account.credential_version as "credentialVersion",
            account.credential_ciphertext as "credentialCiphertext",
            account.credential_iv as "credentialIv",
            account.credential_auth_tag as "credentialAuthTag",
            model.model_id as "modelName", model.display_name as "modelDisplayName",
            model.allowed_efforts as "allowedEfforts", model.default_effort as "defaultEffort"
     from chat_accounts account
     join chat_account_models model on model.account_id = account.id
     where account.id = $2 and model.model_id = $3 and account.enabled and model.enabled
       and exists (
         select 1 from chat_account_assignments assignment
         where assignment.account_id = account.id and assignment.enabled and (
           (assignment.scope_type = 'all' and assignment.scope_id = '*') or
           (assignment.scope_type = 'user' and assignment.scope_id = ($1::uuid)::text) or
           (assignment.scope_type = 'tenant' and exists (
             select 1 from tenants tenant where tenant.id::text = assignment.scope_id and tenant.enabled
             and (exists (select 1 from users app_user where app_user.id = $1::uuid
                          and app_user.enabled and app_user.role = 'administrator')
               or exists (select 1 from tenant_memberships membership
                          where membership.user_id = $1::uuid and membership.tenant_id = tenant.id
                            and membership.enabled))
           )) or
           (assignment.scope_type = 'group' and exists (
             select 1 from users app_user
             where app_user.id = $1::uuid and app_user.groups_json ? assignment.scope_id
           ))
         )
       )`,
    [userId, accountId, modelName],
  );
  const row = result.rows[0];
  if (!row || !row.allowedEfforts.includes(effort)) return null;
  return hydrateChatAccount(database, config, row, effort, timeoutMs);
}

/** Worker는 user/group 권한을 빌리지 않고 repository의 tenant grant를 확인한다. */
export async function findAnalysisChatAccount(
  database: Pick<Database, 'query'>,
  accountId: string,
  modelName: string,
  effort: string,
  scope: { tenantId: string } | { connectionTest: true },
) {
  const result = await database.query<ChatAccountSelectionRow>(
    `select account.id, account.display_name as "displayName", account.endpoint,
            account.installation_id as "installationId", account.credential_version as "credentialVersion",
            account.credential_ciphertext as "credentialCiphertext", account.credential_iv as "credentialIv",
            account.credential_auth_tag as "credentialAuthTag", model.model_id as "modelName",
            model.display_name as "modelDisplayName", model.allowed_efforts as "allowedEfforts",
            model.default_effort as "defaultEffort"
     from chat_accounts account join chat_account_models model on model.account_id = account.id
     where account.id = $1 and model.model_id = $2 and account.enabled and model.enabled
       and exists (select 1 from chat_account_assignments assignment
         where assignment.account_id = account.id and assignment.enabled and (
           (assignment.scope_type = 'all' and assignment.scope_id = '*') or
           (assignment.scope_type = 'tenant' and exists (
             select 1 from tenants tenant where tenant.id::text = assignment.scope_id and tenant.enabled
               and ($3::text is null or tenant.id::text = $3)
           ))
         ))`,
    [accountId, modelName, 'tenantId' in scope ? scope.tenantId : null],
  );
  const row = result.rows[0];
  return row?.allowedEfforts.includes(effort) ? row : null;
}

export async function resolveAnalysisChatAccount(
  database: Pick<Database, 'query'>,
  config: AppConfig,
  accountId: string,
  modelName: string,
  effort: string,
  scope: { tenantId: string } | { connectionTest: true },
  timeoutMs: number,
) {
  if (!config.CREDENTIAL_REGISTRY_ENABLED) return null;
  const row = await findAnalysisChatAccount(database, accountId, modelName, effort, scope);
  return row ? hydrateChatAccount(database, config, row, effort, timeoutMs) : null;
}

function hydrateChatAccount(
  database: Pick<Database, 'query'>,
  config: AppConfig,
  row: ChatAccountSelectionRow,
  effort: string,
  timeoutMs: number,
): ChatAccountSelection {
  const authJson = decryptCredential(row, config.CREDENTIAL_ENCRYPTION_KEY, 'chat-account');
  const quotaKey = createHash('sha256')
    .update(`chatgpt:${chatGptQuotaIdentity(authJson)}`)
    .digest('hex');
  const model = new RegisteredChatGptAccountModel({
    name: row.modelName,
    endpoint: row.endpoint,
    timeoutMs,
    authJson,
    ...(config.MODEL_ADMISSION_ENABLED || config.CHAT_AGENT_ENABLED
      ? { fetch: admittedFetch(database, quotaKey) }
      : {}),
    installationId: row.installationId,
    refreshUrl: config.CHATGPT_ACCOUNT_REFRESH_ENDPOINT,
    proactiveRefreshMinutes: config.CHATGPT_ACCOUNT_PROACTIVE_REFRESH_MINUTES,
    refreshAuthJson: async (previous) => {
      const client = await (database as Database).connect();
      try {
        await client.query('begin');
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [
          `account-refresh:${quotaKey}`,
        ]);
        const selected = await client.query<CredentialColumns>(
          'select credential_ciphertext as "credentialCiphertext",credential_iv as "credentialIv",credential_auth_tag as "credentialAuthTag" from chat_accounts where id=$1 and enabled for update',
          [row.id],
        );
        if (!selected.rows[0]) throw Error('account_unavailable');
        const current = decryptCredential(
          selected.rows[0],
          config.CREDENTIAL_ENCRYPTION_KEY,
          'chat-account',
        );
        if (JSON.parse(current).tokens.access_token !== JSON.parse(previous).tokens.access_token) {
          await client.query('commit');
          return current;
        }
        const refreshed = await refreshChatGptAuthJson(
          current,
          config.CHATGPT_ACCOUNT_REFRESH_ENDPOINT,
        );
        const encrypted = encryptCredential(
          refreshed,
          config.CREDENTIAL_ENCRYPTION_KEY,
          'chat-account',
        );
        await client.query(
          "update chat_accounts set credential_ciphertext=$2,credential_iv=$3,credential_auth_tag=$4,credential_fingerprint=$5,credential_version=credential_version+1,health='ready',last_validated_at=clock_timestamp(),updated_at=clock_timestamp() where deleted_at is null and enabled and (id=$1 or credential_fingerprint=$6)",
          [
            row.id,
            encrypted.credentialCiphertext,
            encrypted.credentialIv,
            encrypted.credentialAuthTag,
            credentialFingerprint(refreshed),
            credentialFingerprint(current),
          ],
        );
        await client.query('commit');
        return refreshed;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    persistAuthJson: async (updatedAuthJson) => {
      const encrypted = encryptCredential(
        updatedAuthJson,
        config.CREDENTIAL_ENCRYPTION_KEY,
        'chat-account',
      );
      await database.query(
        `update chat_accounts set credential_ciphertext = $2, credential_iv = $3,
           credential_auth_tag = $4, credential_fingerprint = $5,
           credential_version = credential_version + 1, health = 'ready',
           last_validated_at = clock_timestamp(), updated_at = clock_timestamp()
         where id = $1 and enabled and deleted_at is null`,
        [
          row.id,
          encrypted.credentialCiphertext,
          encrypted.credentialIv,
          encrypted.credentialAuthTag,
          credentialFingerprint(updatedAuthJson),
        ],
      );
    },
  });
  return {
    accountId: row.id,
    accountName: row.displayName,
    modelName: row.modelName,
    modelDisplayName: row.modelDisplayName,
    reasoningEffort: effort,
    credentialVersion: row.credentialVersion,
    model,
  };
}

export async function createChatAccount(
  database: Database,
  config: AppConfig,
  actorId: string,
  input: {
    displayName: string;
    endpoint?: string | undefined;
    authJson: string;
    models: Array<{
      id: string;
      displayName: string;
      allowedEfforts: string[];
      defaultEffort: string;
    }>;
    assignments: Array<{ scopeType: 'all' | 'tenant' | 'user' | 'group'; scopeId: string }>;
  },
) {
  assertChatGptAuthJson(input.authJson);
  const encrypted = encryptCredential(
    input.authJson,
    config.CREDENTIAL_ENCRYPTION_KEY,
    'chat-account',
  );
  const connection = await database.connect();
  try {
    await connection.query('begin');
    const created = await connection.query<{ id: string }>(
      `insert into chat_accounts(
         display_name, provider_type, endpoint, credential_ciphertext, credential_iv,
         credential_auth_tag, credential_fingerprint, created_by)
       values ($1, 'chatgpt-account', $2, $3, $4, $5, $6, $7) returning id`,
      [
        input.displayName,
        input.endpoint ?? null,
        encrypted.credentialCiphertext,
        encrypted.credentialIv,
        encrypted.credentialAuthTag,
        credentialFingerprint(input.authJson),
        actorId,
      ],
    );
    const accountId = created.rows[0]!.id;
    for (const model of input.models) {
      await connection.query(
        `insert into chat_account_models(
           account_id, model_id, display_name, allowed_efforts, default_effort, max_effort)
         values ($1, $2, $3, $4::text[], $5, $6)`,
        [
          accountId,
          model.id,
          model.displayName,
          model.allowedEfforts,
          model.defaultEffort,
          model.allowedEfforts.at(-1) ?? null,
        ],
      );
    }
    for (const assignment of input.assignments) {
      await connection.query(
        `insert into chat_account_assignments(account_id, scope_type, scope_id, created_by)
         values ($1, $2, $3, $4)`,
        [accountId, assignment.scopeType, assignment.scopeId, actorId],
      );
    }
    await connection.query('commit');
    return accountId;
  } catch (error) {
    await connection.query('rollback');
    throw error;
  } finally {
    connection.release();
  }
}

export async function rotateChatAccountCredential(
  database: Database,
  config: AppConfig,
  accountId: string,
  authJson: string,
) {
  assertChatGptAuthJson(authJson);
  const encrypted = encryptCredential(authJson, config.CREDENTIAL_ENCRYPTION_KEY, 'chat-account');
  return database.query(
    `update chat_accounts set credential_ciphertext = $2, credential_iv = $3,
       credential_auth_tag = $4, credential_fingerprint = $5,
       credential_version = credential_version + 1, health = 'unverified',
       last_validated_at = null, updated_at = clock_timestamp()
     where id = $1 and deleted_at is null returning id`,
    [
      accountId,
      encrypted.credentialCiphertext,
      encrypted.credentialIv,
      encrypted.credentialAuthTag,
      credentialFingerprint(authJson),
    ],
  );
}

export async function listAdminChatAccounts(database: Database) {
  const result = await database.query(
    `select account.id, account.display_name as "displayName", account.provider_type as "providerType",
            account.endpoint, account.credential_version as "credentialVersion",
            right(account.credential_fingerprint, 12) as "credentialFingerprint",
            account.health, account.enabled, account.expires_at as "expiresAt",
            account.last_validated_at as "lastValidatedAt", account.created_at as "createdAt",
            coalesce((select jsonb_agg(jsonb_build_object(
              'id', model.model_id, 'displayName', model.display_name,
              'allowedEfforts', model.allowed_efforts, 'defaultEffort', model.default_effort,
              'enabled', model.enabled) order by model.display_name)
              from chat_account_models model where model.account_id = account.id), '[]'::jsonb) as models,
            coalesce((select jsonb_agg(jsonb_build_object(
              'scopeType', assignment.scope_type, 'scopeId', assignment.scope_id,
              'enabled', assignment.enabled) order by assignment.scope_type, assignment.scope_id)
              from chat_account_assignments assignment where assignment.account_id = account.id), '[]'::jsonb) as assignments
     from chat_accounts account where account.deleted_at is null order by account.display_name`,
  );
  return result.rows;
}

export class GitHubRegistryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly retryable = false,
  ) {
    super(message);
  }
}

function connectionBaseUrl(value: string, kind: 'api' | 'web'): string {
  try {
    return normalizeGitHubBaseUrl(value, kind);
  } catch (error) {
    throw new GitHubRegistryError('GITHUB_BASE_URL_INVALID', (error as Error).message);
  }
}

export async function createGitHubConnection(
  database: Database,
  config: AppConfig,
  actorId: string,
  input: {
    name: string;
    apiBaseUrl: string;
    webBaseUrl: string;
    credentialLabel: string;
    accessToken: string;
    expiresAt?: string | undefined;
  },
) {
  const apiBaseUrl = connectionBaseUrl(input.apiBaseUrl, 'api');
  const webBaseUrl = connectionBaseUrl(input.webBaseUrl, 'web');
  const encrypted = encryptCredential(
    input.accessToken,
    config.CREDENTIAL_ENCRYPTION_KEY,
    'github-access-token',
  );
  const connection = await database.connect();
  try {
    await connection.query('begin');
    const instance = await connection.query<{ id: string }>(
      `insert into github_instances(name, api_base_url, web_base_url)
       values ($1, $2, $3)
       on conflict (api_base_url) do update set name = excluded.name,
         web_base_url = excluded.web_base_url, enabled = true, updated_at = clock_timestamp()
       returning id`,
      [input.name, apiBaseUrl, webBaseUrl],
    );
    const credential = await connection.query<{ id: string }>(
      `insert into github_credentials(
         instance_id, label, credential_ciphertext, credential_iv, credential_auth_tag,
         token_fingerprint, expires_at, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (instance_id, label) do update set
         credential_ciphertext = excluded.credential_ciphertext,
         credential_iv = excluded.credential_iv,
         credential_auth_tag = excluded.credential_auth_tag,
         token_fingerprint = excluded.token_fingerprint,
         expires_at = excluded.expires_at, credential_version = github_credentials.credential_version + 1,
         health = 'unverified', enabled = true, last_validated_at = null,
         updated_at = clock_timestamp()
       returning id`,
      [
        instance.rows[0]!.id,
        input.credentialLabel,
        encrypted.credentialCiphertext,
        encrypted.credentialIv,
        encrypted.credentialAuthTag,
        credentialFingerprint(input.accessToken),
        input.expiresAt ?? null,
        actorId,
      ],
    );
    await connection.query('commit');
    return credential.rows[0]!.id;
  } catch (error) {
    await connection.query('rollback');
    throw error;
  } finally {
    connection.release();
  }
}

export async function listGitHubConnections(database: Database) {
  const result = await database.query(
    `select credential.id, instance.id as "instanceId", instance.name,
            instance.api_base_url as "apiBaseUrl", instance.web_base_url as "webBaseUrl",
            credential.label as "credentialLabel", credential.credential_version as "credentialVersion",
            right(credential.token_fingerprint, 12) as "tokenFingerprint", credential.health,
            credential.enabled and instance.enabled as enabled, credential.expires_at as "expiresAt",
            credential.last_validated_at as "lastValidatedAt", credential.created_at as "createdAt"
     from github_credentials credential join github_instances instance on instance.id = credential.instance_id
     order by instance.name, credential.label`,
  );
  return result.rows;
}

export async function updateGitHubConnection(
  database: Pick<Database, 'query'>,
  config: AppConfig,
  credentialId: string,
  input: {
    name: string;
    apiBaseUrl: string;
    webBaseUrl: string;
    credentialLabel: string;
    accessToken?: string | undefined;
    expiresAt: string | null;
  },
): Promise<'updated' | 'not-found' | 'token-required' | 'shared-instance'> {
  const apiBaseUrl = connectionBaseUrl(input.apiBaseUrl, 'api');
  const webBaseUrl = connectionBaseUrl(input.webBaseUrl, 'web');
  const existing = await database.query<{
    credentialId: string;
    instanceId: string;
    name: string;
    apiBaseUrl: string;
    webBaseUrl: string;
  }>(
    `select credential.id as "credentialId", credential.instance_id as "instanceId", instance.name,
            instance.api_base_url as "apiBaseUrl", instance.web_base_url as "webBaseUrl"
     from github_credentials target
     join github_instances instance on instance.id = target.instance_id
     join github_credentials credential on credential.instance_id = instance.id
     where target.id = $1 for update of credential, instance`,
    [credentialId],
  );
  const row = existing.rows.find((item) => item.credentialId === credentialId);
  if (!row) return 'not-found';
  const instanceChanged =
    row.name !== input.name || row.apiBaseUrl !== apiBaseUrl || row.webBaseUrl !== webBaseUrl;
  if (instanceChanged && existing.rows.length > 1) return 'shared-instance';
  const originChanged =
    new URL(row.apiBaseUrl).origin !== new URL(apiBaseUrl).origin ||
    new URL(row.webBaseUrl).origin !== new URL(webBaseUrl).origin;
  if (originChanged && !input.accessToken) {
    return 'token-required';
  }

  await database.query(
    `update github_instances set name = $2, api_base_url = $3, web_base_url = $4,
       updated_at = clock_timestamp() where id = $1`,
    [row.instanceId, input.name, apiBaseUrl, webBaseUrl],
  );

  if (input.accessToken !== undefined) {
    const encrypted = encryptCredential(
      input.accessToken,
      config.CREDENTIAL_ENCRYPTION_KEY,
      'github-access-token',
    );
    await database.query(
      `update github_credentials set label = $2, expires_at = $3,
         credential_ciphertext = $4, credential_iv = $5, credential_auth_tag = $6,
         token_fingerprint = $7, credential_version = credential_version + 1,
         health = 'unverified', last_validated_at = null,
         updated_at = clock_timestamp() where id = $1`,
      [
        credentialId,
        input.credentialLabel,
        input.expiresAt,
        encrypted.credentialCiphertext,
        encrypted.credentialIv,
        encrypted.credentialAuthTag,
        credentialFingerprint(input.accessToken),
      ],
    );
  } else {
    await database.query(
      `update github_credentials set label = $2, expires_at = $3,
         health = 'unverified', last_validated_at = null,
         updated_at = clock_timestamp() where id = $1`,
      [credentialId, input.credentialLabel, input.expiresAt],
    );
  }
  return 'updated';
}

export async function registeredGitHubReader(
  database: Database,
  encryptionKey: string | undefined,
  credentialId: string,
): Promise<GitHubReader | null> {
  const result = await database.query<CredentialColumns>(
    `select credential_ciphertext as "credentialCiphertext",
            credential_iv as "credentialIv", credential_auth_tag as "credentialAuthTag"
     from github_credentials where id = $1 and enabled
       and health = 'ready'
       and (expires_at is null or expires_at > clock_timestamp())`,
    [credentialId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const token = decryptCredential(row, encryptionKey, 'github-access-token');
  return new GitHubAccessTokenClient(token);
}

export async function registeredGitHubPublisher(
  database: Database,
  encryptionKey: string | undefined,
  credentialId: string,
): Promise<GitHubReviewPublisher | null> {
  const client = await registeredGitHubReader(database, encryptionKey, credentialId);
  return client instanceof GitHubAccessTokenClient ? client : null;
}

export async function testGitHubConnection(
  database: Database,
  config: AppConfig,
  credentialId: string,
  request: typeof fetch = fetch,
) {
  const result = await database.query<CredentialColumns & { apiBaseUrl: string }>(
    `select credential.credential_ciphertext as "credentialCiphertext",
            credential.credential_iv as "credentialIv",
            credential.credential_auth_tag as "credentialAuthTag",
            instance.api_base_url as "apiBaseUrl"
     from github_credentials credential join github_instances instance on instance.id = credential.instance_id
     where credential.id = $1`,
    [credentialId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const token = decryptCredential(row, config.CREDENTIAL_ENCRYPTION_KEY, 'github-access-token');
  const started = performance.now();
  const response = await request(new URL('user', connectionBaseUrl(row.apiBaseUrl, 'api')), {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15_000),
  });
  const health = response.ok
    ? 'ready'
    : response.status === 401
      ? 'unauthorized'
      : response.status === 403
        ? 'forbidden'
        : response.status === 429
          ? 'rate-limited'
          : 'unavailable';
  await response.body?.cancel().catch(() => undefined);
  await database.query(
    `update github_credentials set health = $2, last_validated_at = clock_timestamp(),
       updated_at = clock_timestamp() where id = $1`,
    [credentialId, health],
  );
  return {
    ok: response.ok,
    status: response.status,
    latencyMs: Math.round(performance.now() - started),
  };
}

export async function registerGitHubRepository(
  database: Database,
  config: AppConfig,
  credentialId: string,
  input: {
    tenantId: string;
    repositoryUrl?: string | undefined;
    owner?: string | undefined;
    name?: string | undefined;
    pollIntervalSeconds: number;
    reviewPublishingEnabled: boolean;
    grantSubjects: string[];
  },
) {
  const details = await githubRepositoryDetails(database, config, credentialId, input);
  const connection = await database.connect();
  try {
    await connection.query('begin');
    const repository = await connection.query<{ id: string }>(
      `insert into repositories(
         tenant_id, instance_id, credential_id, github_id, installation_id, owner, name,
         poll_interval_seconds, polling_enabled, review_publishing_enabled)
       select $1, credential.instance_id, credential.id, $3, 'access-token', $4, $5, $6, true, $7
       from github_credentials credential where credential.id = $2 and credential.enabled
         and credential.health = 'ready'
       on conflict (instance_id, github_id) do update set tenant_id = excluded.tenant_id,
         credential_id = excluded.credential_id, owner = excluded.owner, name = excluded.name,
         poll_interval_seconds = excluded.poll_interval_seconds, polling_enabled = true,
         review_publishing_enabled = excluded.review_publishing_enabled,
         enabled = true, deleted_at = null, updated_at = clock_timestamp()
       returning id`,
      [
        input.tenantId,
        credentialId,
        details.id,
        details.owner,
        details.name,
        input.pollIntervalSeconds,
        input.reviewPublishingEnabled,
      ],
    );
    if (!repository.rows[0])
      throw new GitHubRegistryError(
        'GITHUB_CONNECTION_UNAVAILABLE',
        '선택한 연결을 사용할 수 없습니다. 연결 테스트 후 다시 등록하십시오.',
        409,
      );
    const repositoryId = repository.rows[0].id;
    for (const subject of input.grantSubjects) {
      await connection.query(
        `insert into repository_grants(repository_id, subject_or_group, role)
         values ($1, $2, 'reviewer') on conflict do nothing`,
        [repositoryId, subject],
      );
    }
    await connection.query(
      `insert into poll_states(repository_id, next_poll_at) values ($1, clock_timestamp())
       on conflict (repository_id) do update set next_poll_at = clock_timestamp(),
         backoff_until = null, updated_at = clock_timestamp()`,
      [repositoryId],
    );
    await connection.query('commit');
    return repositoryId;
  } catch (error) {
    await connection.query('rollback');
    throw error;
  } finally {
    connection.release();
  }
}

async function githubRepositoryDetails(
  database: Database,
  config: AppConfig,
  credentialId: string,
  input: {
    repositoryUrl?: string | undefined;
    owner?: string | undefined;
    name?: string | undefined;
  },
) {
  const result = await database.query<
    CredentialColumns & { apiBaseUrl: string; webBaseUrl: string }
  >(
    `select credential.credential_ciphertext as "credentialCiphertext",
            credential.credential_iv as "credentialIv",
            credential.credential_auth_tag as "credentialAuthTag",
            instance.api_base_url as "apiBaseUrl", instance.web_base_url as "webBaseUrl"
     from github_credentials credential join github_instances instance on instance.id = credential.instance_id
     where credential.id = $1 and credential.enabled and credential.health = 'ready'
       and instance.enabled and (credential.expires_at is null or credential.expires_at > clock_timestamp())`,
    [credentialId],
  );
  const row = result.rows[0];
  if (!row)
    throw new GitHubRegistryError(
      'GITHUB_CONNECTION_UNAVAILABLE',
      '선택한 연결이 미검증·비활성 상태이거나 token이 만료되었습니다. 연결을 확인하고 연결 테스트를 먼저 실행하십시오.',
      409,
    );
  const apiBaseUrl = connectionBaseUrl(row.apiBaseUrl, 'api');
  const webBaseUrl = connectionBaseUrl(row.webBaseUrl, 'web');
  let target: ReturnType<typeof parseGitHubRepositoryUrl>;
  try {
    target = parseGitHubRepositoryUrl(
      input.repositoryUrl ?? `${webBaseUrl}${input.owner ?? ''}/${input.name ?? ''}`,
      webBaseUrl,
    );
  } catch (error) {
    throw new GitHubRegistryError('GITHUB_REPOSITORY_URL_INVALID', (error as Error).message);
  }
  const token = decryptCredential(row, config.CREDENTIAL_ENCRYPTION_KEY, 'github-access-token');
  let response: Response;
  try {
    response = await fetch(
      new URL(
        `repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}`,
        apiBaseUrl,
      ),
      {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      },
    );
  } catch {
    throw new GitHubRegistryError(
      'GITHUB_CONNECTION_FAILED',
      'GitHub API에 연결하지 못했습니다. API base URL, 서버의 network·TLS 설정을 확인하십시오. Repository가 이동했다면 새 주소로 등록하십시오.',
      502,
      true,
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401)
      throw new GitHubRegistryError(
        'GITHUB_TOKEN_UNAUTHORIZED',
        'GitHub가 token 인증을 거부했습니다(401). Token 만료·회수 여부를 확인하고 새 token으로 연결 테스트를 실행하십시오.',
        502,
      );
    if (response.status === 403)
      throw new GitHubRegistryError(
        'GITHUB_REPOSITORY_FORBIDDEN',
        'GitHub가 repository 접근을 거부했습니다(403). PAT의 repository 선택, organization 승인·SSO와 rate limit을 확인하십시오.',
        403,
      );
    if (response.status === 404)
      throw new GitHubRegistryError(
        'GITHUB_REPOSITORY_NOT_FOUND',
        'Repository를 찾을 수 없거나 token에 접근 권한이 없습니다(404). 주소의 철자, PAT의 Resource owner·Repository access와 organization 승인 상태를 확인하십시오.',
        404,
      );
    throw new GitHubRegistryError(
      'GITHUB_REPOSITORY_REQUEST_FAILED',
      `GitHub repository 조회에 실패했습니다(HTTP ${response.status}). 잠시 후 다시 시도하십시오.`,
      502,
      response.status === 429 || response.status >= 500,
    );
  }
  let value: { id?: number; name?: string; owner?: { login?: string } };
  try {
    value = await response.json();
    if (!Number.isSafeInteger(value.id) || value.id! <= 0 || !value.name || !value.owner?.login)
      throw new Error();
    const canonical = parseGitHubRepositoryUrl(
      `${webBaseUrl}${value.owner.login}/${value.name}`,
      webBaseUrl,
    );
    return { id: value.id!, owner: canonical.owner, name: canonical.name };
  } catch {
    throw new GitHubRegistryError(
      'GITHUB_RESPONSE_INVALID',
      'GitHub API 응답이 올바르지 않습니다. API base URL이 GitHub.com이면 https://api.github.com인지 확인하십시오.',
      502,
    );
  }
}

export function encryptedCredentialFromRow(row: CredentialColumns): EncryptedCredential {
  return row;
}

function assertChatGptAuthJson(value: string): void {
  try {
    validateChatGptAuthJson(value);
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error('Invalid ChatGPT auth.json'), {
      statusCode: 400,
    });
  }
}
