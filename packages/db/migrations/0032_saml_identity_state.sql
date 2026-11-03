-- Additive identity state. Existing users, OIDC subjects, local credentials,
-- grants, memory owners and sessions are not rewritten or linked by email.
create table user_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null default 'saml' check (provider = 'saml'),
  identity_key text not null unique check (identity_key ~ '^[0-9a-f]{64}$'),
  user_binding_key text not null unique check (user_binding_key ~ '^[0-9a-f]{64}$'),
  keycloak_identity_key text not null unique check (keycloak_identity_key ~ '^[0-9a-f]{64}$'),
  idp_issuer text not null check (char_length(idp_issuer) between 1 and 2048),
  sp_entity_id text not null check (char_length(sp_entity_id) between 1 and 2048),
  name_id_format text not null check (name_id_format = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent'),
  name_id text not null check (char_length(name_id) between 1 and 4096),
  name_qualifier text check (name_qualifier is null or char_length(name_qualifier) between 1 and 2048),
  sp_name_qualifier text check (sp_name_qualifier is null or char_length(sp_name_qualifier) between 1 and 2048),
  keycloak_user_id text not null check (char_length(keycloak_user_id) between 1 and 255),
  provisioning_state text not null default 'pending' check (provisioning_state in ('pending','provisioned','failed')),
  enabled boolean not null default false,
  identity_verified_at timestamptz,
  security_epoch bigint not null default 1 check (security_epoch > 0),
  security_checked_at timestamptz,
  security_fresh_until timestamptz,
  linked_by uuid references users(id) on delete set null,
  linked_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(id, user_id),
  check (not enabled or (provisioning_state = 'provisioned' and identity_verified_at is not null)),
  check ((security_checked_at is null and security_fresh_until is null) or
    (security_checked_at is not null and security_fresh_until is not null and
     security_fresh_until > security_checked_at and
     security_fresh_until <= security_checked_at + interval '5 minutes'))
);
create index user_identities_user_idx on user_identities(user_id);
create index user_identities_freshness_idx on user_identities(security_fresh_until) where enabled;

alter table user_sessions
  add column saml_identity_id uuid,
  add column saml_session_index text,
  add column saml_security_epoch bigint,
  add column saml_session_not_on_or_after timestamptz,
  add constraint user_sessions_saml_identity_owner_fk
    foreign key(saml_identity_id, user_id) references user_identities(id, user_id) on delete cascade,
  add constraint user_sessions_saml_binding_check check (
    (saml_identity_id is null and saml_session_index is null and saml_security_epoch is null and saml_session_not_on_or_after is null)
    or (saml_identity_id is not null and saml_session_index is not null and
      char_length(saml_session_index) between 1 and 1024 and saml_security_epoch is not null and
      saml_security_epoch > 0 and saml_session_not_on_or_after is not null and
      expires_at <= saml_session_not_on_or_after and expires_at <= created_at + interval '8 hours')
  );
create index user_sessions_saml_identity_idx on user_sessions(saml_identity_id, saml_session_index)
  where saml_identity_id is not null;

create table saml_transactions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('login','logout')),
  request_id text not null unique check (request_id ~ '^[_A-Za-z][_A-Za-z0-9.-]{0,255}$'),
  configuration_key text not null check (configuration_key ~ '^[0-9a-f]{64}$'),
  relay_state_hash text not null unique check (relay_state_hash ~ '^[0-9a-f]{64}$'),
  browser_nonce_hash text not null check (browser_nonce_hash ~ '^[0-9a-f]{64}$'),
  return_to text not null default '/' check (char_length(return_to) between 1 and 2048 and
    left(return_to, 1) = '/' and left(return_to, 2) <> '//' and strpos(return_to, chr(92)) = 0 and return_to !~ '[[:cntrl:]]'),
  logout_identity_id uuid references user_identities(id) on delete cascade,
  logout_session_index text,
  logout_session_hash text,
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null default statement_timestamp() + interval '5 minutes',
  consumed_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '5 minutes'),
  check ((kind = 'login' and logout_identity_id is null and logout_session_index is null and logout_session_hash is null)
    or (kind = 'logout' and logout_identity_id is not null and logout_session_index is not null and
      char_length(logout_session_index) between 1 and 1024 and logout_session_hash is not null and
      logout_session_hash ~ '^[0-9a-f]{64}$'))
);
create index saml_transactions_expiry_idx on saml_transactions(expires_at);

-- IDs are hashed, not XML bodies. One namespace across response/assertion/logout
-- kinds prevents an ID being accepted again under a different message kind.
create table saml_message_consumptions (
  configuration_key text not null check (configuration_key ~ '^[0-9a-f]{64}$'),
  message_id_hash text not null check (message_id_hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('response','assertion','logout-response','logout-request')),
  consumed_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null default statement_timestamp() + interval '10 minutes',
  primary key(configuration_key, message_id_hash),
  check (expires_at > consumed_at and expires_at <= consumed_at + interval '10 minutes')
);
create index saml_message_consumptions_expiry_idx on saml_message_consumptions(expires_at);

-- Explicit columns prevent password/token payloads being persisted by a generic
-- credential-bearing JSON operation. P03-C04 supplies the Admin API processor.
create table identity_admin_operations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  identity_id uuid references user_identities(id) on delete set null,
  requested_by uuid references users(id) on delete set null,
  kind text not null check (kind in ('create','link','disable','enable','password-reset','logout-all')),
  dedupe_key text not null unique check (dedupe_key ~ '^[0-9a-f]{64}$'),
  state text not null default 'pending' check (state in ('pending','running','succeeded','failed')),
  requested_username text check (requested_username is null or char_length(requested_username) between 1 and 255),
  requested_email text check (requested_email is null or char_length(requested_email) between 1 and 320),
  requested_display_name text check (requested_display_name is null or char_length(requested_display_name) between 1 and 255),
  external_user_id text check (external_user_id is null or char_length(external_user_id) between 1 and 255),
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index identity_admin_operations_user_idx on identity_admin_operations(user_id, created_at desc);
create table identity_admin_outbox (
  operation_id uuid primary key references identity_admin_operations(id) on delete cascade,
  available_at timestamptz not null default clock_timestamp(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  claimed_by uuid,
  claimed_until timestamptz,
  delivered_at timestamptz,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  check ((claimed_by is null) = (claimed_until is null))
);
create index identity_admin_outbox_pending_idx on identity_admin_outbox(available_at)
  where delivered_at is null;
