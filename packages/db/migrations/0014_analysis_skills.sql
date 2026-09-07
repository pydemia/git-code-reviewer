create table analysis_skill_versions (
  id uuid primary key default gen_random_uuid(),
  version integer not null unique check (version > 0),
  bundle jsonb not null check (jsonb_typeof(bundle) = 'object'),
  content_hash text not null unique check (content_hash ~ '^[0-9a-f]{64}$'),
  active boolean not null default false,
  created_by uuid not null references users(id),
  activated_by uuid references users(id),
  activated_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check (bundle->>'hash' = content_hash),
  check (not active or (activated_by is not null and activated_at is not null))
);

create unique index analysis_skill_versions_active_idx on analysis_skill_versions(active) where active;

create function preserve_analysis_skill_version() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Analysis Skill versions cannot be deleted';
  end if;
  if (new.id, new.version, new.bundle, new.content_hash, new.created_by, new.created_at)
     is distinct from
     (old.id, old.version, old.bundle, old.content_hash, old.created_by, old.created_at) then
    raise exception 'Analysis Skill version content is immutable';
  end if;
  return new;
end;
$$;

create trigger analysis_skill_versions_immutable before update or delete on analysis_skill_versions
for each row execute function preserve_analysis_skill_version();

alter table analysis_runs
  add column skill_version_id uuid references analysis_skill_versions(id),
  add column skill_bundle jsonb,
  add column skill_hash text,
  add constraint analysis_runs_skill_snapshot_check check (
    (skill_bundle is null and skill_hash is null and skill_version_id is null)
    or (skill_bundle is not null and skill_hash is not null
      and skill_hash ~ '^[0-9a-f]{64}$' and skill_bundle->>'hash' = skill_hash)
  );

create index analysis_runs_skill_version_idx on analysis_runs(skill_version_id) where skill_version_id is not null;
