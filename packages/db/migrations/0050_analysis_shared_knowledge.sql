alter table analysis_runs add column shared_knowledge jsonb;
alter table analysis_runs add column shared_knowledge_hash text;
alter table analysis_runs add constraint analysis_shared_knowledge_pair check (
 (shared_knowledge is null and shared_knowledge_hash is null) or
 (shared_knowledge is not null and shared_knowledge_hash ~ '^[a-f0-9]{64}$')
);
create function preserve_analysis_shared_knowledge() returns trigger language plpgsql as $$
begin
 if old.shared_knowledge is distinct from new.shared_knowledge or old.shared_knowledge_hash is distinct from new.shared_knowledge_hash then
  raise exception 'Analysis shared knowledge is immutable' using errcode='23514';
 end if;
 return new;
end; $$;
create trigger analysis_shared_knowledge_immutable before update of shared_knowledge,shared_knowledge_hash on analysis_runs for each row execute function preserve_analysis_shared_knowledge();
create table analysis_shared_selections (
 analysis_id uuid primary key references analysis_runs(id) on delete cascade,
 context jsonb not null,
 context_hash text not null check(context_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default clock_timestamp()
);
create trigger analysis_shared_selection_immutable before update or delete on analysis_shared_selections for each row execute function reject_review_criteria_history_mutation();
