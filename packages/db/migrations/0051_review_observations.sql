-- Existing report history remains unobserved; never synthesize historical measurements.
alter table reports add column observation jsonb check(observation is null or jsonb_typeof(observation)='object');
create table knowledge_response_observations (
 repository_id uuid not null references repositories(id) on delete cascade,
 day date not null,
 route text not null check(route in ('manifest','bundle')),
 status integer not null check(status between 100 and 599),
 responses bigint not null check(responses>0),
 duration_ms bigint not null check(duration_ms>=0),
 primary key(repository_id,day,route,status)
);
create index knowledge_response_observations_retention on knowledge_response_observations(day);
