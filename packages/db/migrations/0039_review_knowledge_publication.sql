-- Projection approval is separate from memory activation. Shared artifacts never
-- serialize source_anchor, chat text, contributor identities or raw PR messages.
create table review_knowledge_memory_projections (
  memory_id uuid primary key references review_memories(id) on delete cascade,
  revision integer not null check(revision>0),
  source_fingerprint text not null check(source_fingerprint ~ '^[0-9a-f]{64}$'),
  content jsonb not null check(jsonb_typeof(content)='object'),
  approved_by uuid not null,
  approved_at timestamptz not null default clock_timestamp()
);
create table review_knowledge_scopes (
  id uuid primary key default gen_random_uuid(),
  repository_id uuid not null references repositories(id) on delete cascade,
  component text not null check(component in ('policy','collective','personal')),
  owner_user_id uuid references users(id) on delete cascade,
  owner_key text generated always as (coalesce(owner_user_id::text,'')) stored,
  requested_revision bigint not null default 0,
  published_revision bigint not null default 0,
  release_sequence integer not null default 0,
  current_release_id uuid,
  claim_token uuid,
  claim_until timestamptz,
  retry_after timestamptz not null default clock_timestamp(),
  last_error text,
  last_excluded_items jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default clock_timestamp(),
  unique(repository_id,component,owner_key),
  check((component='personal')=(owner_user_id is not null)),
  check(requested_revision>=published_revision and published_revision>=0)
);
create table review_knowledge_outbox (
  scope_id uuid not null references review_knowledge_scopes(id) on delete cascade,
  revision bigint not null,
  reason text not null,
  created_at timestamptz not null default clock_timestamp(),
  processed_at timestamptz,
  primary key(scope_id,revision)
);
create table review_knowledge_releases (
  id uuid primary key default gen_random_uuid(),
  scope_id uuid not null references review_knowledge_scopes(id) on delete cascade,
  sequence integer not null check(sequence>0),
  source_revision bigint not null,
  artifact_id uuid not null references artifacts(id) deferrable initially deferred,
  content_hash text not null check(content_hash ~ '^[0-9a-f]{64}$'),
  byte_size integer not null check(byte_size>0 and byte_size<=2097152),
  excluded_items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  unique(scope_id,sequence),unique(id,scope_id)
);
alter table review_knowledge_scopes add constraint review_knowledge_current_release_fk
 foreign key(current_release_id,id) references review_knowledge_releases(id,scope_id) deferrable initially deferred;
create index review_knowledge_pending_idx on review_knowledge_scopes(retry_after,id)
 where requested_revision>published_revision;
create trigger review_knowledge_releases_immutable before update or delete on review_knowledge_releases
 for each row execute function reject_review_criteria_history_mutation();

create function request_review_knowledge(repo uuid, part text, owner_id uuid, cause text)
 returns uuid language plpgsql as $$
declare scope_id uuid; revision_id bigint;
begin
 if not exists(select 1 from repositories where id=repo) then return null; end if;
 if owner_id is not null and not exists(select 1 from users where id=owner_id) then return null; end if;
 insert into review_knowledge_scopes(repository_id,component,owner_user_id,requested_revision)
 values(repo,part,owner_id,1)
 on conflict(repository_id,component,owner_key) do update
 set requested_revision=review_knowledge_scopes.requested_revision+1,
     retry_after=clock_timestamp(),last_error=null,updated_at=clock_timestamp()
 returning id,requested_revision into scope_id,revision_id;
 insert into review_knowledge_outbox(scope_id,revision,reason) values(scope_id,revision_id,cause);
 return scope_id;
end; $$;

create function invalidate_review_knowledge_repository(repo uuid,cause text)
 returns void language plpgsql as $$
declare s record;
begin
 if not exists(select 1 from repositories where id=repo) then return; end if;
 perform request_review_knowledge(repo,'policy',null,cause);
 perform request_review_knowledge(repo,'collective',null,cause);
 for s in select owner_user_id from review_knowledge_scopes where repository_id=repo and component='personal' order by owner_key loop
   perform request_review_knowledge(repo,'personal',s.owner_user_id,cause);
 end loop;
end; $$;

create function review_knowledge_invalidate() returns trigger language plpgsql as $$
declare row_data jsonb; repo uuid; memory record; s record;
begin
 row_data=case when tg_level='STATEMENT' then '{}'::jsonb when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 if tg_table_name='review_memories' then
   repo=(row_data->>'repository_id')::uuid;
   -- A public criterion can refer to a collective memory snapshot.
   if row_data->>'scope'='collective' then perform request_review_knowledge(repo,'policy',null,'memory.source-changed'); end if;
   perform request_review_knowledge(repo,row_data->>'scope',(row_data->>'owner_user_id')::uuid,'memory.changed');
   if tg_op='UPDATE' and (old.repository_id,old.scope,old.owner_user_id) is distinct from (new.repository_id,new.scope,new.owner_user_id) then
     perform invalidate_review_knowledge_repository(old.repository_id,'memory.scope-changed');
   end if;
 elsif tg_table_name='review_knowledge_memory_projections' then
   select * into memory from review_memories where id=(row_data->>'memory_id')::uuid;
   if found then perform request_review_knowledge(memory.repository_id,memory.scope,memory.owner_user_id,'memory.projection'); end if;
 elsif tg_table_name in ('review_rule_events','review_rule_evaluations','review_rule_exceptions') then
   select repository_id into repo from review_rules where id=(row_data->>'rule_id')::uuid;
   perform request_review_knowledge(repo,'policy',null,tg_table_name);
 elsif tg_table_name='review_rule_exception_revocations' then
   select r.repository_id into repo from review_rule_exceptions e join review_rules r on r.id=e.rule_id where e.id=(row_data->>'exception_id')::uuid;
   perform request_review_knowledge(repo,'policy',null,'exception.revoked');
 elsif tg_table_name='review_rules' then
   perform request_review_knowledge((row_data->>'repository_id')::uuid,'policy',null,'rule.changed');
 elsif tg_table_name='github_pr_messages' then
   repo=(row_data->>'repository_id')::uuid;
   perform invalidate_review_knowledge_repository(repo,tg_table_name);
 elsif tg_table_name in ('chat_messages','findings') then
   for s in select distinct repository_id from review_memories where
     (tg_table_name='chat_messages' and source_chat_message_id=(row_data->>'id')::uuid) or
     (tg_table_name='findings' and source_finding_id=(row_data->>'id')::uuid) order by repository_id loop
     perform invalidate_review_knowledge_repository(s.repository_id,'memory.source-changed');
   end loop;
 elsif tg_table_name='github_pr_message_user_states' then
   select repository_id into repo from github_pr_messages where id=(row_data->>'message_id')::uuid;
   perform request_review_knowledge(repo,'personal',(row_data->>'user_id')::uuid,'personal.source-state');
 elsif tg_table_name='repositories' then
   if tg_op<>'DELETE' then perform invalidate_review_knowledge_repository(new.id,'repository.changed'); end if;
 else
   -- Skill activation and permission withdrawal can invalidate approved content.
   for s in select distinct repository_id from review_knowledge_scopes order by repository_id loop
     perform invalidate_review_knowledge_repository(s.repository_id,tg_table_name);
   end loop;
 end if;
 return null;
end; $$;

create trigger knowledge_memory_changed after insert or update or delete on review_memories
 for each row execute function review_knowledge_invalidate();
create trigger knowledge_projection_changed after insert or update or delete on review_knowledge_memory_projections
 for each row execute function review_knowledge_invalidate();
create trigger knowledge_rule_changed after insert or update or delete on review_rules
 for each row execute function review_knowledge_invalidate();
create trigger knowledge_rule_event after insert on review_rule_events
 for each row execute function review_knowledge_invalidate();
create trigger knowledge_evaluation_changed after insert on review_rule_evaluations
 for each row execute function review_knowledge_invalidate();
create trigger knowledge_exception_changed after insert on review_rule_exceptions
 for each row execute function review_knowledge_invalidate();
create trigger knowledge_exception_revoked after insert on review_rule_exception_revocations
 for each row execute function review_knowledge_invalidate();
create trigger knowledge_pr_source_changed after update or delete on github_pr_messages
 for each row execute function review_knowledge_invalidate();
create trigger knowledge_repository_created after insert on repositories
 for each row execute function review_knowledge_invalidate();
create trigger knowledge_repository_changed after update of tenant_id,instance_id,enabled,deleted_at on repositories
 for each row execute function review_knowledge_invalidate();
create trigger knowledge_skills_changed after insert or update or delete on analysis_skill_versions
 for each statement execute function review_knowledge_invalidate();
create trigger knowledge_roles_changed after insert or update or delete on review_criteria_roles
 for each statement execute function review_knowledge_invalidate();
create trigger knowledge_grants_changed after insert or update or delete on repository_grants
 for each statement execute function review_knowledge_invalidate();
create trigger knowledge_memberships_changed after insert or update or delete on tenant_memberships
 for each statement execute function review_knowledge_invalidate();
create trigger knowledge_user_changed after update of enabled,deleted_at,role,groups_json on users
 for each row when ((old.enabled,old.deleted_at,old.role,old.groups_json) is distinct from (new.enabled,new.deleted_at,new.role,new.groups_json)) execute function review_knowledge_invalidate();
create trigger knowledge_tenant_changed after update of enabled on tenants
 for each statement execute function review_knowledge_invalidate();
create trigger knowledge_instance_changed after update of enabled on github_instances
 for each statement execute function review_knowledge_invalidate();

create function cleanup_review_knowledge_scope() returns trigger language plpgsql as $$
begin
 delete from artifacts where scope_type='review-knowledge' and scope_id=old.id;
 return null;
end; $$;
create trigger knowledge_scope_deleted after delete on review_knowledge_scopes
 for each row execute function cleanup_review_knowledge_scope();

-- Existing repositories get policy/collective baselines; an authenticated user's
-- empty personal component is requested lazily when that scope is first used.
select invalidate_review_knowledge_repository(id,'initial-publication') from repositories where enabled and deleted_at is null order by id;

create trigger knowledge_user_deleted after delete on users
 for each statement execute function review_knowledge_invalidate();
create trigger knowledge_chat_source_changed after update or delete on chat_messages
 for each row execute function review_knowledge_invalidate();
create trigger knowledge_finding_source_changed after update or delete on findings
 for each row execute function review_knowledge_invalidate();
create trigger knowledge_personal_source_state after insert or update or delete on github_pr_message_user_states
 for each row execute function review_knowledge_invalidate();
create index knowledge_memory_chat_source_idx on review_memories(source_chat_message_id) where source_chat_message_id is not null;
create index knowledge_memory_finding_source_idx on review_memories(source_finding_id) where source_finding_id is not null;
