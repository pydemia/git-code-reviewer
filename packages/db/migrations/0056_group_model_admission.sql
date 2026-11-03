-- Grouped review adapts within the existing account and configured concurrency ceiling.
alter table model_account_capacity add column group_concurrency integer not null default 1 check(group_concurrency between 1 and 4), add column group_success_streak integer not null default 0;
alter table model_request_ledger add column adaptive_group boolean not null default false,
 add column estimated_input_tokens integer, add column reserved_output_tokens integer;
create function reserve_group_model_request(p_quota text,p_run text,p_max_calls integer,p_bytes integer,p_concurrency integer)
returns uuid language plpgsql as $$
declare cap integer; reservation uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('model-run:' || p_run,0));
 insert into model_account_capacity(quota_key) values(p_quota) on conflict do nothing;
 select group_concurrency into cap from model_account_capacity where quota_key=p_quota for update;
 reservation := reserve_model_request(p_quota,p_run,p_max_calls,p_bytes,true,least(cap,p_concurrency));
 if reservation is not null then
  -- One UTF-8 byte per estimated token is deliberately conservative, not provider usage.
  update model_request_ledger set adaptive_group=true,estimated_input_tokens=p_bytes,reserved_output_tokens=16000 where id=reservation;
 end if;
 return reservation;
end $$;
create function finish_group_model_request(p_id uuid,p_state text,p_cooldown timestamptz)
returns void language plpgsql as $$
declare quota text; active boolean; adaptive boolean;
begin
 select quota_key into quota from model_request_ledger where id=p_id;
 perform 1 from model_account_capacity where quota_key=quota for update;
 select state in ('reserved','sent'),adaptive_group into active,adaptive from model_request_ledger where id=p_id;
 perform finish_model_request(p_id,p_state,p_cooldown);
 if active and adaptive then
  update model_account_capacity set
   group_concurrency=case when p_state<>'completed' then greatest(1,group_concurrency/2)
     when group_success_streak>=7 then least(4,group_concurrency+1) else group_concurrency end,
   group_success_streak=case when p_state<>'completed' or group_success_streak>=7 then 0 else group_success_streak+1 end
   where quota_key=quota;
 end if;
end $$;
