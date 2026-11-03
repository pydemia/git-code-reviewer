create table review_criterion_deadlines (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null,
  revision integer not null,
  kind text not null check(kind in ('review-date','exception-start','exception-expired')),
  reference_id uuid not null,
  due_at timestamptz not null,
  processed_at timestamptz,
  foreign key(rule_id,revision) references review_rule_revisions(rule_id,revision) on delete cascade,
  unique(rule_id,revision,kind,reference_id)
);
create index review_criterion_deadlines_due on review_criterion_deadlines(due_at,id) where processed_at is null;

create function schedule_criterion_deadlines() returns trigger language plpgsql as $$
begin
 if tg_table_name='review_rule_revisions' then
  if new.document->>'reviewAfter' is not null then
   insert into review_criterion_deadlines(rule_id,revision,kind,reference_id,due_at)
    values(new.rule_id,new.revision,'review-date',new.rule_id,(new.document->>'reviewAfter')::timestamptz);
  end if;
 else
  insert into review_criterion_deadlines(rule_id,revision,kind,reference_id,due_at)
   values(new.rule_id,new.revision,'exception-start',new.id,new.starts_at),
         (new.rule_id,new.revision,'exception-expired',new.id,new.expires_at);
 end if;
 return null;
end; $$;
create trigger criterion_revision_deadline after insert on review_rule_revisions for each row execute function schedule_criterion_deadlines();
create trigger criterion_exception_deadline after insert on review_rule_exceptions for each row execute function schedule_criterion_deadlines();

insert into review_criterion_deadlines(rule_id,revision,kind,reference_id,due_at)
 select v.rule_id,v.revision,'review-date',v.rule_id,(v.document->>'reviewAfter')::timestamptz
 from review_rule_revisions v join review_rules r on r.id=v.rule_id and r.current_revision=v.revision
 where r.state<>'retired' and v.document->>'reviewAfter' is not null;
insert into review_criterion_deadlines(rule_id,revision,kind,reference_id,due_at)
 select e.rule_id,e.revision,b.kind,e.id,b.due_at from review_rule_exceptions e
 join review_rules r on r.id=e.rule_id and r.current_revision=e.revision
 cross join lateral (values('exception-start',e.starts_at),('exception-expired',e.expires_at)) b(kind,due_at)
 where r.state<>'retired' and not exists(select 1 from review_rule_exception_revocations v where v.exception_id=e.id);

-- Code source loss must invalidate the pending release in the same transaction.
-- Query the pinned decision rather than a parent row which may already be cascading away.
create function invalidate_criterion_code_source(file uuid, snapshot uuid) returns void language plpgsql as $$
declare row record;
begin
 for row in
  select distinct r.repository_id from review_rules r
  join review_rule_revisions v on v.rule_id=r.id and v.revision=r.current_revision
  join review_decisions d on d.id=v.decision_id
  where r.state<>'retired' and (
   (file is not null and d.sources @> jsonb_build_array(jsonb_build_object('kind','snapshot-change','id',file))) or
   (snapshot is not null and d.sources @> jsonb_build_array(jsonb_build_object('kind','snapshot-change','codeChange',jsonb_build_object('snapshotId',snapshot))))
  ) order by r.repository_id
 loop
  perform request_review_knowledge(row.repository_id,'policy',null,'code-source.changed');
 end loop;
end; $$;
create function criterion_code_source_changed() returns trigger language plpgsql as $$
declare row record;
begin
 if tg_op='UPDATE' and to_jsonb(old)=to_jsonb(new) then return new; end if;
 if tg_table_name='snapshot_change_sources' then
  perform invalidate_criterion_code_source(old.file_id,null);
 elsif tg_table_name='snapshot_files' then
  perform invalidate_criterion_code_source(old.id,null);
 elsif tg_table_name='snapshots' then
  perform invalidate_criterion_code_source(null,old.id);
 elsif tg_table_name='pull_requests' then
  for row in select s.id from snapshots s join snapshot_requests r on r.id=s.request_id where r.pull_request_id=old.id order by s.id loop
   perform invalidate_criterion_code_source(null,row.id);
  end loop;
 else
  for row in select id from snapshots where request_id=old.id order by id loop
   perform invalidate_criterion_code_source(null,row.id);
  end loop;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end; $$;
create trigger criterion_code_changed after update or delete on snapshot_change_sources for each row execute function criterion_code_source_changed();
create trigger criterion_file_changed before update of path,previous_path,status,snapshot_id or delete on snapshot_files for each row execute function criterion_code_source_changed();
create trigger criterion_snapshot_changed before update of request_id,merge_base_sha,resolution or delete on snapshots for each row execute function criterion_code_source_changed();
create trigger criterion_snapshot_request_changed before update of pull_request_id,base_sha,head_sha or delete on snapshot_requests for each row execute function criterion_code_source_changed();
create trigger criterion_code_pr_changed before update of number,repository_id on pull_requests for each row execute function criterion_code_source_changed();
