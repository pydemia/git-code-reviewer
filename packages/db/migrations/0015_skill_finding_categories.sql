-- Perspective name은 배포 시 고정된 enum이 아니라 검증된 Skill name을 따른다.
alter table findings drop constraint findings_category_check;
alter table findings add constraint findings_category_check
  check (category ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' and length(category) <= 64);

create function preserve_analysis_skill_snapshot() returns trigger language plpgsql as $$
begin
  if old.skill_bundle is not null and
     (new.skill_version_id, new.skill_bundle, new.skill_hash) is distinct from
     (old.skill_version_id, old.skill_bundle, old.skill_hash) then
    raise exception 'Analysis Skill snapshot is immutable';
  end if;
  return new;
end;
$$;

create trigger analysis_runs_skill_snapshot_immutable before update on analysis_runs
for each row execute function preserve_analysis_skill_snapshot();
