create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_name text not null check (char_length(display_name) between 1 and 120),
  enabled boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

insert into tenants(slug, display_name)
values ('default', 'Default tenant')
on conflict (slug) do nothing;

alter table users
  add column if not exists enabled boolean not null default true;

create table if not exists tenant_memberships (
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  enabled boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(tenant_id, user_id)
);
create index if not exists tenant_memberships_user_idx
  on tenant_memberships(user_id, tenant_id) where enabled;

insert into tenant_memberships(tenant_id, user_id)
select tenant.id, app_user.id
from tenants tenant cross join users app_user
where tenant.slug = 'default'
on conflict (tenant_id, user_id) do nothing;

alter table repositories
  add column if not exists tenant_id uuid references tenants(id);

update repositories repository
set tenant_id = tenant.id
from tenants tenant
where repository.tenant_id is null and tenant.slug = 'default';

alter table repositories
  alter column tenant_id set not null;

create index if not exists repositories_tenant_idx
  on repositories(tenant_id, enabled, owner, name);

create table if not exists analysis_prompt_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  version integer not null check (version > 0),
  instructions text not null check (char_length(instructions) between 1 and 12000),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  active boolean not null default false,
  created_by uuid not null references users(id),
  activated_by uuid references users(id),
  activated_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique(tenant_id, version),
  unique(tenant_id, content_hash),
  check (not active or (activated_by is not null and activated_at is not null))
);
create unique index if not exists analysis_prompt_versions_active_idx
  on analysis_prompt_versions(tenant_id) where active;

alter table analysis_runs
  add column if not exists prompt_version_id uuid references analysis_prompt_versions(id),
  add column if not exists prompt_hash text not null default 'builtin-v1';

create index if not exists analysis_runs_prompt_version_idx
  on analysis_runs(prompt_version_id) where prompt_version_id is not null;
