alter table analysis_provider_versions
  add column chat_account_id uuid references chat_accounts(id),
  add column reasoning_effort text check (reasoning_effort in ('low', 'medium', 'high', 'xhigh'));

alter table analysis_provider_versions
  drop constraint analysis_provider_versions_mode_check,
  drop constraint analysis_provider_versions_check,
  add constraint analysis_provider_versions_mode_check
    check (mode in ('disabled', 'openai-compatible', 'chatgpt-account')),
  add constraint analysis_provider_versions_configuration_check check (
    (mode = 'disabled' and endpoint is null and model_name is null and chat_account_id is null
      and reasoning_effort is null and credential_ciphertext is null and credential_iv is null
      and credential_auth_tag is null)
    or
    (mode = 'openai-compatible' and endpoint is not null and model_name is not null
      and chat_account_id is null and reasoning_effort is null and credential_ciphertext is not null
      and credential_iv is not null and credential_auth_tag is not null)
    or
    (mode = 'chatgpt-account' and endpoint is null and model_name is not null
      and chat_account_id is not null and reasoning_effort is not null and credential_ciphertext is null
      and credential_iv is null and credential_auth_tag is null)
  );
