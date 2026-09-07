create table if not exists analysis_provider_versions (
  id uuid primary key default gen_random_uuid(),
  version integer not null unique check (version > 0),
  mode text not null check (mode in ('disabled', 'openai-compatible')),
  endpoint text,
  model_name text,
  timeout_ms integer not null check (timeout_ms between 1000 and 600000),
  credential_ciphertext bytea,
  credential_iv bytea,
  credential_auth_tag bytea,
  configuration_hash text not null unique check (configuration_hash ~ '^[0-9a-f]{64}$'),
  active boolean not null default false,
  created_by uuid not null references users(id),
  activated_by uuid references users(id),
  activated_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check (
    (mode = 'disabled' and endpoint is null and model_name is null
      and credential_ciphertext is null and credential_iv is null and credential_auth_tag is null)
    or
    (mode = 'openai-compatible' and endpoint is not null and model_name is not null
      and credential_ciphertext is not null and credential_iv is not null
      and credential_auth_tag is not null)
  ),
  check (not active or (activated_by is not null and activated_at is not null))
);

create unique index if not exists analysis_provider_versions_active_idx
  on analysis_provider_versions(active) where active;

alter table analysis_runs
  add column if not exists provider_version_id uuid references analysis_provider_versions(id),
  add column if not exists provider_hash text not null default 'deployment-v1';

create index if not exists analysis_runs_provider_version_idx
  on analysis_runs(provider_version_id) where provider_version_id is not null;
