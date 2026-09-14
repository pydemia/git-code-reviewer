import { randomUUID } from 'node:crypto';
import type { Database, DatabaseClient } from '@gcr/db';
import {
  clientReviewReport,
  type ClientReviewReport,
  type RemoteReviewPayload,
} from '@gcr/client-contract';
import { canonicalJson, contentHash, validateRemoteReviewRequest } from '@gcr/client-core';
import type { AppConfig } from '../config.js';
import { revalidateClientKeyGrant, ClientCredentialError } from '../auth/client-credentials.js';
import { canReadRepository } from '../routes/worklist.js';
import type { AuthorizationService } from './authorization.js';
import { listAvailableChatAccounts } from './account-registry.js';
import { centralReviewExecutorConfigHash } from './central-review-executor.js';
import { decryptCredential, encryptCredential } from './credential-crypto.js';
import {
  expireRemoteReviewJobs,
  remoteReviewEncryptionPurpose,
  RemoteReviewJobError,
} from './remote-review-jobs.js';

export type RemoteReviewClaim = { id: string; executor: string };
type ExecutionRow = {
  id: string;
  executor: string;
  state: string;
  initiating_key_id: string | null;
  server_id: string;
  tenant_id: string;
  repository_id: string;
  owner_user_id: string;
  client_id: RemoteReviewPayload['clientId'];
  payload_hash: string;
  approved_at: Date;
  account_id: string;
  model_name: string;
  reasoning_effort: string;
  source_ciphertext: Buffer | null;
  source_iv: Buffer | null;
  source_tag: Buffer | null;
  invocation_started_at: Date | null;
  source_expires_at: Date;
};
const invalidLease = () => new RemoteReviewJobError(409, 'REMOTE_REVIEW_LEASE_LOST');

/** A crash before the provider-send fence can be retried. A crash after it cannot. */
export async function recoverRemoteReviewLeases(
  database: Pick<Database, 'query'>,
): Promise<number> {
  await expireRemoteReviewJobs(database);
  const result = await database.query(`with stale as (
    select id from client_review_jobs where state in ('running','cancel-requested')
      and lease_until<=clock_timestamp() order by lease_until,id for update skip locked limit 512
  ) update client_review_jobs j set
    state=case when invocation_started_at is not null then 'uncertain' when state='cancel-requested' then 'cancelled' else 'queued' end,
    reason=case when invocation_started_at is not null then 'execution-lost' when state='cancel-requested' then 'cancelled' else null end,
    source_ciphertext=case when invocation_started_at is not null or state='cancel-requested' then null else source_ciphertext end,
    source_iv=case when invocation_started_at is not null or state='cancel-requested' then null else source_iv end,
    source_tag=case when invocation_started_at is not null or state='cancel-requested' then null else source_tag end,
    executor=null,lease_until=null,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
  from stale where j.id=stale.id`);
  return result.rowCount ?? 0;
}

export async function claimRemoteReviewJob(
  database: Pick<Database, 'query'>,
  config: AppConfig,
  worker: string,
): Promise<RemoteReviewClaim | null> {
  if (!config.REMOTE_REVIEWS_ENABLED) return null;
  const executor = `${worker}:${randomUUID()}`;
  const result = await database.query<RemoteReviewClaim>(
    `with candidate as (
    select id from client_review_jobs where state='queued' and source_ciphertext is not null
      and source_expires_at>clock_timestamp() and next_attempt_at<=clock_timestamp()
      order by received_at,id for update skip locked limit 1
  ) update client_review_jobs j set state='running',executor=$1,
    lease_until=least(source_expires_at,clock_timestamp()+interval '30 seconds'),updated_at=clock_timestamp()
  from candidate where j.id=candidate.id returning j.id,j.executor`,
    [executor],
  );
  return result.rows[0] ?? null;
}

async function authorizedRow(
  database: Pick<Database, 'query'>,
  config: AppConfig,
  authorization: AuthorizationService,
  claim: RemoteReviewClaim,
  lock = false,
  includeSource = false,
): Promise<ExecutionRow> {
  const columns =
    'id,executor,state,initiating_key_id,server_id,tenant_id,repository_id,owner_user_id,client_id,payload_hash,approved_at,account_id,model_name,reasoning_effort,invocation_started_at,source_expires_at';
  const row = (
    await database.query<ExecutionRow>(
      `select ${columns}${includeSource ? ',source_ciphertext,source_iv,source_tag' : ''} from client_review_jobs where id=$1 and executor=$2
    and state='running' and lease_until>clock_timestamp() and source_expires_at>clock_timestamp()${lock ? ' for update' : ''}`,
      [claim.id, claim.executor],
    )
  ).rows[0];
  if (!row || !config.REMOTE_REVIEWS_ENABLED) throw invalidLease();
  if (!row.initiating_key_id || row.server_id !== config.KNOWLEDGE_SERVER_ID)
    throw new ClientCredentialError(403, 'CLIENT_ACCESS_REVOKED');
  const principal = await revalidateClientKeyGrant(database, {
    keyId: row.initiating_key_id,
    serverId: row.server_id,
    repositoryId: row.repository_id,
    authMode: config.AUTH_MODE,
  });
  if (
    principal.user.id !== row.owner_user_id ||
    principal.tenantId !== row.tenant_id ||
    principal.clientId !== row.client_id ||
    !(await canReadRepository(
      database,
      authorization,
      { user: principal.user, id: claim.id },
      row.repository_id,
      'chat',
    ))
  )
    throw new ClientCredentialError(403, 'CLIENT_ACCESS_REVOKED');
  const account = (await listAvailableChatAccounts(database, row.owner_user_id)).find(
    (account) => account.id === row.account_id,
  );
  if (
    !account?.models
      .find((model) => model.id === row.model_name)
      ?.allowedEfforts.includes(row.reasoning_effort)
  )
    throw new RemoteReviewJobError(403, 'REMOTE_REVIEW_ACCOUNT_DENIED');
  return row;
}

export async function loadRemoteReviewPayload(
  database: Pick<Database, 'query'>,
  config: AppConfig,
  authorization: AuthorizationService,
  claim: RemoteReviewClaim,
): Promise<RemoteReviewPayload> {
  const row = await authorizedRow(database, config, authorization, claim, false, true);
  return payload(row, config);
}
function payload(row: ExecutionRow, config: AppConfig): RemoteReviewPayload {
  if (!row.source_ciphertext || !row.source_iv || !row.source_tag) throw invalidLease();
  try {
    const decoded = JSON.parse(
      decryptCredential(
        {
          credentialCiphertext: row.source_ciphertext,
          credentialIv: row.source_iv,
          credentialAuthTag: row.source_tag,
        },
        config.CREDENTIAL_ENCRYPTION_KEY,
        remoteReviewEncryptionPurpose(row.id, row.payload_hash, 'source'),
      ),
    );
    const request = validateRemoteReviewRequest(
      {
        payload: decoded,
        approval: { payloadHash: row.payload_hash, approvedAt: row.approved_at.toISOString() },
      },
      {
        audience: {
          serverId: row.server_id,
          tenantId: row.tenant_id,
          repositoryId: row.repository_id,
          userId: row.owner_user_id,
        },
        clientId: row.client_id,
      },
    );
    if (
      request.payload.model.accountId !== row.account_id ||
      request.payload.model.name !== row.model_name ||
      request.payload.model.reasoningEffort !== row.reasoning_effort
    )
      throw Error();
    return request.payload;
  } catch {
    throw new RemoteReviewJobError(503, 'REMOTE_REVIEW_SOURCE_INVALID');
  }
}
export async function heartbeatRemoteReviewJob(
  database: Pick<Database, 'query'>,
  config: AppConfig,
  authorization: AuthorizationService,
  claim: RemoteReviewClaim,
): Promise<void> {
  await authorizedRow(database, config, authorization, claim);
  const result = await database.query(
    `update client_review_jobs set
    lease_until=least(source_expires_at,clock_timestamp()+interval '30 seconds'),updated_at=clock_timestamp()
    where id=$1 and executor=$2 and state='running' and lease_until>clock_timestamp() and source_expires_at>clock_timestamp()`,
    [claim.id, claim.executor],
  );
  if (!result.rowCount) throw invalidLease();
}

async function transaction<T>(
  database: Database,
  operation: (c: DatabaseClient) => Promise<T>,
): Promise<T> {
  const c = await database.connect();
  try {
    await c.query('begin isolation level serializable');
    await c.query("set local lock_timeout='5s'");
    const result = await operation(c);
    await c.query('commit');
    return result;
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}
/** Passed to model admission's beforeSend callback, never called merely while waiting for capacity. */
export async function fenceRemoteReviewInvocation(
  database: Database,
  config: AppConfig,
  authorization: AuthorizationService,
  claim: RemoteReviewClaim,
): Promise<void> {
  await transaction(database, async (c) => {
    await authorizedRow(c, config, authorization, claim, true);
    const result = await c.query(
      `update client_review_jobs set
      invocation_started_at=coalesce(invocation_started_at,clock_timestamp()),updated_at=clock_timestamp()
      where id=$1 and executor=$2 and state='running' and lease_until>clock_timestamp() and source_expires_at>clock_timestamp()`,
      [claim.id, claim.executor],
    );
    if (!result.rowCount) throw invalidLease();
  });
}

/** A durable report and its terminal receipt commit together. A lost commit acknowledgement cannot restart it. */
export async function completeRemoteReviewJob(
  database: Database,
  config: AppConfig,
  authorization: AuthorizationService,
  claim: RemoteReviewClaim,
  input: ClientReviewReport,
): Promise<void> {
  const report = clientReviewReport(input);
  await transaction(database, async (c) => {
    const row = await authorizedRow(c, config, authorization, claim, true, true);
    if (!row.invocation_started_at || !report.finishedAt) throw invalidLease();
    const approved = payload(row, config);
    if (
      contentHash(report.identity.client) !== contentHash(approved.client) ||
      contentHash(report.identity.source) !== contentHash(approved.source.snapshot) ||
      report.identity.executor.model !== approved.model.name ||
      report.identity.executor.id !== 'central' ||
      report.identity.executor.configHash !==
        centralReviewExecutorConfigHash(approved.model, approved.budget.modelCalls) ||
      report.files.length !== approved.source.selected.length ||
      contentHash(report.sourceFiles.map((file) => contentHash(file)).sort()) !==
        contentHash(approved.source.files.map((file) => contentHash(file.metadata)).sort()) ||
      report.sourceFiles.some(
        (file) =>
          !approved.source.files.some(
            (allowed) => contentHash(allowed.metadata) === contentHash(file),
          ),
      ) ||
      report.files.some(
        (file) =>
          !approved.source.selected.some(
            (allowed) => allowed.path === file.source.path && allowed.side === file.source.side,
          ),
      )
    )
      throw new RemoteReviewJobError(409, 'REMOTE_REVIEW_RESULT_MISMATCH');
    const encrypted = encryptCredential(
      canonicalJson(report),
      config.CREDENTIAL_ENCRYPTION_KEY,
      remoteReviewEncryptionPurpose(row.id, row.payload_hash, 'result'),
    );
    const result = await c.query(
      `update client_review_jobs set state='completed',reason=null,
      report_hash=$3,result_ciphertext=$4,result_iv=$5,result_tag=$6,
      source_ciphertext=null,source_iv=null,source_tag=null,lease_until=null,updated_at=clock_timestamp()
      where id=$1 and executor=$2 and state='running' and lease_until>clock_timestamp() and source_expires_at>clock_timestamp()`,
      [
        claim.id,
        claim.executor,
        contentHash(report),
        encrypted.credentialCiphertext,
        encrypted.credentialIv,
        encrypted.credentialAuthTag,
      ],
    );
    if (!result.rowCount) throw invalidLease();
  });
}

/** Safe only before the first provider request. No terminal or potentially invoked job is reset. */
export async function deferRemoteReviewJob(
  database: Pick<Database, 'query'>,
  claim: RemoteReviewClaim,
  resumeAfter: Date,
): Promise<boolean> {
  if (!Number.isFinite(resumeAfter.getTime())) throw invalidLease();
  const result = await database.query(
    `update client_review_jobs set state='queued',executor=null,lease_until=null,
    next_attempt_at=greatest(clock_timestamp()+interval '250 milliseconds',$3),updated_at=clock_timestamp()
    where id=$1 and executor=$2 and state='running' and invocation_started_at is null
      and lease_until>clock_timestamp() and source_expires_at>clock_timestamp()`,
    [claim.id, claim.executor, resumeAfter],
  );
  return Boolean(result.rowCount);
}
