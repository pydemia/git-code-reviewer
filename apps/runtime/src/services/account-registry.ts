import type { Database } from '@gcr/db';
import { GitHubAccessTokenClient, type GitHubReader } from '@gcr/github';
import type { AppConfig } from '../config.js';
import {
  RegisteredChatGptAccountModel,
  validateChatGptAuthJson,
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
     where account.enabled and exists (
       select 1 from chat_account_assignments assignment
       where assignment.account_id = account.id and assignment.enabled and (
         (assignment.scope_type = 'all' and assignment.scope_id = '*') or
         (assignment.scope_type = 'user' and assignment.scope_id = ($1::uuid)::text) or
         (assignment.scope_type = 'tenant' and exists (
           select 1 from tenant_memberships membership
           where membership.user_id = $1::uuid and membership.tenant_id::text = assignment.scope_id
             and membership.enabled
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
             select 1 from tenant_memberships membership
             where membership.user_id = $1::uuid and membership.tenant_id::text = assignment.scope_id
               and membership.enabled
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
  const authJson = decryptCredential(row, config.CREDENTIAL_ENCRYPTION_KEY, 'chat-account');
  const model = new RegisteredChatGptAccountModel({
    name: row.modelName,
    endpoint: row.endpoint,
    timeoutMs: config.CHAT_MODEL_TIMEOUT_MS,
    authJson,
    installationId: row.installationId,
    refreshUrl: config.CHATGPT_ACCOUNT_REFRESH_ENDPOINT,
    proactiveRefreshMinutes: config.CHATGPT_ACCOUNT_PROACTIVE_REFRESH_MINUTES,
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
         where id = $1`,
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
     where id = $1 returning id`,
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
     from chat_accounts account order by account.display_name`,
  );
  return result.rows;
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
  const apiBaseUrl = credentialFreeUrl(input.apiBaseUrl);
  const webBaseUrl = credentialFreeUrl(input.webBaseUrl);
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

export async function registeredGitHubReader(
  database: Database,
  encryptionKey: string | undefined,
  credentialId: string,
): Promise<GitHubReader | null> {
  const result = await database.query<CredentialColumns>(
    `select credential_ciphertext as "credentialCiphertext",
            credential_iv as "credentialIv", credential_auth_tag as "credentialAuthTag"
     from github_credentials where id = $1 and enabled
       and (expires_at is null or expires_at > clock_timestamp())`,
    [credentialId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const token = decryptCredential(row, encryptionKey, 'github-access-token');
  return new GitHubAccessTokenClient(token);
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
  const response = await request(new URL('user', ensureTrailingSlash(row.apiBaseUrl)), {
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
    owner: string;
    name: string;
    pollIntervalSeconds: number;
    grantSubjects: string[];
  },
) {
  const details = await githubRepositoryDetails(
    database,
    config,
    credentialId,
    input.owner,
    input.name,
  );
  const connection = await database.connect();
  try {
    await connection.query('begin');
    const repository = await connection.query<{ id: string }>(
      `insert into repositories(
         tenant_id, instance_id, credential_id, github_id, installation_id, owner, name,
         poll_interval_seconds, polling_enabled)
       select $1, credential.instance_id, credential.id, $3, 'access-token', $4, $5, $6, true
       from github_credentials credential where credential.id = $2 and credential.enabled
       on conflict (instance_id, github_id) do update set tenant_id = excluded.tenant_id,
         credential_id = excluded.credential_id, owner = excluded.owner, name = excluded.name,
         poll_interval_seconds = excluded.poll_interval_seconds, polling_enabled = true,
         enabled = true, updated_at = clock_timestamp()
       returning id`,
      [
        input.tenantId,
        credentialId,
        details.id,
        input.owner,
        input.name,
        input.pollIntervalSeconds,
      ],
    );
    if (!repository.rows[0])
      throw Object.assign(new Error('GHES connection is unavailable'), { statusCode: 404 });
    const repositoryId = repository.rows[0].id;
    for (const subject of input.grantSubjects) {
      await connection.query(
        `insert into repository_grants(repository_id, subject_or_group)
         values ($1, $2) on conflict do nothing`,
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
  owner: string,
  name: string,
) {
  const result = await database.query<CredentialColumns & { apiBaseUrl: string }>(
    `select credential.credential_ciphertext as "credentialCiphertext",
            credential.credential_iv as "credentialIv",
            credential.credential_auth_tag as "credentialAuthTag",
            instance.api_base_url as "apiBaseUrl"
     from github_credentials credential join github_instances instance on instance.id = credential.instance_id
     where credential.id = $1 and credential.enabled`,
    [credentialId],
  );
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error('GHES connection is unavailable'), { statusCode: 404 });
  const token = decryptCredential(row, config.CREDENTIAL_ENCRYPTION_KEY, 'github-access-token');
  const response = await fetch(
    new URL(
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      ensureTrailingSlash(row.apiBaseUrl),
    ),
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw Object.assign(new Error(`GHES repository request failed with HTTP ${response.status}`), {
      statusCode: response.status === 404 ? 404 : 502,
    });
  }
  const value = (await response.json()) as { id?: number };
  if (!Number.isSafeInteger(value.id)) throw new Error('GHES repository response has no id');
  return { id: value.id! };
}

export function encryptedCredentialFromRow(row: CredentialColumns): EncryptedCredential {
  return row;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function credentialFreeUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password) {
    throw Object.assign(new Error('URL must not contain credentials'), { statusCode: 400 });
  }
  return ensureTrailingSlash(url.toString());
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
