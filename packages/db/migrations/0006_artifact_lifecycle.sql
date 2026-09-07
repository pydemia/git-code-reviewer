alter table artifacts
  add column if not exists state text not null default 'available'
    check (state in ('available', 'deleting', 'unavailable')),
  add column if not exists delete_after timestamptz,
  add column if not exists last_verified_at timestamptz,
  add column if not exists last_error text;

create index if not exists artifacts_lifecycle_idx
  on artifacts(state, committed_at, id);
