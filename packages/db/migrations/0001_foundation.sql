create table if not exists service_metadata (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default clock_timestamp()
);

insert into service_metadata(key, value)
values ('schema', '{"version":1}'::jsonb)
on conflict (key) do nothing;

