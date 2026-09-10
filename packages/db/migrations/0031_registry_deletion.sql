-- 과거 분석·대화의 FK는 보존하고 새 선택 목록에서만 제거한다.
alter table chat_accounts add column deleted_at timestamptz;
alter table chat_accounts
  alter column credential_ciphertext drop not null,
  alter column credential_iv drop not null,
  alter column credential_auth_tag drop not null,
  add constraint chat_account_deleted_credentials check (
    (deleted_at is null and credential_ciphertext is not null
      and credential_iv is not null and credential_auth_tag is not null)
    or (deleted_at is not null and not enabled and credential_ciphertext is null
      and credential_iv is null and credential_auth_tag is null)
  );
alter table chat_accounts drop constraint chat_accounts_display_name_key;
create unique index chat_accounts_live_name on chat_accounts(display_name) where deleted_at is null;
alter table analysis_provider_versions add column deleted_at timestamptz;
alter table analysis_provider_versions add constraint deleted_provider_inactive
  check (deleted_at is null or not active);
alter table analysis_provider_versions drop constraint analysis_provider_versions_configuration_hash_key;
create unique index analysis_provider_live_hash on analysis_provider_versions(configuration_hash)
  where deleted_at is null;
-- Provider 설정·credential은 이미 enqueue된 분석이 재개할 수 있도록 보존한다.
