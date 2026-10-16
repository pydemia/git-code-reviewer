-- Test code remains available as review context, but is not a finding target by default.
alter table repositories
  add column review_test_code boolean not null default false;

-- Pin the repository preference when an analysis is created so later setting changes
-- cannot alter queued, resumed, or manually re-run analysis input.
alter table analysis_runs
  add column review_test_code boolean not null default false;
