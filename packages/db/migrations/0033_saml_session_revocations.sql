-- A pending AuthnRequest must not resurrect the SSO session that was logged out.
-- New requests created after the revocation may authenticate again. DB times,
-- rather than an IdP's clock or caller timestamps, determine that ordering.
create table saml_session_revocations (
  identity_id uuid not null references user_identities(id) on delete cascade,
  session_index_hash text not null check (session_index_hash ~ '^[0-9a-f]{64}$'),
  revoked_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null default statement_timestamp() + interval '10 minutes',
  primary key(identity_id, session_index_hash),
  check (expires_at > revoked_at and expires_at <= revoked_at + interval '10 minutes')
);
create index saml_session_revocations_expiry_idx on saml_session_revocations(expires_at);
