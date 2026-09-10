alter table users add column deleted_at timestamptz;
alter table users add constraint users_deleted_access_check
  check (deleted_at is null or (not enabled and personal_prompt = ''));

create index users_active_idx on users(id) where deleted_at is null;
