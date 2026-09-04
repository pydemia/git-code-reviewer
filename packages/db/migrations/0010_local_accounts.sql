create table if not exists local_credentials (
  user_id uuid primary key references users(id) on delete cascade,
  username text not null unique
    check (username = lower(username) and username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  password_hash text not null,
  password_changed_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists local_login_limits (
  username_hash text primary key check (username_hash ~ '^[0-9a-f]{64}$'),
  failed_count integer not null default 0 check (failed_count >= 0),
  window_started_at timestamptz not null default clock_timestamp(),
  locked_until timestamptz,
  updated_at timestamptz not null default clock_timestamp()
);

create index if not exists local_login_limits_cleanup_idx
  on local_login_limits(updated_at);
