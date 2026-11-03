create table review_knowledge_security_state (
 singleton boolean primary key default true check(singleton),
 server_id uuid,
 authorization_revision bigint not null default 1 check(authorization_revision>0)
);
insert into review_knowledge_security_state(singleton) values(true);
create table review_knowledge_signing_keys (
 key_id text primary key,
 public_key_hash text not null check(public_key_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz not null default clock_timestamp()
);
create trigger knowledge_signing_keys_immutable before update or delete on review_knowledge_signing_keys
 for each row execute function reject_review_criteria_history_mutation();
create table review_knowledge_manifests (
 id uuid primary key,
 repository_id uuid not null references repositories(id) on delete cascade,
 owner_user_id uuid not null references users(id) on delete cascade,
 recipe_hash text not null check(recipe_hash ~ '^[0-9a-f]{64}$'),
 manifest jsonb not null,
 manifest_hash text not null check(manifest_hash ~ '^[0-9a-f]{64}$'),
 refresh_after timestamptz not null,
 expires_at timestamptz not null,
 created_at timestamptz not null default clock_timestamp()
);
create index knowledge_manifest_cache_idx on review_knowledge_manifests(repository_id,owner_user_id,recipe_hash,refresh_after desc);
create index knowledge_manifest_expiry_idx on review_knowledge_manifests(expires_at,id);
create function guard_knowledge_manifest_history() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' and (pg_trigger_depth()>1 or old.expires_at<=clock_timestamp()) then return old; end if;
 raise exception 'Knowledge manifests are immutable until expiry';
end; $$;
create trigger knowledge_manifests_immutable before update or delete on review_knowledge_manifests
 for each row execute function guard_knowledge_manifest_history();
create function bump_knowledge_authorization() returns trigger language plpgsql as $$
begin
 if tg_op='UPDATE' and to_jsonb(old)=to_jsonb(new) then return null; end if;
 update review_knowledge_security_state set authorization_revision=authorization_revision+1 where singleton;
 return null;
end; $$;
create trigger knowledge_authorization_grants after insert or update or delete on repository_grants
 for each row execute function bump_knowledge_authorization();
create trigger knowledge_authorization_memberships after insert or update or delete on tenant_memberships
 for each row execute function bump_knowledge_authorization();
create trigger knowledge_authorization_roles after insert or update or delete on review_criteria_roles
 for each row execute function bump_knowledge_authorization();
create trigger knowledge_authorization_user after update of enabled,deleted_at,role,groups_json,oidc_subject on users
 for each row when ((old.enabled,old.deleted_at,old.role,old.groups_json,old.oidc_subject) is distinct from (new.enabled,new.deleted_at,new.role,new.groups_json,new.oidc_subject)) execute function bump_knowledge_authorization();
create trigger knowledge_authorization_user_deleted after delete on users
 for each statement execute function bump_knowledge_authorization();
create trigger knowledge_authorization_repository after update of enabled,deleted_at,tenant_id,instance_id on repositories
 for each statement execute function bump_knowledge_authorization();
create trigger knowledge_authorization_tenant after update of enabled on tenants
 for each statement execute function bump_knowledge_authorization();
create trigger knowledge_authorization_instance after update of enabled on github_instances
 for each statement execute function bump_knowledge_authorization();

create trigger knowledge_user_subject_changed after update of oidc_subject on users
 for each row when (old.oidc_subject is distinct from new.oidc_subject) execute function review_knowledge_invalidate();

-- Identity refresh uses INSERT ... ON CONFLICT DO NOTHING for membership. Empty
-- statements must not dirty every bundle or invalidate every user's manifest.
drop trigger knowledge_roles_changed on review_criteria_roles;
create trigger knowledge_roles_changed after insert or delete on review_criteria_roles
 for each row execute function review_knowledge_invalidate();
create trigger knowledge_roles_updated after update on review_criteria_roles
 for each row when (to_jsonb(old) is distinct from to_jsonb(new)) execute function review_knowledge_invalidate();
drop trigger knowledge_grants_changed on repository_grants;
create trigger knowledge_grants_changed after insert or delete on repository_grants
 for each row execute function review_knowledge_invalidate();
create trigger knowledge_grants_updated after update on repository_grants
 for each row when (to_jsonb(old) is distinct from to_jsonb(new)) execute function review_knowledge_invalidate();
drop trigger knowledge_memberships_changed on tenant_memberships;
create trigger knowledge_memberships_changed after insert or delete on tenant_memberships
 for each row execute function review_knowledge_invalidate();
create trigger knowledge_memberships_updated after update on tenant_memberships
 for each row when (to_jsonb(old) is distinct from to_jsonb(new)) execute function review_knowledge_invalidate();
