-- 기존 version의 hash는 재작성하지 않는다. 새 version은 instructions와 level을 함께 hash한다.
alter table analysis_prompt_versions
  add column severity_level text not null default 'moderate'
    check (severity_level in ('lean', 'generous', 'moderate', 'rigorous', 'severe'));
alter table analysis_prompt_versions drop constraint analysis_prompt_versions_instructions_check;
alter table analysis_prompt_versions add constraint analysis_prompt_versions_instructions_check
  check (char_length(instructions) between 0 and 12000);

-- NULL은 migration 이전에 만들어진 run: 기존 분석 동작을 유지한다.
alter table analysis_runs add column severity_level text
  check (severity_level in ('lean', 'generous', 'moderate', 'rigorous', 'severe'));

create function preserve_analysis_prompt_version() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Analysis Prompt versions cannot be deleted';
  end if;
  if (new.id, new.tenant_id, new.version, new.instructions, new.severity_level,
      new.content_hash, new.created_by, new.created_at) is distinct from
     (old.id, old.tenant_id, old.version, old.instructions, old.severity_level,
      old.content_hash, old.created_by, old.created_at) then
    raise exception 'Analysis Prompt version content is immutable';
  end if;
  return new;
end;
$$;
create trigger analysis_prompt_versions_immutable before update or delete on analysis_prompt_versions
for each row execute function preserve_analysis_prompt_version();

create function preserve_analysis_prompt_snapshot() returns trigger language plpgsql as $$
begin
  if (new.prompt_version_id, new.prompt_hash, new.severity_level) is distinct from
     (old.prompt_version_id, old.prompt_hash, old.severity_level) then
    raise exception 'Analysis Prompt snapshot is immutable';
  end if;
  return new;
end;
$$;
create trigger analysis_runs_prompt_snapshot_immutable before update on analysis_runs
for each row execute function preserve_analysis_prompt_snapshot();
