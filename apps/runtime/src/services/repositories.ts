import { readFile } from 'node:fs/promises';
import {
  FixtureGitHubClient,
  GitHubAppClient,
  type GitHubReader,
  type PullRequestObservation,
  type RepositoryTarget,
} from '@gcr/github';
import type { Database } from '@gcr/db';
import type { AppConfig } from '../config.js';
import { enqueueSnapshot } from './operations.js';
import { registeredGitHubReader } from './account-registry.js';

const schedulerLockId = 746_278_432;

export type RepositoryRecord = RepositoryTarget & {
  id: string;
  githubId: string;
  webBaseUrl: string;
  pollIntervalSeconds: number;
  credentialId: string | null;
};

export async function createGitHubReader(config: AppConfig): Promise<GitHubReader | null> {
  if (config.GITHUB_MODE === 'disabled') return null;
  if (config.GITHUB_MODE === 'fixture') return new FixtureGitHubClient();
  const privateKey = await readFile(config.GITHUB_PRIVATE_KEY_FILE!, 'utf8');
  return new GitHubAppClient(config.GITHUB_APP_ID!, privateKey);
}

export async function ensureFixtureRepository(database: Database): Promise<void> {
  const instance = await database.query<{ id: string }>(
    `insert into github_instances(name, api_base_url, web_base_url, app_id)
     values ('Development GHES', 'https://github.example.internal/api/v3/', 'https://github.example.internal/', 'fixture')
     on conflict (api_base_url) do update set updated_at = clock_timestamp()
     returning id`,
  );
  const repository = await database.query<{ id: string }>(
    `insert into repositories(
       tenant_id, instance_id, github_id, installation_id, owner, name, poll_interval_seconds
     )
     select tenant.id, $1, 101, 'fixture', 'platform', 'reviewer-api', 120
     from tenants tenant where tenant.slug = 'default'
     on conflict (instance_id, github_id) do update set
       tenant_id = excluded.tenant_id, enabled = true, updated_at = clock_timestamp()
     returning id`,
    [instance.rows[0]!.id],
  );
  await database.query(
    `insert into poll_states(repository_id, next_poll_at)
     values ($1, clock_timestamp()) on conflict (repository_id) do nothing`,
    [repository.rows[0]!.id],
  );
}

export async function pollRepository(
  database: Database,
  github: GitHubReader | null,
  repositoryId: string,
  credentialEncryptionKey?: string,
): Promise<'updated' | 'not-modified'> {
  const repository = await getRepository(database, repositoryId);
  if (!repository) throw new Error('Repository is unavailable');
  const reader = repository.credentialId
    ? await registeredGitHubReader(database, credentialEncryptionKey, repository.credentialId)
    : github;
  if (!reader) throw new Error('GitHub credential is unavailable');
  const pollState = await database.query<{ etag: string | null }>(
    'select etag from poll_states where repository_id = $1',
    [repositoryId],
  );

  try {
    const result = await reader.listOpenPulls(repository, pollState.rows[0]?.etag);
    if (result.outcome === 'updated') await persistPulls(database, repositoryId, result.pulls);
    await database.query(
      `insert into poll_states(repository_id, next_poll_at, last_polled_at, etag, consecutive_failures, backoff_until, last_outcome, last_error_code, updated_at)
       values ($1, clock_timestamp() + ($2 * interval '1 second'), clock_timestamp(), $3, 0, null, $4, null, clock_timestamp())
       on conflict (repository_id) do update set
         next_poll_at = excluded.next_poll_at,
         last_polled_at = excluded.last_polled_at,
         etag = coalesce(excluded.etag, poll_states.etag),
         consecutive_failures = 0,
         backoff_until = null,
         last_outcome = excluded.last_outcome,
         last_error_code = null,
         updated_at = clock_timestamp()`,
      [repositoryId, repository.pollIntervalSeconds, result.etag, result.outcome],
    );
    return result.outcome;
  } catch (error) {
    await database.query(
      `update poll_states set
         consecutive_failures = consecutive_failures + 1,
         backoff_until = clock_timestamp() + (least(1800, 30 * power(2, least(consecutive_failures, 6))) * interval '1 second'),
         next_poll_at = clock_timestamp() + (least(1800, 30 * power(2, least(consecutive_failures, 6))) * interval '1 second'),
         last_outcome = 'failed', last_error_code = 'GITHUB_REQUEST_FAILED', updated_at = clock_timestamp()
       where repository_id = $1`,
      [repositoryId],
    );
    throw error;
  }
}

export async function startPollScheduler(
  database: Database,
  github: GitHubReader | null,
  logger: {
    info(value: object, message: string): void;
    error(value: object, message: string): void;
  },
  credentialEncryptionKey?: string,
): Promise<() => Promise<void>> {
  if (!github && !credentialEncryptionKey) return async () => undefined;
  const connection = await database.connect();
  const result = await connection.query<{ acquired: boolean }>(
    'select pg_try_advisory_lock($1) as acquired',
    [schedulerLockId],
  );
  if (!result.rows[0]?.acquired) {
    connection.release();
    logger.info({ component: 'poll-scheduler' }, 'another replica owns the scheduler lease');
    return async () => undefined;
  }

  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const due = await database.query<{ repository_id: string }>(
        `select p.repository_id
         from poll_states p
         join repositories r on r.id = p.repository_id
         join tenants tenant on tenant.id = r.tenant_id
         where r.enabled and r.polling_enabled and tenant.enabled and p.next_poll_at <= clock_timestamp()
           and (p.backoff_until is null or p.backoff_until <= clock_timestamp())
         order by p.next_poll_at limit 20`,
      );
      for (const row of due.rows) {
        await pollRepository(database, github, row.repository_id, credentialEncryptionKey).catch(
          (error: unknown) => {
            logger.error({ err: error, repositoryId: row.repository_id }, 'repository poll failed');
          },
        );
      }
    } finally {
      running = false;
    }
  };
  await tick();
  const interval = setInterval(() => void tick(), 15_000);
  logger.info({ component: 'poll-scheduler' }, 'poll scheduler leadership acquired');

  return async () => {
    stopped = true;
    clearInterval(interval);
    while (running) await new Promise((resolve) => setTimeout(resolve, 25));
    await connection.query('select pg_advisory_unlock($1)', [schedulerLockId]);
    connection.release();
  };
}

export async function getRepository(
  database: Database,
  repositoryId: string,
): Promise<RepositoryRecord | null> {
  const result = await database.query<{
    id: string;
    github_id: string;
    installation_id: string;
    credential_id: string | null;
    owner: string;
    name: string;
    poll_interval_seconds: number;
    api_base_url: string;
    web_base_url: string;
  }>(
    `select r.id, r.github_id, r.installation_id, r.credential_id, r.owner, r.name, r.poll_interval_seconds,
            i.api_base_url, i.web_base_url
     from repositories r
     join tenants tenant on tenant.id = r.tenant_id
     join github_instances i on i.id = r.instance_id
     where r.id = $1 and r.enabled and tenant.enabled and i.enabled`,
    [repositoryId],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        githubId: row.github_id,
        installationId: row.installation_id,
        owner: row.owner,
        name: row.name,
        pollIntervalSeconds: row.poll_interval_seconds,
        credentialId: row.credential_id,
        apiBaseUrl: row.api_base_url,
        webBaseUrl: row.web_base_url,
      }
    : null;
}

async function persistPulls(
  database: Database,
  repositoryId: string,
  pulls: PullRequestObservation[],
): Promise<void> {
  const connection = await database.connect();
  try {
    await connection.query('begin');
    for (const pull of pulls) {
      const current = await connection.query<{ base_sha: string; head_sha: string }>(
        `select base_sha, head_sha from pull_requests where repository_id = $1 and number = $2`,
        [repositoryId, pull.number],
      );
      const persisted = await connection.query<{ id: string }>(
        `insert into pull_requests(
           repository_id, github_id, number, title, state, draft, author_login, html_url,
           base_ref, base_sha, head_ref, head_sha, github_updated_at, observed_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp())
         on conflict (repository_id, number) do update set
           github_id = excluded.github_id, title = excluded.title, state = excluded.state,
           draft = excluded.draft, author_login = excluded.author_login, html_url = excluded.html_url,
           base_ref = excluded.base_ref, base_sha = excluded.base_sha,
           head_ref = excluded.head_ref, head_sha = excluded.head_sha,
           github_updated_at = excluded.github_updated_at, observed_at = clock_timestamp()
         returning id`,
        [
          repositoryId,
          pull.githubId,
          pull.number,
          pull.title,
          pull.state,
          pull.draft,
          pull.author,
          pull.url,
          pull.baseRef,
          pull.baseSha,
          pull.headRef,
          pull.headSha,
          pull.updatedAt,
        ],
      );
      const previous = current.rows[0];
      if (!previous || previous.base_sha !== pull.baseSha || previous.head_sha !== pull.headSha) {
        await enqueueSnapshot(
          connection,
          persisted.rows[0]!.id,
          pull.baseSha,
          pull.headSha,
          null,
          'poll',
        );
      }
    }
    const openNumbers = pulls.map((pull) => pull.number);
    await connection.query(
      `update pull_requests set state = 'closed', observed_at = clock_timestamp()
       where repository_id = $1 and state = 'open' and not (number = any($2::integer[]))`,
      [repositoryId, openNumbers],
    );
    await connection.query('commit');
  } catch (error) {
    await connection.query('rollback');
    throw error;
  } finally {
    connection.release();
  }
}
