alter table jobs add column recovery_count integer not null default 0 check (recovery_count between 0 and 3);

create table analysis_model_checkpoints (
  analysis_id uuid not null references analysis_runs(id) on delete cascade,
  input_hash text not null,
  stage text not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (analysis_id, input_hash),
  check (octet_length(result::text) <= 1048576)
);
