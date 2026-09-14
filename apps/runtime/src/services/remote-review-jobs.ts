import { randomUUID } from 'node:crypto';
import type { Database, DatabaseClient } from '@gcr/db';
import {
  remoteReviewResult,
  remoteReviewStatus,
  type RemoteReviewPayload,
  type RemoteReviewStatus,
} from '@gcr/client-contract';
import {
  assertFreshRemoteReviewApproval,
  canonicalJson,
  contentHash,
  validateRemoteReviewRequest,
} from '@gcr/client-core';
import {
  authenticateClientKey,
  ClientCredentialError,
  type ClientPrincipal,
} from '../auth/client-credentials.js';
import type { AppConfig } from '../config.js';
import { AuthorizationService } from './authorization.js';
import { canReadRepository } from '../routes/worklist.js';
import { listAvailableChatAccounts } from './account-registry.js';
import { decryptCredential, encryptCredential } from './credential-crypto.js';

export class RemoteReviewJobError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export interface RemoteReviewCaller {
  authorization: string;
  requestedServerId: string;
  keyId: string;
  repositoryId: string;
  traceId: string;
}
type Metadata = {
  id: string;
  server_id: string;
  tenant_id: string;
  repository_id: string;
  owner_user_id: string;
  client_id: string;
  request_id: string;
  payload_hash: string;
  received_at: Date;
  source_expires_at: Date;
  result_expires_at: Date;
  state: RemoteReviewStatus['state'];
  reason: string | null;
  report_hash: string | null;
};
const metadataColumns =
  'id,server_id,tenant_id,repository_id,owner_user_id,client_id,request_id,payload_hash,received_at,source_expires_at,result_expires_at,state,reason,report_hash';
const bindingWhere =
  'server_id=$1 and tenant_id=$2 and repository_id=$3 and owner_user_id=$4 and client_id=$5 and request_id=$6';
const binding = (
  config: AppConfig,
  caller: RemoteReviewCaller,
  principal: ClientPrincipal,
  requestId: string,
) => [
  config.KNOWLEDGE_SERVER_ID!,
  principal.tenantId,
  caller.repositoryId,
  principal.user.id,
  principal.clientId,
  requestId,
];
export const remoteReviewEncryptionPurpose = (
  id: string,
  payloadHash: string,
  kind: 'source' | 'result',
) => `remote-review:${id}:${payloadHash}:${kind}`;
function status(row: Metadata): RemoteReviewStatus {
  return remoteReviewStatus({
    schemaVersion: 1,
    requestId: row.request_id,
    audience: {
      serverId: row.server_id,
      tenantId: row.tenant_id,
      repositoryId: row.repository_id,
      userId: row.owner_user_id,
    },
    clientId: row.client_id,
    payloadHash: row.payload_hash,
    receivedAt: row.received_at.toISOString(),
    sourceExpiresAt: row.source_expires_at.toISOString(),
    resultExpiresAt: row.result_expires_at.toISOString(),
    state: row.state,
    ...(row.state === 'completed' ? { reportHash: row.report_hash } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
  });
}
async function access<T>(
  database: Database,
  config: AppConfig,
  authorization: AuthorizationService,
  caller: RemoteReviewCaller,
  scope: 'knowledge:read' | 'ai:invoke',
  action: (connection: DatabaseClient, principal: ClientPrincipal) => Promise<T>,
): Promise<T> {
  const c = await database.connect();
  try {
    await c.query('begin isolation level serializable');
    await c.query("set local lock_timeout='5s'");
    await c.query('select id from client_api_keys where id=$1 for update', [caller.keyId]);
    const principal = await authenticateClientKey(c, {
      authorization: caller.authorization,
      serverId: config.KNOWLEDGE_SERVER_ID!,
      requestedServerId: caller.requestedServerId,
      authMode: config.AUTH_MODE,
      repositoryId: caller.repositoryId,
      requiredScope: scope,
    });
    if (
      principal.keyId !== caller.keyId ||
      !(await canReadRepository(
        c,
        authorization,
        { user: principal.user, id: caller.traceId },
        caller.repositoryId,
        scope === 'ai:invoke' ? 'chat' : 'view',
      ))
    )
      throw new ClientCredentialError(403, 'CLIENT_SCOPE_DENIED');
    const result = await action(c, principal);
    await c.query('commit');
    return result;
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}

/** Content expiry does not declare a running model stopped and never makes a job retryable. */
export async function expireRemoteReviewJobs(
  database: Pick<Database, 'query'>,
  jobId?: string,
): Promise<number> {
  const result = await database.query(
    `with expired as (
    select id from client_review_jobs where ($1::uuid is null or id=$1)
      and ((source_expires_at<=clock_timestamp() and (source_ciphertext is not null or state in ('queued','running','cancel-requested')))
        or (result_expires_at<=clock_timestamp() and result_ciphertext is not null))
      order by source_expires_at,id for update skip locked limit 512
  ) update client_review_jobs j set
    state=case when j.state='completed' and j.result_expires_at<=clock_timestamp() then 'expired'
      when j.state in ('running','cancel-requested') and j.source_expires_at<=clock_timestamp() then 'uncertain'
      when j.state='queued' and j.source_expires_at<=clock_timestamp() then 'expired' else j.state end,
    reason=case when j.state='completed' and j.result_expires_at<=clock_timestamp() then 'result-expired'
      when j.state in ('running','cancel-requested') and j.source_expires_at<=clock_timestamp() then 'execution-lost'
      when j.state='queued' and j.source_expires_at<=clock_timestamp() then 'source-expired' else j.reason end,
    source_ciphertext=case when j.source_expires_at<=clock_timestamp() then null else j.source_ciphertext end,
    source_iv=case when j.source_expires_at<=clock_timestamp() then null else j.source_iv end,
    source_tag=case when j.source_expires_at<=clock_timestamp() then null else j.source_tag end,
    result_ciphertext=case when j.result_expires_at<=clock_timestamp() then null else j.result_ciphertext end,
    result_iv=case when j.result_expires_at<=clock_timestamp() then null else j.result_iv end,
    result_tag=case when j.result_expires_at<=clock_timestamp() then null else j.result_tag end,
    updated_at=clock_timestamp()
  from expired where j.id=expired.id`,
    [jobId ?? null],
  );
  return result.rowCount ?? 0;
}
async function find(c: DatabaseClient, values: string[]): Promise<Metadata> {
  const row = (
    await c.query<Metadata>(
      `select ${metadataColumns} from client_review_jobs where ${bindingWhere} for update`,
      values,
    )
  ).rows[0];
  if (!row) throw new RemoteReviewJobError(404, 'REMOTE_REVIEW_NOT_FOUND');
  await expireRemoteReviewJobs(c, row.id);
  return (
    await c.query<Metadata>(`select ${metadataColumns} from client_review_jobs where id=$1`, [
      row.id,
    ])
  ).rows[0]!;
}

export async function submitRemoteReviewJob(
  database: Database,
  config: AppConfig,
  authorization: AuthorizationService,
  caller: RemoteReviewCaller,
  input: unknown,
) {
  return access(database, config, authorization, caller, 'ai:invoke', async (c, principal) => {
    const request = validateRemoteReviewRequest(input, {
      audience: {
        serverId: config.KNOWLEDGE_SERVER_ID!,
        tenantId: principal.tenantId,
        userId: principal.user.id,
        repositoryId: caller.repositoryId,
      },
      clientId: principal.clientId as RemoteReviewPayload['clientId'],
    });
    const { payload, approval } = request;
    const values = binding(config, caller, principal, payload.requestId);
    // Lock order is identical for every submit. Budgets span all keys, worktrees and accounts.
    for (const name of [
      `remote-user:${principal.user.id}`,
      `remote-repository:${caller.repositoryId}`,
    ])
      await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [name]);
    const existing = (
      await c.query<Metadata>(
        `select ${metadataColumns} from client_review_jobs where ${bindingWhere}`,
        values,
      )
    ).rows[0];
    if (existing) {
      if (existing.payload_hash !== approval.payloadHash)
        throw new RemoteReviewJobError(409, 'REMOTE_REVIEW_REQUEST_CONFLICT');
      return { created: false, status: status(await find(c, values)) };
    }
    if (!config.REMOTE_REVIEWS_ENABLED)
      throw new RemoteReviewJobError(503, 'REMOTE_REVIEWS_DISABLED');
    if (payload.budget.outputTokensPerCall !== undefined)
      throw new RemoteReviewJobError(422, 'REMOTE_REVIEW_OUTPUT_TOKEN_LIMIT_UNSUPPORTED');
    assertFreshRemoteReviewApproval(request);
    const account = (await listAvailableChatAccounts(c, principal.user.id)).find(
      (account) => account.id === payload.model.accountId,
    );
    const model = account?.models.find((model) => model.id === payload.model.name);
    if (!model?.allowedEfforts.includes(payload.model.reasoningEffort))
      throw new RemoteReviewJobError(403, 'REMOTE_REVIEW_ACCOUNT_DENIED');
    const usage = (
      await c.query<{
        user_calls: string;
        repository_calls: string;
        user_active: string;
        repository_active: string;
      }>(
        `select coalesce(sum(reserved_model_calls) filter(where owner_user_id=$1 and received_at>clock_timestamp()-interval '1 hour'),0) as user_calls,
        coalesce(sum(reserved_model_calls) filter(where repository_id=$2 and received_at>clock_timestamp()-interval '1 hour'),0) as repository_calls,
        count(*) filter(where owner_user_id=$1 and state in ('queued','running','cancel-requested')) as user_active,
        count(*) filter(where repository_id=$2 and state in ('queued','running','cancel-requested')) as repository_active
       from client_review_jobs where (owner_user_id=$1 or repository_id=$2)
         and (received_at>clock_timestamp()-interval '1 hour' or state in ('queued','running','cancel-requested'))`,
        [principal.user.id, caller.repositoryId],
      )
    ).rows[0]!;
    if (
      Number(usage.user_calls) + payload.budget.modelCalls >
        config.REMOTE_REVIEW_USER_HOURLY_CALLS ||
      Number(usage.repository_calls) + payload.budget.modelCalls >
        config.REMOTE_REVIEW_REPOSITORY_HOURLY_CALLS ||
      Number(usage.user_active) >= 4 ||
      Number(usage.repository_active) >= 32
    )
      throw new RemoteReviewJobError(429, 'REMOTE_REVIEW_BUDGET_EXHAUSTED');
    const id = randomUUID();
    const encrypted = encryptCredential(
      canonicalJson(payload),
      config.CREDENTIAL_ENCRYPTION_KEY,
      remoteReviewEncryptionPurpose(id, approval.payloadHash, 'source'),
    );
    const row = (
      await c.query<Metadata>(
        `with timing as (select clock_timestamp() as received)
      insert into client_review_jobs(id,server_id,tenant_id,repository_id,owner_user_id,client_id,request_id,
        initiating_key_id,payload_hash,approved_at,account_id,model_name,reasoning_effort,reserved_model_calls,
        source_ciphertext,source_iv,source_tag,received_at,source_expires_at,result_expires_at)
      select $7,$1,$2,$3,$4,$5,$6,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,received,
        received+($18::integer*interval '1 second'),received+($19::integer*interval '1 second') from timing
      returning ${metadataColumns}`,
        [
          ...values,
          id,
          principal.keyId,
          approval.payloadHash,
          approval.approvedAt,
          payload.model.accountId,
          payload.model.name,
          payload.model.reasoningEffort,
          payload.budget.modelCalls,
          encrypted.credentialCiphertext,
          encrypted.credentialIv,
          encrypted.credentialAuthTag,
          payload.retention.sourceSeconds,
          payload.retention.resultSeconds,
        ],
      )
    ).rows[0]!;
    await c.query(
      "insert into audit_events(actor,action,resource_type,resource_id,outcome,metadata) values($1,'remote-review.submit','client-review-job',$2,'success',$3::jsonb)",
      [principal.user.id, id, JSON.stringify({ payloadHash: approval.payloadHash })],
    );
    return { created: true, status: status(row) };
  });
}

export async function readRemoteReviewJob(
  database: Database,
  config: AppConfig,
  authorization: AuthorizationService,
  caller: RemoteReviewCaller,
  requestId: string,
  result = false,
) {
  return access(database, config, authorization, caller, 'knowledge:read', async (c, principal) => {
    const row = await find(c, binding(config, caller, principal, requestId));
    const receipt = status(row);
    if (!result) return receipt;
    if (row.state !== 'completed')
      throw new RemoteReviewJobError(
        row.state === 'expired' ? 410 : 409,
        'REMOTE_REVIEW_RESULT_UNAVAILABLE',
      );
    const encrypted = (
      await c.query<{
        credentialCiphertext: Buffer;
        credentialIv: Buffer;
        credentialAuthTag: Buffer;
      }>(
        'select result_ciphertext as "credentialCiphertext",result_iv as "credentialIv",result_tag as "credentialAuthTag" from client_review_jobs where id=$1',
        [row.id],
      )
    ).rows[0]!;
    try {
      const report = JSON.parse(
        decryptCredential(
          encrypted,
          config.CREDENTIAL_ENCRYPTION_KEY,
          remoteReviewEncryptionPurpose(row.id, row.payload_hash, 'result'),
        ),
      );
      if (contentHash(report) !== row.report_hash) throw Error();
      return remoteReviewResult({ status: receipt, report });
    } catch {
      throw new RemoteReviewJobError(503, 'REMOTE_REVIEW_RESULT_INVALID');
    }
  });
}
export async function cancelRemoteReviewJob(
  database: Database,
  config: AppConfig,
  authorization: AuthorizationService,
  caller: RemoteReviewCaller,
  requestId: string,
  payloadHash: string,
) {
  return access(database, config, authorization, caller, 'ai:invoke', async (c, principal) => {
    const row = await find(c, binding(config, caller, principal, requestId));
    if (row.payload_hash !== payloadHash)
      throw new RemoteReviewJobError(409, 'REMOTE_REVIEW_REQUEST_CONFLICT');
    if (row.state === 'queued' || row.state === 'running') {
      await c.query(
        `update client_review_jobs set state=$2,reason=$3,source_ciphertext=null,source_iv=null,source_tag=null,
        updated_at=clock_timestamp() where id=$1`,
        [
          row.id,
          row.state === 'queued' ? 'cancelled' : 'cancel-requested',
          row.state === 'queued' ? 'cancelled' : null,
        ],
      );
      await c.query(
        "insert into audit_events(actor,action,resource_type,resource_id,outcome) values($1,'remote-review.cancel','client-review-job',$2,'success')",
        [principal.user.id, row.id],
      );
    }
    return status(await find(c, binding(config, caller, principal, requestId)));
  });
}
