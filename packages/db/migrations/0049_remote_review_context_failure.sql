-- Missing/expired approved context is not malformed model output.
do $$
declare item record; removed integer := 0;
begin
  for item in select conname from pg_constraint
    where conrelid='client_review_jobs'::regclass and contype='c'
      and pg_get_constraintdef(oid) like '%authorization-revoked%'
  loop
    execute format('alter table client_review_jobs drop constraint %I', item.conname);
    removed := removed + 1;
  end loop;
  if removed <> 2 then raise exception 'Unexpected remote review reason constraints'; end if;
end $$;
alter table client_review_jobs add constraint client_review_jobs_reason_v2 check (
  reason in ('cancelled','authorization-revoked','account-unavailable','budget-exhausted','execution-lost','model-failed','source-expired','result-expired','invalid-output','context-unavailable')
);
alter table client_review_jobs add constraint client_review_jobs_state_reason_v2 check (
  (state in ('queued','running','cancel-requested','completed') and reason is null) or
  (state='cancelled' and reason='cancelled') or
  (state='uncertain' and reason='execution-lost') or
  (state='expired' and reason in ('source-expired','result-expired')) or
  (state='failed' and reason in ('authorization-revoked','account-unavailable','budget-exhausted','model-failed','invalid-output','context-unavailable'))
);
