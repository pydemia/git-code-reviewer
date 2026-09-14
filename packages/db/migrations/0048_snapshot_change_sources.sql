-- Only newly materialized, bounded text diffs are copied here. Existing snapshots
-- retain their original artifacts; no code or validation is invented for them.
create table snapshot_change_sources (
  file_id uuid primary key references snapshot_files(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 12000),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp()
);
