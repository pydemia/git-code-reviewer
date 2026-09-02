create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  oidc_subject text not null unique,
  display_name text not null,
  role text not null check (role in ('reviewer', 'administrator')),
  groups_json jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists auth_transactions (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null unique,
  nonce text not null,
  code_verifier text not null,
  return_to text not null default '/',
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists user_sessions (
  id_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists user_sessions_expiry_idx on user_sessions(expires_at);

create table if not exists github_instances (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  api_base_url text not null unique,
  web_base_url text not null,
  app_id text,
  enabled boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists repositories (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references github_instances(id),
  github_id bigint not null,
  installation_id text not null,
  owner text not null,
  name text not null,
  enabled boolean not null default true,
  poll_interval_seconds integer not null default 120 check (poll_interval_seconds between 30 and 86400),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(instance_id, github_id),
  unique(instance_id, owner, name)
);

create table if not exists repository_grants (
  repository_id uuid not null references repositories(id) on delete cascade,
  subject_or_group text not null,
  role text not null check (role in ('viewer', 'reviewer', 'administrator')),
  created_at timestamptz not null default clock_timestamp(),
  primary key(repository_id, subject_or_group)
);

create table if not exists pull_requests (
  id uuid primary key default gen_random_uuid(),
  repository_id uuid not null references repositories(id) on delete cascade,
  github_id bigint not null,
  number integer not null check (number > 0),
  title text not null,
  state text not null check (state in ('open', 'closed')),
  draft boolean not null default false,
  author_login text not null,
  html_url text not null,
  base_ref text not null,
  base_sha text not null,
  head_ref text not null,
  head_sha text not null,
  github_updated_at timestamptz not null,
  observed_at timestamptz not null default clock_timestamp(),
  unique(repository_id, number),
  unique(repository_id, github_id)
);
create index if not exists pull_requests_worklist_idx
  on pull_requests(repository_id, state, github_updated_at desc);

create table if not exists poll_states (
  repository_id uuid primary key references repositories(id) on delete cascade,
  next_poll_at timestamptz not null default clock_timestamp(),
  last_polled_at timestamptz,
  etag text,
  consecutive_failures integer not null default 0,
  backoff_until timestamptz,
  last_outcome text,
  last_error_code text,
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists poll_states_due_idx on poll_states(next_poll_at)
  where backoff_until is null;

create table if not exists audit_events (
  id bigint generated always as identity primary key,
  actor text not null,
  action text not null,
  resource_type text not null,
  resource_id text,
  outcome text not null,
  request_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists audit_events_created_idx on audit_events(created_at desc);

