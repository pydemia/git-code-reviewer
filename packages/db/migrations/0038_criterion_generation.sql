-- A request is claimed once. A lost/expired execution is uncertain, never
-- automatically replayed against the provider with an unknown outcome.
create table review_criterion_generations (
  id uuid primary key,
  repository_id uuid not null references repositories(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  input_hash text not null check(input_hash ~ '^[0-9a-f]{64}$'),
  input jsonb not null check(jsonb_typeof(input) = 'object'),
  sources jsonb not null check(jsonb_typeof(sources) = 'array'),
  state text not null default 'queued' check(state in ('queued','running','completed','failed','uncertain','cancelled')),
  executor text,
  deadline_at timestamptz,
  rule_id uuid references review_rules(id) on delete set null,
  response_hash text check(response_hash ~ '^[0-9a-f]{64}$'),
  error_code text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check(state <> 'completed' or response_hash is not null)
);
create index review_criterion_generation_queue_idx on review_criterion_generations(created_at,id) where state='queued';
create index review_criterion_generation_owner_idx on review_criterion_generations(repository_id,owner_user_id,created_at desc);
create unique index review_criterion_generation_active_owner_idx on review_criterion_generations(owner_user_id) where state in ('queued','running');
