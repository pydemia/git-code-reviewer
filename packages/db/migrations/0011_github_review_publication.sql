alter table repositories
  add column if not exists review_publishing_enabled boolean not null default false;

create table if not exists github_review_publications (
  pull_request_id uuid primary key references pull_requests(id) on delete cascade,
  target_analysis_run_id uuid references analysis_runs(id) on delete set null,
  published_analysis_run_id uuid references analysis_runs(id) on delete set null,
  head_sha text,
  comment_id bigint check (comment_id is null or comment_id > 0),
  comment_url text,
  body_hash text check (body_hash is null or body_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'pending'
    check (state in ('pending', 'publishing', 'published', 'failed', 'disabled')),
  last_error_code text,
  last_error_message text,
  last_attempt_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create index if not exists github_review_publications_state_idx
  on github_review_publications(state, updated_at);
