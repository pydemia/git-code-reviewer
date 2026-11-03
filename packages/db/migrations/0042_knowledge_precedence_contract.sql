-- v2 carries the approved memory's grouping identity. Preserve immutable old
-- releases, but prevent an old worker from acknowledging a v2 publication job.
create function require_review_knowledge_v2() returns trigger language plpgsql as $$
begin
  if (new.published_revision,new.current_release_id) is distinct from (old.published_revision,old.current_release_id)
    and new.current_release_id is not null
    and not exists(select 1 from review_knowledge_releases r join artifacts a on a.id=r.artifact_id
      where r.id=new.current_release_id and a.version>=2) then
    raise exception 'knowledge publication requires a v2 worker';
  end if;
  return new;
end; $$;
create trigger review_knowledge_v2_publication before update on review_knowledge_scopes
for each row execute function require_review_knowledge_v2();
select request_review_knowledge(repository_id,component,owner_user_id,'contract.v2')
from review_knowledge_scopes order by repository_id,component,owner_key;
