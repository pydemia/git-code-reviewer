-- Existing audit rows remain readable. Only operations created with an explicit
-- provider binding and request fingerprint can be claimed by the new processor.
alter table identity_admin_operations
  drop constraint identity_admin_operations_kind_check,
  add constraint identity_admin_operations_kind_check
    check (kind in ('create','link','invite','disable','enable','password-reset','logout-all')),
  add column request_fingerprint text check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  add column idp_issuer text check (char_length(idp_issuer) between 1 and 2048),
  add column sp_entity_id text check (char_length(sp_entity_id) between 1 and 2048),
  add column expected_subject text check (char_length(expected_subject) between 1 and 4096),
  add column expected_name_id text check (char_length(expected_name_id) between 1 and 4096),
  add column creates_app_user boolean not null default false,
  add column mail_dispatched_at timestamptz,
  add column retryable boolean not null default false,
  add constraint identity_admin_operations_provider_binding_check check (
    (request_fingerprint is null and idp_issuer is null and sp_entity_id is null)
    or (request_fingerprint is not null and idp_issuer is not null and sp_entity_id is not null
      and expected_subject is not null)
  );

-- A new request cannot race another request for the same app user and provider.
-- Lifecycle revocation may supersede a request explicitly; it must never wait
-- for the IdP to acknowledge a disable before blocking access in GCR.
create unique index identity_admin_operations_active_user_provider_idx
  on identity_admin_operations(user_id, idp_issuer, sp_entity_id)
  where state in ('pending','running') and idp_issuer is not null;

create index identity_admin_operations_provider_idx
  on identity_admin_operations(idp_issuer, sp_entity_id, created_at);
