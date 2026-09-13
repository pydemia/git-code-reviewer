-- Security collection is disabled by default. Existing accounts, identities,
-- local credentials, memberships and session bindings retain their values.
alter table user_identities
  add column security_reconciled_epoch bigint not null default 0,
  add column security_login_after timestamptz,
  add column idp_disabled_by_gcr boolean not null default false,
  add constraint user_identities_reconciled_epoch_check check (
    security_reconciled_epoch >= 0 and security_reconciled_epoch <= security_epoch
  );

-- P04 client credentials must bind this epoch when issued and compare it on
-- every use. Recording a revocation here does not assert that P04 exists yet.
create table user_client_credential_epochs (
  user_id uuid primary key references users(id) on delete cascade,
  epoch bigint not null default 1 check (epoch > 0),
  revoked_at timestamptz not null default clock_timestamp()
);

create table identity_security_sources (
  configuration_key text primary key check (configuration_key ~ '^[0-9a-f]{64}$'),
  idp_issuer text not null,
  sp_entity_id text not null,
  state text not null default 'unverified' check (state in ('unverified','healthy','gap')),
  generation bigint not null default 0 check (generation >= 0),
  realm_id text,
  event_configuration_hash text check (event_configuration_hash ~ '^[0-9a-f]{64}$'),
  security_anchor_id uuid,
  security_anchor_time bigint,
  admin_anchor_id uuid,
  admin_anchor_time bigint,
  observed_at timestamptz,
  checked_at timestamptz,
  lease_id uuid,
  lease_started_at timestamptz,
  lease_until timestamptz,
  available_at timestamptz not null default clock_timestamp(),
  last_error_code text check (last_error_code ~ '^IDENTITY_[A-Z_]{1,54}$'),
  updated_at timestamptz not null default clock_timestamp(),
  unique(idp_issuer, sp_entity_id),
  check ((lease_id is null and lease_started_at is null and lease_until is null) or
    (lease_id is not null and lease_started_at is not null and lease_until > lease_started_at)),
  check ((realm_id is null and event_configuration_hash is null and security_anchor_id is null and
    security_anchor_time is null and admin_anchor_id is null and admin_anchor_time is null and observed_at is null) or
    (realm_id is not null and event_configuration_hash is not null and security_anchor_id is not null and
    security_anchor_time >= 0 and admin_anchor_id is not null and admin_anchor_time >= 0 and observed_at is not null))
);

-- Event details, representations, IP addresses, passwords and tokens are never
-- stored. The ledger makes overlap replay and concurrent workers idempotent.
create table identity_security_event_receipts (
  configuration_key text not null references identity_security_sources(configuration_key) on delete cascade,
  stream text not null check (stream in ('security','administration')),
  event_id_hash text not null check (event_id_hash ~ '^[0-9a-f]{64}$'),
  event_time bigint not null check (event_time >= 0),
  applied_at timestamptz not null default clock_timestamp(),
  primary key(configuration_key, stream, event_id_hash)
);
create index identity_security_event_receipts_retention_idx on identity_security_event_receipts(applied_at);

create table identity_security_logout_outbox (
  identity_id uuid primary key references user_identities(id) on delete cascade,
  security_epoch bigint not null check (security_epoch > 0),
  desired_enabled boolean check (desired_enabled is null or desired_enabled=false),
  available_at timestamptz not null default clock_timestamp(),
  claim_id uuid,
  claimed_until timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error_code text check (last_error_code ~ '^IDENTITY_[A-Z_]{1,54}$'),
  check ((claim_id is null) = (claimed_until is null))
);
create index identity_security_logout_outbox_available_idx on identity_security_logout_outbox(available_at);

-- Keycloak's opaque realm session ID is the first part of its SAML SessionIndex.
-- This tombstone also rejects an ACS that arrives after the IdP logout event,
-- including when no corresponding GCR web session had been created yet.
create table identity_idp_session_revocations (
  identity_id uuid not null references user_identities(id) on delete cascade,
  keycloak_session_hash text not null check (keycloak_session_hash ~ '^[0-9a-f]{64}$'),
  revoked_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null default statement_timestamp() + interval '10 minutes',
  primary key(identity_id, keycloak_session_hash),
  check (expires_at > revoked_at and expires_at <= revoked_at + interval '10 minutes')
);
create index identity_idp_session_revocations_expiry_idx on identity_idp_session_revocations(expires_at);
