alter table client_api_keys drop constraint client_api_keys_scopes_check;
alter table client_api_keys add constraint client_api_keys_scopes_check check (
  scopes @> array['knowledge:read']::text[] and
  scopes <@ array['knowledge:read','reviews:submit','feedback:submit']::text[] and
  cardinality(scopes) between 1 and 3
);

create table client_review_submissions (
  id uuid primary key default gen_random_uuid(),
  request_id text not null check(char_length(request_id) between 1 and 128),
  server_id uuid not null,
  tenant_id uuid not null references tenants(id) on delete cascade,
  repository_id uuid not null references repositories(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  client_id text not null check(client_id in ('commit-defender','gcr-cli')),
  kind text not null check(kind in ('result','feedback')),
  payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=32768),
  received_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null default statement_timestamp()+interval '30 days',
  unique(server_id,tenant_id,repository_id,owner_user_id,client_id,request_id)
);
create index client_review_submissions_expiry_idx on client_review_submissions(expires_at,id);
create index client_review_submissions_repository_idx on client_review_submissions(repository_id,received_at desc,id);
