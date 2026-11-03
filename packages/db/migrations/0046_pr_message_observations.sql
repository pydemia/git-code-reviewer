-- REST evidence is retained independently of body-only versions. Null provenance
-- means legacy/unobserved; it does not mean an unresolved or current thread.
alter table github_pr_messages
  add column provenance jsonb check(provenance is null or jsonb_typeof(provenance)='object'),
  add column observation_hash text check(observation_hash is null or observation_hash ~ '^[0-9a-f]{64}$'),
  add column last_sync_started_at timestamptz;

create table github_pr_message_observations (
  id bigint generated always as identity primary key,
  message_id uuid not null references github_pr_messages(id) on delete cascade,
  observation_hash text not null check(observation_hash ~ '^[0-9a-f]{64}$'),
  snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
  sync_started_at timestamptz not null,
  observed_at timestamptz not null default clock_timestamp()
);
create index github_pr_message_observations_history_idx
  on github_pr_message_observations(message_id,id desc);
create trigger github_pr_message_observations_immutable before update or delete
  on github_pr_message_observations for each row
  execute function reject_review_criteria_history_mutation();

-- Repeated observations update freshness but do not invalidate unchanged knowledge.
drop trigger knowledge_pr_source_changed on github_pr_messages;
create trigger knowledge_pr_source_changed after update on github_pr_messages
  for each row when (
    (old.body,old.content_hash,old.path,old.line,old.side,old.commit_sha,
     old.in_reply_to_github_id,old.provenance,old.observation_hash)
    is distinct from
    (new.body,new.content_hash,new.path,new.line,new.side,new.commit_sha,
     new.in_reply_to_github_id,new.provenance,new.observation_hash))
  execute function review_knowledge_invalidate();
create trigger knowledge_pr_source_deleted after delete on github_pr_messages
  for each row execute function review_knowledge_invalidate();
