create table client_api_keys (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  server_id uuid not null,
  tenant_id uuid not null references tenants(id) on delete cascade,
  client_id text not null check(client_id in ('commit-defender','gcr-cli')),
  name text not null check(char_length(name) between 1 and 100),
  secret_hash text not null unique check(secret_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null check(scopes = array['knowledge:read']::text[]),
  repository_ids uuid[] not null check(cardinality(repository_ids) between 1 and 100),
  credential_epoch bigint not null check(credential_epoch > 0),
  auth_mode text not null check(auth_mode in ('local','saml')),
  identity_id uuid,
  identity_epoch bigint,
  local_password_changed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  foreign key(identity_id,user_id) references user_identities(id,user_id),
  check(expires_at > created_at and expires_at <= created_at + interval '90 days'),
  check((auth_mode='saml' and identity_id is not null and identity_epoch is not null and local_password_changed_at is null)
    or (auth_mode='local' and identity_id is null and identity_epoch is null and local_password_changed_at is not null))
);
create index client_api_keys_owner_idx on client_api_keys(user_id,created_at desc,id);
