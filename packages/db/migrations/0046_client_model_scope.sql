-- Explicit opt-in only: existing keys retain their original scopes.
alter table client_api_keys drop constraint client_api_keys_scopes_check;
alter table client_api_keys add constraint client_api_keys_scopes_check check (
  scopes @> array['knowledge:read']::text[] and
  scopes <@ array['knowledge:read','reviews:submit','feedback:submit','ai:invoke']::text[] and
  cardinality(scopes) between 1 and 4
);
