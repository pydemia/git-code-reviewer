create table source_workspace_leases (
  node_id text not null,
  workspace_id text not null,
  lease_id uuid primary key,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);
create index source_workspace_active on source_workspace_leases(node_id,workspace_id,expires_at);
