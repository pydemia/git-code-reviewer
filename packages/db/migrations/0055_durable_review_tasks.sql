-- The complete file manifest and immutable task inputs survive worker restarts.
-- Source text remains in the existing snapshot artifacts; plan JSON stores hashes/references.
create table analysis_review_plans (
  analysis_id uuid primary key references analysis_runs(id) on delete cascade,
  plan_hash text not null check (length(plan_hash)=64),
  manifest jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create table analysis_review_tasks (
  analysis_id uuid not null references analysis_review_plans(analysis_id) on delete cascade,
  task_id text not null,
  input_hash text not null check (length(input_hash)=64),
  kind text not null check (kind in ('group','boundary','summary')),
  state text not null default 'pending' check (state in ('pending','running','completed','retry-wait','budget-wait','failed','blocked')),
  attempt_count integer not null default 0 check (attempt_count>=0),
  job_attempt_id uuid references job_attempts(id),
  result jsonb,
  error_code text,
  retry_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (analysis_id,task_id),
  check ((state='completed')=(result is not null))
);
create index analysis_review_tasks_pending on analysis_review_tasks(analysis_id,state);
alter table jobs add column model_defer_count integer not null default 0 check (model_defer_count>=0);
alter table analysis_runs add column resume_from_analysis_id uuid references analysis_runs(id);
create unique index analysis_resume_once on analysis_runs(resume_from_analysis_id) where resume_from_analysis_id is not null;
