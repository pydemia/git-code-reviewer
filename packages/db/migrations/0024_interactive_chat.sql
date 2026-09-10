create table chat_runs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references chat_sessions(id) on delete cascade,
  user_message_id uuid references chat_messages(id) on delete set null,
  assistant_message_id uuid references chat_messages(id) on delete set null,
  idempotency_key uuid not null,
  status text not null default 'queued' check (status in ('queued','running','awaiting_input','waiting_capacity','cancelling','completed','partial','failed','cancelled')),
  phase text not null default 'queued',
  configuration jsonb not null,
  checkpoint jsonb not null default '{"messages":[],"pendingTools":[],"evidence":[],"instructions":[]}'::jsonb,
  content text not null default '',
  error_code text,
  model_calls integer not null default 0 check (model_calls >= 0),
  tool_calls integer not null default 0 check (tool_calls >= 0),
  context_bytes integer not null default 0 check (context_bytes >= 0),
  fence bigint not null default 0,
  lease_owner text,
  lease_expires_at timestamptz,
  resume_after timestamptz,
  expires_at timestamptz not null default clock_timestamp() + interval '24 hours',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(session_id,idempotency_key)
);
create unique index chat_runs_active_session on chat_runs(session_id) where status in ('queued','running','awaiting_input','waiting_capacity','cancelling');
create index chat_runs_claim on chat_runs(status,resume_after,lease_expires_at);
create table chat_run_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references chat_runs(id) on delete cascade,
  step_key text not null,
  kind text not null,
  status text not null,
  result jsonb,
  created_at timestamptz not null default clock_timestamp(),
  unique(run_id,step_key)
);
create table chat_run_instructions (
  id uuid primary key,
  run_id uuid not null references chat_runs(id) on delete cascade,
  content text not null,
  applied_step integer,
  created_at timestamptz not null default clock_timestamp()
);
create table chat_questions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references chat_runs(id) on delete cascade,
  call_id text not null,
  question text not null,
  options jsonb not null default '[]',
  answer text,
  expires_at timestamptz not null default clock_timestamp() + interval '30 minutes',
  answered_at timestamptz,
  unique(run_id,call_id)
);
create table chat_source_evidence (
  run_id uuid not null references chat_runs(id) on delete cascade,
  unit_id text not null,
  metadata jsonb not null,
  content text not null,
  model_step integer not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(run_id,unit_id)
);
create table model_account_capacity (
  quota_key text primary key,
  reservation_id uuid,
  lease_expires_at timestamptz,
  cooldown_until timestamptz,
  updated_at timestamptz not null default clock_timestamp()
);
create table model_request_ledger (
  id uuid primary key default gen_random_uuid(),
  quota_key text not null references model_account_capacity(quota_key),
  run_key text not null,
  state text not null check (state in ('reserved','sent','completed','failed','interrupted')),
  input_bytes integer not null,
  usage jsonb,
  created_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz
);
create index model_request_ledger_run on model_request_ledger(run_key);
