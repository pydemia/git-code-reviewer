-- 기존 Provider version의 실행 방식은 보존한다. 새 version에서 병렬 수를 선택한다.
alter table analysis_provider_versions add column concurrency integer not null default 1
  check (concurrency between 1 and 4);
create function protect_provider_concurrency() returns trigger language plpgsql as $$
begin
  if new.concurrency is distinct from old.concurrency then
    raise exception 'Provider concurrency is immutable; create a new version';
  end if;
  return new;
end $$;
create trigger analysis_provider_concurrency_immutable before update on analysis_provider_versions
  for each row execute function protect_provider_concurrency();

alter table model_request_ledger
  add column lease_expires_at timestamptz,
  add column lane text not null default 'interactive' check (lane in ('batch','interactive'));
create index model_request_ledger_active on model_request_ledger(quota_key,lease_expires_at)
  where state in ('reserved','sent');

-- 같은 account의 admission을 직렬화한다. Lock 취득 다음 statement에서 최신 ledger를
-- 읽어야 동시에 시작한 요청이 같은 잔여 slot/budget을 중복 예약하지 않는다.
create function reserve_model_request(
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
  -- Batch 최대 4개와 별도의 Interactive Chat 1개. 모델 변경으로 quota를 우회하지 않는다.
  if (p_batch and active_batch>=p_concurrency) or (not p_batch and active_chat>=1)
    or (select count(*) from model_request_ledger where run_key=p_run)>=p_max_calls
    or (select count(*) from model_request_ledger where quota_key=p_quota
      and created_at>clock_timestamp()-interval '1 minute')>=60
    or (select coalesce(sum(input_bytes),0) from model_request_ledger where quota_key=p_quota
      and created_at>clock_timestamp()-interval '1 minute')+p_bytes>1048576 then
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

create function heartbeat_model_request(p_id uuid) returns boolean language plpgsql as $$
declare quota text;
begin
  select quota_key into quota from model_request_ledger where id=p_id;
  perform 1 from model_account_capacity where quota_key=quota for update;
  update model_request_ledger set lease_expires_at=clock_timestamp()+interval '180 seconds'
    where id=p_id and state in ('reserved','sent') and lease_expires_at>clock_timestamp();
  if not found then return false; end if;
  update model_account_capacity set lease_expires_at=clock_timestamp()+interval '180 seconds',
    updated_at=clock_timestamp() where quota_key=quota and reservation_id is null;
  return true;
end $$;

create function finish_model_request(p_id uuid,p_state text,p_cooldown timestamptz)
returns void language plpgsql as $$
declare quota text;
begin
  select quota_key into quota from model_request_ledger where id=p_id;
  perform 1 from model_account_capacity where quota_key=quota for update;
  update model_request_ledger set state=p_state,finished_at=clock_timestamp(),lease_expires_at=null
    where id=p_id and state in ('reserved','sent');
  update model_account_capacity set
    cooldown_until=greatest(cooldown_until,p_cooldown),updated_at=clock_timestamp(),
    lease_expires_at=case when reservation_id is null then
      (select max(lease_expires_at) from model_request_ledger where quota_key=quota
        and state in ('reserved','sent') and lease_expires_at>clock_timestamp())
      else lease_expires_at end
    where quota_key=quota;
end $$;
