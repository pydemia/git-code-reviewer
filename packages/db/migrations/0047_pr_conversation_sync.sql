-- Conversation refresh is independent from the PR metadata ETag. Only PRs that
-- were observed open (or already have collected recent source) enter this queue.
create table pull_request_conversation_sync (
  pull_request_id uuid primary key references pull_requests(id) on delete cascade,
  follow_until timestamptz,
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  consecutive_failures integer not null default 0 check(consecutive_failures>=0),
  last_error_code text,
  claim_token uuid,
  claim_until timestamptz
);
create index pull_request_conversation_sync_due_idx on pull_request_conversation_sync(next_attempt_at,pull_request_id);
insert into pull_request_conversation_sync(pull_request_id,follow_until)
select p.id,case when p.state='closed' then p.github_updated_at+interval '7 days' end
from pull_requests p join repositories r on r.id=p.repository_id
where r.enabled and r.deleted_at is null and
  (p.state='open' or (p.github_updated_at>clock_timestamp()-interval '7 days' and exists(
    select 1 from github_pr_messages m where m.pull_request_id=p.id)));
