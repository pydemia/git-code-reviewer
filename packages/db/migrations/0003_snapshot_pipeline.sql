create table if not exists operations (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  scope_type text not null,
  scope_id uuid not null,
  state text not null check (state in ('queued', 'polling', 'materializing', 'analyzing', 'completed', 'failed')),
  dedupe_key text not null,
  requested_by uuid references users(id),
  result jsonb,
  error jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create unique index if not exists operations_active_dedupe_idx on operations(dedupe_key)
  where state in ('queued', 'polling', 'materializing', 'analyzing');

create table if not exists snapshot_requests (
  id uuid primary key default gen_random_uuid(),
  pull_request_id uuid not null references pull_requests(id) on delete cascade,
  base_sha text not null,
  head_sha text not null,
  state text not null check (state in ('requested', 'materialized', 'failed')) default 'requested',
  created_at timestamptz not null default clock_timestamp(),
  unique(pull_request_id, base_sha, head_sha)
);

create table if not exists snapshots (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references snapshot_requests(id) on delete cascade,
  version integer not null check (version > 0),
  merge_base_sha text,
  resolution text not null check (resolution in ('exact', 'unresolved')),
  policy_version text not null,
  manifest_checksum text,
  created_at timestamptz not null default clock_timestamp(),
  unique(request_id, version)
);

create table if not exists analysis_runs (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references snapshots(id) on delete cascade,
  analysis_key text not null unique,
  revision integer not null default 1,
  state text not null check (state in ('queued', 'analyzing', 'completed', 'partial', 'failed', 'cancelled')),
  stage text,
  progress integer not null default 0 check (progress between 0 and 100),
  profile text not null default 'default',
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null,
  priority integer not null default 100,
  state text not null check (state in ('queued', 'running', 'completed', 'failed')) default 'queued',
  dedupe_key text not null,
  available_at timestamptz not null default clock_timestamp(),
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  last_error jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create unique index if not exists jobs_active_dedupe_idx on jobs(dedupe_key)
  where state in ('queued', 'running');
create index if not exists jobs_claim_idx on jobs(state, available_at, priority, created_at);

create table if not exists job_attempts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  attempt_number integer not null,
  executor text not null,
  started_at timestamptz not null default clock_timestamp(),
  ended_at timestamptz,
  outcome text,
  error_code text,
  unique(job_id, attempt_number)
);

create table if not exists event_log (
  id bigint generated always as identity primary key,
  scope text not null,
  scope_id uuid not null,
  type text not null,
  payload jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists event_log_scope_idx on event_log(scope, scope_id, id);

create table if not exists artifacts (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null,
  scope_id uuid not null,
  artifact_type text not null,
  version integer not null,
  checksum text not null,
  byte_size bigint not null,
  locator text not null,
  producer_attempt_id uuid references job_attempts(id),
  committed_at timestamptz not null default clock_timestamp(),
  unique(scope_type, scope_id, artifact_type, version),
  unique(locator)
);

create table if not exists snapshot_files (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references snapshots(id) on delete cascade,
  path text not null,
  previous_path text,
  status text not null check (status in ('added', 'modified', 'deleted', 'renamed', 'binary')),
  additions integer,
  deletions integer,
  patch_artifact_id uuid references artifacts(id),
  unique(snapshot_id, path)
);

