alter table chat_messages
  add column if not exists memory_hash text
    check (memory_hash is null or memory_hash ~ '^[0-9a-f]{64}$');
