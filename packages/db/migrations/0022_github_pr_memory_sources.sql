create table if not exists github_pr_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  repository_id uuid not null references repositories(id) on delete cascade,
  pull_request_id uuid not null references pull_requests(id) on delete cascade,
  github_id bigint not null,
  kind text not null check (kind in ('issue-comment', 'review', 'review-comment')),
  author_login text not null,
  author_type text not null default 'User',
  body text not null,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  path text,
  line integer,
  side text check (side is null or side in ('LEFT', 'RIGHT')),
  commit_sha text,
  in_reply_to_github_id bigint,
  html_url text not null,
  github_created_at timestamptz not null,
  github_updated_at timestamptz not null,
  last_observed_at timestamptz not null default clock_timestamp(),
  unique(repository_id, kind, github_id)
);
create index if not exists github_pr_messages_pull_idx
  on github_pr_messages(pull_request_id, github_created_at, github_id);

create table if not exists github_pr_message_versions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references github_pr_messages(id) on delete cascade,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  body text not null,
  path text,
  line integer,
  side text check (side is null or side in ('LEFT', 'RIGHT')),
  commit_sha text,
  github_updated_at timestamptz not null,
  observed_at timestamptz not null default clock_timestamp(),
  unique(message_id, content_hash)
);

create table if not exists github_pr_message_user_states (
  message_id uuid not null references github_pr_messages(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  state text not null check (state in ('available', 'saved', 'ignored')),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(message_id, user_id)
);

alter table review_memories
  drop constraint if exists review_memories_source_kind_check,
  add column if not exists source_github_pr_message_id uuid
    references github_pr_messages(id) on delete set null,
  add column if not exists source_github_pr_message_content_hash text
    check (source_github_pr_message_content_hash is null
      or source_github_pr_message_content_hash ~ '^[0-9a-f]{64}$');

alter table review_memories
  add constraint review_memories_source_kind_check
  check (source_kind in ('finding', 'chat-message', 'github-pr-message', 'manual'));
