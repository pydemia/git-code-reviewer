import type { Database } from '@gcr/db';
import { GitHubConversationLimitError, type GitHubReader } from '@gcr/github';
import { persistPullRequestMessages, type RepositoryRecord } from './repositories.js';

// Each metadata poll advances at most ten PRs. Persisted due times provide fair
// rotation and bounded retries even when listPulls keeps returning 304.
export async function syncRepositoryConversations(
  database: Database,
  repository: RepositoryRecord,
  reader: GitHubReader,
) {
  if (!reader.listPullRequestMessages) return;
  const attempted: string[] = [];
  for (let i = 0; i < 10; i++) {
    const claim = (
      await database.query<{ pull_request_id: string; claim_token: string; number: number }>(
        `with candidate as (
        select s.pull_request_id from pull_request_conversation_sync s
        join pull_requests p on p.id=s.pull_request_id join repositories r on r.id=p.repository_id
        where p.repository_id=$1 and r.enabled and r.deleted_at is null
          and (p.state='open' or s.follow_until>clock_timestamp())
          and s.next_attempt_at<=clock_timestamp()
          and (s.claim_token is null or s.claim_until<=clock_timestamp())
          and not (s.pull_request_id=any($2::uuid[]))
        order by s.next_attempt_at,s.pull_request_id for update of s skip locked limit 1
      ) update pull_request_conversation_sync s set claim_token=gen_random_uuid(),
        claim_until=clock_timestamp()+interval '2 minutes',last_attempt_at=clock_timestamp()
        from candidate c,pull_requests p where s.pull_request_id=c.pull_request_id and p.id=c.pull_request_id
        returning s.pull_request_id,s.claim_token,p.number`,
        [repository.id, attempted],
      )
    ).rows[0];
    if (!claim) return;
    attempted.push(claim.pull_request_id);
    const started = new Date();
    try {
      const messages = await reader.listPullRequestMessages(repository, claim.number);
      const saved = await persistPullRequestMessages(
        database,
        repository.id,
        claim.number,
        messages,
        started,
        claim.claim_token,
        { complete: true },
      );
      if (!saved) continue;
      await database.query(
        `update pull_request_conversation_sync set claim_token=null,claim_until=null,
          last_success_at=clock_timestamp(),consecutive_failures=0,last_error_code=null,
          next_attempt_at=clock_timestamp()+($3*interval '1 second')
         where pull_request_id=$1 and claim_token=$2`,
        [claim.pull_request_id, claim.claim_token, repository.pollIntervalSeconds],
      );
    } catch (error) {
      await database.query(
        `update pull_request_conversation_sync set claim_token=null,claim_until=null,
          consecutive_failures=consecutive_failures+1,last_error_code=$3,
          next_attempt_at=clock_timestamp()+(least(1800,30*power(2,least(consecutive_failures,6)))*interval '1 second')
         where pull_request_id=$1 and claim_token=$2`,
        [
          claim.pull_request_id,
          claim.claim_token,
          error instanceof GitHubConversationLimitError
            ? 'CONVERSATION_PAGE_LIMIT'
            : 'CONVERSATION_READ_FAILED',
        ],
      );
      // Failure of one PR must not starve other due conversations or roll back a
      // successfully stored metadata ETag. Its own row remains retryable.
    }
  }
}
