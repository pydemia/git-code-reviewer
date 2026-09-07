create table if not exists github_credentials (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references github_instances(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 120),
  auth_type text not null default 'access-token' check (auth_type = 'access-token'),
  credential_ciphertext bytea not null,
  credential_iv bytea not null,
  credential_auth_tag bytea not null,
  credential_version integer not null default 1 check (credential_version > 0),
  token_fingerprint text not null check (token_fingerprint ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  health text not null default 'unverified'
    check (health in ('unverified', 'ready', 'unauthorized', 'forbidden', 'rate-limited', 'unavailable', 'disabled')),
  enabled boolean not null default true,
  last_validated_at timestamptz,
  created_by uuid not null references users(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(instance_id, label)
);

alter table repositories
  add column if not exists credential_id uuid references github_credentials(id),
  add column if not exists polling_enabled boolean not null default true;

create index if not exists repositories_credential_idx
  on repositories(credential_id) where credential_id is not null;

create table if not exists chat_accounts (
  id uuid primary key default gen_random_uuid(),
  display_name text not null unique check (char_length(display_name) between 1 and 120),
  provider_type text not null check (provider_type in ('chatgpt-account', 'openai-compatible')),
  endpoint text,
  credential_ciphertext bytea not null,
  credential_iv bytea not null,
  credential_auth_tag bytea not null,
  credential_version integer not null default 1 check (credential_version > 0),
  credential_fingerprint text not null check (credential_fingerprint ~ '^[0-9a-f]{64}$'),
  installation_id uuid not null default gen_random_uuid(),
  health text not null default 'unverified'
    check (health in ('unverified', 'ready', 'refresh-required', 'rate-limited', 'unavailable', 'disabled')),
  enabled boolean not null default true,
  expires_at timestamptz,
  last_validated_at timestamptz,
  created_by uuid not null references users(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists chat_account_assignments (
  account_id uuid not null references chat_accounts(id) on delete cascade,
  scope_type text not null check (scope_type in ('all', 'tenant', 'user', 'group')),
  scope_id text not null,
  enabled boolean not null default true,
  created_by uuid not null references users(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(account_id, scope_type, scope_id),
  check ((scope_type = 'all' and scope_id = '*') or (scope_type <> 'all' and scope_id <> '*'))
);

create table if not exists chat_account_models (
  account_id uuid not null references chat_accounts(id) on delete cascade,
  model_id text not null check (char_length(model_id) between 1 and 200),
  display_name text not null check (char_length(display_name) between 1 and 200),
  allowed_efforts text[] not null check (cardinality(allowed_efforts) > 0),
  default_effort text not null,
  max_effort text,
  enabled boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(account_id, model_id),
  check (default_effort = any(allowed_efforts)),
  check (max_effort is null or max_effort = any(allowed_efforts))
);

alter table chat_sessions
  add column if not exists chat_account_id uuid references chat_accounts(id),
  add column if not exists model_name text,
  add column if not exists reasoning_effort text,
  add column if not exists credential_version integer;

alter table chat_sessions
  drop constraint if exists chat_sessions_analysis_run_id_user_id_key;

create index if not exists chat_sessions_owner_analysis_idx
  on chat_sessions(user_id, analysis_run_id, created_at desc);
