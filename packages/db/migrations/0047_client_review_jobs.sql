-- Uncommitted uploads are never PR snapshots. Minimal receipts remain as replay
-- fences after encrypted source/results expire; deleting content cannot authorize retry.
create table client_review_jobs (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null,
  tenant_id uuid not null references tenants(id) on delete cascade,
  repository_id uuid not null references repositories(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  client_id text not null check (client_id in ('commit-defender','gcr-cli')),
  request_id text not null check (request_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$'),
  initiating_key_id uuid references client_api_keys(id) on delete set null,
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  approved_at timestamptz not null,
  account_id uuid not null,
  model_name text not null,
  reasoning_effort text not null,
  reserved_model_calls integer not null check (reserved_model_calls between 1 and 10),
  state text not null default 'queued' check (state in ('queued','running','cancel-requested','completed','cancelled','failed','uncertain','expired')),
  reason text check (reason in ('cancelled','authorization-revoked','account-unavailable','budget-exhausted','execution-lost','model-failed','source-expired','result-expired','invalid-output')),
  source_ciphertext bytea,
  source_iv bytea,
  source_tag bytea,
  result_ciphertext bytea,
  result_iv bytea,
  result_tag bytea,
  report_hash text check (report_hash ~ '^[a-f0-9]{64}$'),
  received_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  source_expires_at timestamptz not null,
  result_expires_at timestamptz not null,
  executor text,
  lease_until timestamptz,
  unique (server_id,tenant_id,repository_id,owner_user_id,client_id,request_id),
  check (source_expires_at > received_at and result_expires_at >= source_expires_at),
  check ((source_ciphertext is null and source_iv is null and source_tag is null) or
    (source_ciphertext is not null and octet_length(source_ciphertext) <= 8388608 and
     source_iv is not null and octet_length(source_iv)=12 and source_tag is not null and octet_length(source_tag)=16)),
  check ((result_ciphertext is null and result_iv is null and result_tag is null) or
    (result_ciphertext is not null and octet_length(result_ciphertext) <= 16777216 and
     result_iv is not null and octet_length(result_iv)=12 and result_tag is not null and octet_length(result_tag)=16)),
  check ((state in ('queued','running','cancel-requested','completed')) = (reason is null)),
  check ((state in ('queued','running','cancel-requested','completed') and reason is null) or
    (state='cancelled' and reason='cancelled') or
    (state='uncertain' and reason='execution-lost') or
    (state='expired' and reason in ('source-expired','result-expired')) or
    (state='failed' and reason in ('authorization-revoked','account-unavailable','budget-exhausted','model-failed','invalid-output'))),
  check (state <> 'completed' or (report_hash is not null and result_ciphertext is not null))
);
create index client_review_jobs_owner_budget on client_review_jobs(owner_user_id,received_at);
create index client_review_jobs_repository_budget on client_review_jobs(repository_id,received_at);
create index client_review_jobs_pending on client_review_jobs(received_at,id) where state='queued';
create index client_review_jobs_source_expiry on client_review_jobs(source_expires_at) where source_ciphertext is not null;
create index client_review_jobs_result_expiry on client_review_jobs(result_expires_at) where result_ciphertext is not null;
