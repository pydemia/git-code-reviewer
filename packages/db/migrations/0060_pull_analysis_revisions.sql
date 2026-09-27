-- Keep snapshot/artifact revisions intact. PR history has its own durable sequence.
alter table analysis_runs add column pull_revision integer check (pull_revision > 0);

create table pull_analysis_revision_counters (
  pull_request_id uuid not null references pull_requests(id) on delete cascade,
  scope_key text not null,
  last_revision integer not null check (last_revision > 0),
  primary key (pull_request_id, scope_key)
);

with numbered as (
  select ar.id, row_number() over (
    partition by sr.pull_request_id, ar.memory_owner_user_id
    order by ar.created_at, ar.id
  )::integer as pull_revision
  from analysis_runs ar
  join snapshots s on s.id = ar.snapshot_id
  join snapshot_requests sr on sr.id = s.request_id
)
update analysis_runs ar set pull_revision = numbered.pull_revision
from numbered where ar.id = numbered.id;

insert into pull_analysis_revision_counters(pull_request_id, scope_key, last_revision)
select sr.pull_request_id, coalesce(ar.memory_owner_user_id::text, 'collective'),
       max(ar.pull_revision)
from analysis_runs ar
join snapshots s on s.id = ar.snapshot_id
join snapshot_requests sr on sr.id = s.request_id
group by sr.pull_request_id, ar.memory_owner_user_id;

create function assign_pull_analysis_revision() returns trigger language plpgsql as $$
declare
  pull_id uuid;
  next_revision integer;
begin
  select sr.pull_request_id into strict pull_id
  from snapshots s join snapshot_requests sr on sr.id = s.request_id
  where s.id = new.snapshot_id;

  insert into pull_analysis_revision_counters(pull_request_id, scope_key, last_revision)
  values (pull_id, coalesce(new.memory_owner_user_id::text, 'collective'), 1)
  on conflict (pull_request_id, scope_key) do update
    set last_revision = pull_analysis_revision_counters.last_revision + 1
  returning last_revision into next_revision;

  update analysis_runs set pull_revision = next_revision where id = new.id;
  return null;
end;
$$;

-- AFTER INSERT does not advance the counter on deduplicated ON CONFLICT updates.
-- The counter survives retention of old analyses; personal runs have private sequences.
create trigger analysis_runs_pull_revision after insert on analysis_runs
for each row execute function assign_pull_analysis_revision();
