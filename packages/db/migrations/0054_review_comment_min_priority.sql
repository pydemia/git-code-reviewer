-- Publication preferences do not change analysis inputs or stored findings.
alter table repositories add column review_comment_min_priority text not null default 'P2'
  check (review_comment_min_priority in ('P2', 'P3'));
