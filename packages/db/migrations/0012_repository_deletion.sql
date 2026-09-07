alter table repositories add column if not exists deleted_at timestamptz;

alter table repositories add constraint repositories_deleted_inactive
  check (deleted_at is null or (not enabled and not polling_enabled and not review_publishing_enabled));
