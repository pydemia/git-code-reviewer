create index if not exists pull_requests_merged_retention_idx
  on pull_requests(repository_id, merged_at desc, id desc)
  where state = 'closed' and merged_at is not null;

create index if not exists operations_active_pull_request_idx
  on operations(scope_id)
  where scope_type = 'pull_request'
    and state in ('queued', 'polling', 'materializing', 'analyzing');
