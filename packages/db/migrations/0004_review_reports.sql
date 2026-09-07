alter table analysis_runs
  add column if not exists analyzer_version text not null default 'analyzer-v1',
  add column if not exists model_profile text not null default 'disabled',
  add column if not exists policy_hash text not null default 'policy-v1',
  add column if not exists limitations jsonb not null default '[]'::jsonb;

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null unique references analysis_runs(id) on delete cascade,
  schema_version integer not null check (schema_version = 1),
  grade text not null check (grade in ('exceptional', 'proficient', 'adequate', 'insufficient', 'critical')),
  summary text not null,
  has_critical_findings boolean not null,
  coverage jsonb not null,
  impact jsonb not null,
  artifact_id uuid references artifacts(id),
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists findings (
  id uuid primary key,
  report_id uuid not null references reports(id) on delete cascade,
  priority text not null check (priority in ('P0', 'P1', 'P2', 'P3')),
  category text not null check (category in (
    'correctness', 'security', 'compatibility', 'testing', 'maintenance',
    'optimization', 'review-history', 'setting'
  )),
  confidence text not null check (confidence in ('low', 'medium', 'high')),
  source_kind text not null check (source_kind in ('analyzer', 'model')),
  producer text not null,
  rule text,
  title text not null,
  problem text not null,
  impact text not null,
  recommendation text not null,
  anchor jsonb not null,
  evidence jsonb not null,
  verification jsonb not null,
  fingerprint text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(report_id, fingerprint)
);
create index if not exists findings_report_priority_idx on findings(report_id, priority, id);

create table if not exists code_objects (
  id uuid primary key,
  analysis_run_id uuid not null references analysis_runs(id) on delete cascade,
  kind text not null,
  qualified_name text not null,
  change text not null check (change in ('added', 'removed', 'modified', 'unchanged')),
  definition jsonb,
  unique(analysis_run_id, qualified_name)
);

create table if not exists code_relations (
  id uuid primary key,
  analysis_run_id uuid not null references analysis_runs(id) on delete cascade,
  source_object_id uuid not null references code_objects(id) on delete cascade,
  target_object_id uuid not null references code_objects(id) on delete cascade,
  kind text not null,
  distance integer not null check (distance > 0),
  change text not null check (change in ('added', 'removed', 'unchanged')),
  confidence text not null check (confidence in ('low', 'medium', 'high')),
  evidence jsonb not null,
  unique(analysis_run_id, source_object_id, target_object_id, kind)
);
create index if not exists code_relations_source_idx on code_relations(analysis_run_id, source_object_id);
create index if not exists code_relations_target_idx on code_relations(analysis_run_id, target_object_id);
