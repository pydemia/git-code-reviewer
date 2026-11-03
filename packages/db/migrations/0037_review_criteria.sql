-- Additive: existing review_memories and their lifecycle remain independent.
create table review_criteria_roles (
  repository_id uuid not null references repositories(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('maintainer', 'security-owner', 'domain-owner')),
  granted_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(repository_id, user_id, role)
);

create table review_decisions (
  id uuid primary key default gen_random_uuid(),
  repository_id uuid not null references repositories(id) on delete cascade,
  outcome text not null check (outcome in ('defect', 'false-positive', 'accepted-exception', 'design-decision', 'open-question')),
  reasoning text not null check (char_length(reasoning) between 1 and 4000),
  origin text not null check (origin in ('maintainer-curated', 'model-candidate')),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  sources jsonb not null check (jsonb_typeof(sources) = 'array' and jsonb_array_length(sources) between 1 and 12),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(id, repository_id)
);

create table review_rules (
  id uuid primary key default gen_random_uuid(),
  repository_id uuid not null references repositories(id) on delete cascade,
  current_revision integer not null default 1 check (current_revision > 0),
  version integer not null default 1 check (version > 0),
  state text not null default 'draft' check (state in ('draft', 'evaluated', 'shadow', 'active', 'retired')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(id, repository_id)
);

create table review_rule_revisions (
  rule_id uuid not null,
  repository_id uuid not null,
  revision integer not null check (revision > 0),
  supersedes integer,
  decision_id uuid not null,
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(rule_id, revision),
  foreign key(rule_id, repository_id) references review_rules(id, repository_id) on delete cascade,
  foreign key(decision_id, repository_id) references review_decisions(id, repository_id) deferrable initially deferred,
  foreign key(rule_id, supersedes) references review_rule_revisions(rule_id, revision) deferrable initially deferred,
  check ((revision = 1 and supersedes is null) or (revision > 1 and supersedes = revision - 1))
);
alter table review_rules add constraint review_rules_current_revision_fk
  foreign key(id, current_revision) references review_rule_revisions(rule_id, revision)
  deferrable initially deferred;

create table review_rule_evaluations (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null,
  revision integer not null,
  method text not null default 'manual' check (method = 'manual'),
  cases jsonb not null check (jsonb_typeof(cases) = 'array' and jsonb_array_length(cases) = 4),
  passed boolean not null,
  note text not null check (char_length(note) between 1 and 2000),
  actor_user_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key(rule_id, revision) references review_rule_revisions(rule_id, revision) on delete cascade
);
create table review_rule_events (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null,
  revision integer not null,
  action text not null,
  actor_user_id uuid not null,
  note text not null default '' check (char_length(note) <= 2000),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(rule_id, revision) references review_rule_revisions(rule_id, revision) on delete cascade
);
create unique index review_rule_owner_approval_idx on review_rule_events(rule_id, revision, actor_user_id)
  where action = 'approve-owner';
create index review_rules_repository_idx on review_rules(repository_id, updated_at desc, id);
create index review_rule_evaluations_history_idx on review_rule_evaluations(rule_id, revision, created_at desc, id);
create index review_rule_events_history_idx on review_rule_events(rule_id, revision, created_at, id);

-- Requests are repository-visible proposals. Resolving a correction records
-- acknowledgement; only a separately authored revision can change a criterion.
create table review_rule_feedback (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null,
  revision integer not null,
  request jsonb not null check (request->>'kind' in ('correction','exception')),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(id, rule_id, revision),
  foreign key(rule_id, revision) references review_rule_revisions(rule_id, revision) on delete cascade
);
create table review_rule_feedback_resolutions (
  request_id uuid primary key references review_rule_feedback(id) on delete cascade,
  action text not null check(action in ('acknowledge','approve-exception','reject')),
  note text not null check(char_length(note) between 1 and 2000),
  actor_user_id uuid not null,
  created_at timestamptz not null default clock_timestamp()
);
create index review_rule_feedback_history_idx on review_rule_feedback(rule_id, created_at desc, id);

create table review_rule_exceptions (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null,
  revision integer not null,
  applies_to jsonb not null check (jsonb_typeof(applies_to) = 'object'),
  reason text not null check (char_length(reason) between 1 and 4000),
  starts_at timestamptz not null,
  expires_at timestamptz not null,
  approved_by uuid not null,
  request_id uuid not null unique,
  foreign key(request_id, rule_id, revision) references review_rule_feedback(id, rule_id, revision) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  foreign key(rule_id, revision) references review_rule_revisions(rule_id, revision) on delete cascade,
  check (expires_at > starts_at)
);

create table review_rule_exception_revocations (
  exception_id uuid primary key references review_rule_exceptions(id) on delete cascade,
  note text not null check(char_length(note) between 1 and 2000),
  actor_user_id uuid not null,
  created_at timestamptz not null default clock_timestamp()
);

-- A source edit cannot silently change an approved revision. Cascading repository
-- deletion is allowed; direct mutation of historical evidence is rejected.
create function reject_review_criteria_history_mutation() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  raise exception 'Review criteria history is immutable' using errcode = '23514';
end;
$$;
create trigger review_decisions_immutable before update or delete on review_decisions
  for each row execute function reject_review_criteria_history_mutation();
create trigger review_rule_revisions_immutable before update or delete on review_rule_revisions
  for each row execute function reject_review_criteria_history_mutation();
create trigger review_rule_evaluations_immutable before update or delete on review_rule_evaluations
  for each row execute function reject_review_criteria_history_mutation();
create trigger review_rule_events_immutable before update or delete on review_rule_events
  for each row execute function reject_review_criteria_history_mutation();
create trigger review_rule_feedback_immutable before update or delete on review_rule_feedback
  for each row execute function reject_review_criteria_history_mutation();
create trigger review_rule_feedback_resolutions_immutable before update or delete on review_rule_feedback_resolutions
  for each row execute function reject_review_criteria_history_mutation();
create trigger review_rule_exceptions_immutable before update or delete on review_rule_exceptions
  for each row execute function reject_review_criteria_history_mutation();
create trigger review_rule_exception_revocations_immutable before update or delete on review_rule_exception_revocations
  for each row execute function reject_review_criteria_history_mutation();
