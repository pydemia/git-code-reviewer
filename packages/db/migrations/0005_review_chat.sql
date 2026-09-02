create table if not exists chat_sessions (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references analysis_runs(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  scope jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(analysis_run_id, user_id)
);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references chat_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  status text not null check (status in ('pending', 'completed', 'failed')),
  content text not null,
  citations jsonb not null default '[]'::jsonb,
  usage jsonb,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz
);
create index if not exists chat_messages_session_idx on chat_messages(session_id, created_at, id);
create index if not exists chat_messages_rate_idx on chat_messages(created_at)
  where role = 'user';
