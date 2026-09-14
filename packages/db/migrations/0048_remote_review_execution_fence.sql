alter table client_review_jobs
  add column invocation_started_at timestamptz,
  add column next_attempt_at timestamptz not null default clock_timestamp();
create index client_review_jobs_lease_expiry on client_review_jobs(lease_until)
  where state in ('running','cancel-requested');
