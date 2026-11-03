-- Preserve original messages when a complete, successful upstream read no longer
-- returns them. Absence is an observation, not proof of deletion or resolution.
alter table github_pr_messages add column upstream_state text not null default 'present'
  check(upstream_state in ('present','not-returned'));
create table review_history_coverage (
  pull_request_id uuid primary key references pull_requests(id),
  sync_started_at timestamptz not null,
  observed_at timestamptz not null default clock_timestamp(),
  message_count integer not null check(message_count>=0)
);
create table review_history_collections (
  id uuid primary key default gen_random_uuid(),
  repository_id uuid not null references repositories(id),
  requested_by uuid not null references users(id),
  request_key uuid not null,
  pull_numbers integer[] not null check(cardinality(pull_numbers) between 1 and 20),
  created_at timestamptz not null default clock_timestamp(),
  unique(repository_id,requested_by,request_key)
);
create table review_history_collection_items (
  collection_id uuid not null references review_history_collections(id),
  pull_request_id uuid not null references pull_requests(id),
  job_id uuid references jobs(id) on delete set null,
  completed_at timestamptz,
  message_count integer check(message_count>=0),
  primary key(collection_id,pull_request_id)
);
create index review_history_collections_repository_idx on review_history_collections(repository_id,created_at desc,id);
create index review_history_collection_items_job_idx on review_history_collection_items(job_id);
-- Existing publication invalidation also runs on a presence transition; no raw
-- message or private candidate is copied to the shared bundle.
create trigger knowledge_pr_source_presence_changed after update of upstream_state on github_pr_messages
  for each row when (old.upstream_state is distinct from new.upstream_state)
  execute function review_knowledge_invalidate();
