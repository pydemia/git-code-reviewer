-- Reserve account-local headroom for interactive requests across all batch runs.
create or replace function reserve_model_request(
  p_quota text, p_run text, p_max_calls integer, p_bytes integer,
  p_batch boolean, p_concurrency integer
) returns uuid language plpgsql as $$
declare
  capacity model_account_capacity%rowtype;
  reservation uuid;
  active_batch integer;
  active_chat integer;
begin
  if p_max_calls < 1 or p_bytes < 0 or p_bytes > 1048576
    or p_concurrency not between 1 and 4 then
    raise exception 'Invalid model admission budget';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('model-run:' || p_run, 0));
  insert into model_account_capacity(quota_key) values(p_quota) on conflict do nothing;
  select * into capacity from model_account_capacity where quota_key=p_quota for update;
  -- Rolling upgrade 중 구 Worker가 소유한 단일 lease도 존중한다.
  if (capacity.reservation_id is not null and capacity.lease_expires_at>clock_timestamp())
    or capacity.cooldown_until>clock_timestamp()
    or (p_batch and capacity.priority_expires_at>clock_timestamp()
      and capacity.priority_run_key is distinct from p_run) then
    return null;
  end if;
  update model_request_ledger set state='interrupted',finished_at=clock_timestamp()
    where quota_key=p_quota and state in ('reserved','sent')
      and lease_expires_at<=clock_timestamp();
  select count(*) filter(where lane='batch'),count(*) filter(where lane='interactive')
    into active_batch,active_chat from model_request_ledger
    where quota_key=p_quota and state in ('reserved','sent')
      and lease_expires_at>clock_timestamp();
  -- GCR software sharing policy, not a provider quota: batch gets at most two
  -- slots and half the account minute budget. Interactive retains its own slot.
  -- Count every lane/model against the shared budget, including failed requests.
  if (p_batch and active_batch>=least(p_concurrency,2)) or (not p_batch and active_chat>=1)
    or (select count(*) from model_request_ledger where run_key=p_run)>=p_max_calls
    or (select count(*) from model_request_ledger where quota_key=p_quota
      and created_at>clock_timestamp()-interval '1 minute')>=(case when p_batch then 30 else 60 end)
    or (select coalesce(sum(input_bytes),0) from model_request_ledger where quota_key=p_quota
      and created_at>clock_timestamp()-interval '1 minute')+p_bytes>(case when p_batch then 524288 else 1048576 end) then
    return null;
  end if;
  insert into model_request_ledger(quota_key,run_key,state,input_bytes,lane,lease_expires_at)
    values(p_quota,p_run,'reserved',p_bytes,case when p_batch then 'batch' else 'interactive' end,
      clock_timestamp()+interval '180 seconds') returning id into reservation;
  -- 구 Worker는 이 sentinel lease가 해제될 때까지 대기한다.
  update model_account_capacity set reservation_id=null,
    lease_expires_at=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp(),
    priority_run_key=case when not p_batch then null else priority_run_key end,
    priority_expires_at=case when not p_batch then null else priority_expires_at end
    where quota_key=p_quota;
  return reservation;
end $$;

