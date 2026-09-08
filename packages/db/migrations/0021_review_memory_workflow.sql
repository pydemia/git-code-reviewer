drop index if exists review_memories_collective_candidate_active_key_idx;

create unique index if not exists review_memories_collective_candidate_key_idx
  on review_memories(repository_id, aggregation_key)
  where scope = 'collective' and state = 'candidate';
create unique index if not exists review_memories_collective_active_key_idx
  on review_memories(repository_id, aggregation_key)
  where scope = 'collective' and state = 'active';

