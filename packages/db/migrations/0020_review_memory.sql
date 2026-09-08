alter table analysis_runs
  add column if not exists memory_hash text not null
    default '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
    check (memory_hash ~ '^[0-9a-f]{64}$'),
  add column if not exists memory_context jsonb not null default '[]'::jsonb
    check (jsonb_typeof(memory_context) = 'array'),
  add column if not exists memory_owner_user_id uuid references users(id);

create table if not exists review_memories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  repository_id uuid not null references repositories(id) on delete cascade,
  scope text not null check (scope in ('personal', 'collective')),
  owner_user_id uuid references users(id),
  kind text not null check (kind in (
    'recurring-finding', 'decision', 'false-positive', 'open-question'
  )),
  state text not null check (state in (
    'candidate', 'active', 'rejected', 'superseded', 'retired'
  )),
  revision integer not null default 1 check (revision > 0),
  supersedes_id uuid references review_memories(id),
  summary text not null check (char_length(summary) between 1 and 500),
  detail text not null default '' check (char_length(detail) <= 4000),
  recommendation text not null default '' check (char_length(recommendation) <= 2000),
  categories text[] not null default '{}',
  file_paths text[] not null default '{}',
  symbols text[] not null default '{}',
  search_text text not null,
  aggregation_key text not null check (aggregation_key ~ '^[0-9a-f]{64}$'),
  contributor_count integer not null default 1 check (contributor_count > 0),
  conflict_count integer not null default 0 check (conflict_count >= 0),
  confidence double precision not null default 0.5 check (confidence between 0 and 1),
  importance integer not null default 3 check (importance between 1 and 5),
  source_kind text not null check (source_kind in ('finding', 'chat-message', 'manual')),
  source_analysis_run_id uuid references analysis_runs(id) on delete set null,
  source_finding_id uuid references findings(id) on delete set null,
  source_chat_message_id uuid references chat_messages(id) on delete set null,
  source_base_sha text,
  source_head_sha text,
  source_anchor jsonb not null default '{}'::jsonb,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid references users(id) on delete set null,
  reviewed_by uuid references users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text not null default '' check (char_length(review_note) <= 2000),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (supersedes_id is null or supersedes_id <> id),
  check (
    (scope = 'personal' and owner_user_id is not null)
    or (scope = 'collective' and owner_user_id is null)
  ),
  check (
    (state = 'candidate' and reviewed_at is null)
    or (state <> 'candidate' and reviewed_at is not null)
  )
);

create unique index if not exists review_memories_personal_candidate_active_hash_idx
  on review_memories(repository_id, owner_user_id, content_hash)
  where scope = 'personal' and state in ('candidate', 'active');
create unique index if not exists review_memories_collective_candidate_active_key_idx
  on review_memories(repository_id, aggregation_key)
  where scope = 'collective' and state in ('candidate', 'active');
create index if not exists review_memories_scope_idx
  on review_memories(tenant_id, repository_id, scope, owner_user_id, state,
    reviewed_at desc, created_at desc);
create index if not exists review_memories_file_paths_idx
  on review_memories using gin(file_paths);
create index if not exists review_memories_symbols_idx
  on review_memories using gin(symbols);
create index if not exists review_memories_categories_idx
  on review_memories using gin(categories);
create index if not exists review_memories_search_idx
  on review_memories using gin(to_tsvector('simple', search_text));

create table if not exists review_memory_contributions (
  collective_memory_id uuid not null references review_memories(id) on delete cascade,
  personal_memory_id uuid not null references review_memories(id) on delete cascade,
  contributor_user_id uuid references users(id) on delete set null,
  personal_revision integer not null check (personal_revision > 0),
  agreement text not null check (agreement in ('support', 'conflict')),
  created_at timestamptz not null default clock_timestamp(),
  primary key(collective_memory_id, personal_memory_id),
  check (collective_memory_id <> personal_memory_id)
);
create index if not exists review_memory_contributions_personal_idx
  on review_memory_contributions(personal_memory_id, collective_memory_id);

create table if not exists review_memory_events (
  id bigint generated always as identity primary key,
  memory_id uuid not null references review_memories(id) on delete cascade,
  action text not null check (action in (
    'created', 'aggregated', 'activated', 'rejected', 'retired', 'superseded'
  )),
  actor_user_id uuid references users(id) on delete set null,
  before_state text check (before_state is null or before_state in (
    'candidate', 'active', 'rejected', 'superseded', 'retired'
  )),
  after_state text not null check (after_state in (
    'candidate', 'active', 'rejected', 'superseded', 'retired'
  )),
  revision integer not null check (revision > 0),
  note text not null default '' check (char_length(note) <= 2000),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists review_memory_events_memory_idx
  on review_memory_events(memory_id, id);
