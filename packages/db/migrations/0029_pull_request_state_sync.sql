alter table pull_requests add column if not exists merged_at timestamptz;

-- 기존 ETag는 state=open 목록에 대한 값이다. 최초 전체 상태 조회를 반드시 수행한다.
update poll_states set etag = null, next_poll_at = clock_timestamp();
