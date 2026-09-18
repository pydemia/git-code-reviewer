import { createHash, createHmac } from 'node:crypto';
import { FilesystemArtifactStore } from '@gcr/artifact-store';
import { formatReviewGrade, formatReviewMarkdown } from '@gcr/contracts';
import type { Database, DatabaseClient } from '@gcr/db';
import {
  GitHubPublicationSupersededError,
  type GitHubReader,
  type GitHubReviewPublisher,
  type RepositoryTarget,
} from '@gcr/github';
import { reviewReportSchema, type ReviewFinding, type ReviewReport } from '@gcr/review-contract';
import type { AppConfig } from '../config.js';
import { appendEvent } from '../events/index.js';
import { registeredGitHubPublisher } from './account-registry.js';

type PublicationJob = {
  id: string;
  payload: { analysisId?: string; pullRequestId?: string };
};

type PublicationContext = RepositoryTarget & {
  analysisId: string;
  analysisCreatedAt: string;
  pullRequestId: string;
  pullNumber: number;
  repositoryId: string;
  credentialId: string | null;
  headSha: string;
  reportId: string;
  skillHash: string | null;
  reportLocator: string | null;
  reviewCommentMinPriority?: 'P2' | 'P3';
  report: Pick<ReviewReport, 'grade' | 'summary' | 'hasCriticalFindings' | 'coverage'>;
};

type PublicationRow = {
  commentId: string | null;
  bodyHash: string | null;
  publishedIsCurrentOrNewer: boolean | null;
};

export class ReviewPublicationError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export async function enqueueReviewPublication(
  connection: Pick<DatabaseClient, 'query'>,
  analysisId: string,
  pullRequestId: string,
  githubAppEnabled: boolean,
): Promise<boolean> {
  const eligible = await connection.query<{ headSha: string }>(
    `select request.head_sha as "headSha"
     from analysis_runs analysis
     join snapshots snapshot on snapshot.id = analysis.snapshot_id
     join snapshot_requests request on request.id = snapshot.request_id
     join pull_requests pull_request on pull_request.id = request.pull_request_id
     join repositories repository on repository.id = pull_request.repository_id
     where analysis.id = $1 and pull_request.id = $2 and repository.enabled
       and analysis.memory_owner_user_id is null and request.head_sha = pull_request.head_sha
       and pull_request.state = 'open' and repository.deleted_at is null
       and repository.review_publishing_enabled
       and (repository.credential_id is not null or $3::boolean)`,
    [analysisId, pullRequestId, githubAppEnabled],
  );
  if (!eligible.rows[0]) return false;

  await connection.query(
    `insert into github_review_publications(
       pull_request_id, target_analysis_run_id, head_sha, state)
     values ($1, $2, $3, 'pending')
     on conflict (pull_request_id) do update set
       target_analysis_run_id = excluded.target_analysis_run_id,
       head_sha = excluded.head_sha, state = 'pending',
       last_error_code = null, last_error_message = null,
       updated_at = clock_timestamp()
     where github_review_publications.target_analysis_run_id is distinct from excluded.target_analysis_run_id
       and (select (created_at,id) from analysis_runs where id=excluded.target_analysis_run_id)
           >= (select (created_at,id) from analysis_runs where id=github_review_publications.target_analysis_run_id)`,
    [pullRequestId, analysisId, eligible.rows[0].headSha],
  );
  await connection.query(
    `insert into jobs(type, payload, priority, dedupe_key, max_attempts)
     values ('github.review.publish', $1::jsonb, 120, $2, 5)
     on conflict do nothing`,
    [JSON.stringify({ analysisId, pullRequestId }), `github.review.publish:${analysisId}`],
  );
  return true;
}

export async function enqueueLatestReviewPublication(
  database: Database,
  repositoryId: string,
  githubAppEnabled: boolean,
): Promise<boolean> {
  const connection = await database.connect();
  try {
    await connection.query('begin');
    const active = await connection.query(
      `select id from repositories where id = $1 and enabled and deleted_at is null for share`,
      [repositoryId],
    );
    if (!active.rowCount) {
      await connection.query('commit');
      return false;
    }
    const latest = await connection.query<{ analysisId: string; pullRequestId: string }>(
      `select latest_analysis.id as "analysisId", pull_request.id as "pullRequestId"
     from pull_requests pull_request
     join lateral (
       select analysis.id
       from snapshot_requests request
       join snapshots snapshot on snapshot.request_id = request.id
       join analysis_runs analysis on analysis.snapshot_id = snapshot.id
       join reports report on report.analysis_run_id = analysis.id
       where request.pull_request_id = pull_request.id
         and analysis.state in ('completed', 'partial')
         and analysis.memory_owner_user_id is null and request.head_sha = pull_request.head_sha
       order by analysis.created_at desc, analysis.id desc limit 1
     ) latest_analysis on true
     where pull_request.repository_id = $1 and pull_request.state = 'open'`,
      [repositoryId],
    );
    const results = await Promise.all(
      latest.rows.map((row) =>
        enqueueReviewPublication(connection, row.analysisId, row.pullRequestId, githubAppEnabled),
      ),
    );
    await connection.query('commit');
    return results.some(Boolean);
  } catch (error) {
    await connection.query('rollback');
    throw error;
  } finally {
    connection.release();
  }
}

export async function publishReviewToGitHub(
  database: Database,
  deploymentGitHub: GitHubReader | null,
  config: AppConfig,
  job: PublicationJob,
  artifacts: Pick<FilesystemArtifactStore, 'readJson'> = new FilesystemArtifactStore(
    config.ARTIFACT_ROOT,
  ),
): Promise<void> {
  const analysisId = requiredPayload(job, 'analysisId');
  const pullRequestId = requiredPayload(job, 'pullRequestId');
  const connection = await database.connect();
  const lockKey = `github-review-publication:${pullRequestId}`;
  try {
    await connection.query('select pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
    const context = await loadPublicationContext(connection, analysisId, pullRequestId);
    if (!context) {
      await connection.query(
        `update github_review_publications set state = 'disabled', updated_at = clock_timestamp()
         where pull_request_id = $1 and target_analysis_run_id = $2`,
        [pullRequestId, analysisId],
      );
      return;
    }
    const publication = await loadPublication(connection, pullRequestId, analysisId);
    if (publication?.publishedIsCurrentOrNewer) {
      return;
    }

    const findings = await loadFindings(connection, context.reportId);
    let canonicalReport: ReviewReport | undefined;
    if (context.skillHash || context.reportLocator) {
      if (!context.reportLocator)
        throw new ReviewPublicationError('Report artifact를 읽을 수 없습니다.', true);
      canonicalReport = reviewReportSchema.parse(await artifacts.readJson(context.reportLocator));
      if (
        canonicalReport.analysisRevisionId !== analysisId ||
        (context.skillHash && canonicalReport.analysis?.skills.bundleHash !== context.skillHash)
      ) {
        throw new ReviewPublicationError(
          'Report의 analysis/Skill snapshot이 일치하지 않습니다.',
          false,
        );
      }
    }
    const marker = managedCommentMarker(config, pullRequestId);
    const body = renderReviewComment({
      context,
      findings,
      marker,
      ...(canonicalReport ? { canonicalReport } : {}),
      ...(config.PUBLIC_BASE_URL ? { publicBaseUrl: config.PUBLIC_BASE_URL } : {}),
    });
    const bodyHash = createHash('sha256').update(body).digest('hex');
    await connection.query(
      `update github_review_publications set state = 'publishing', last_attempt_at = clock_timestamp(),
         last_error_code = null, last_error_message = null, updated_at = clock_timestamp()
       where pull_request_id = $1 and target_analysis_run_id = $2`,
      [pullRequestId, analysisId],
    );

    const publisher = context.credentialId
      ? await registeredGitHubPublisher(
          database,
          config.CREDENTIAL_ENCRYPTION_KEY,
          context.credentialId,
        )
      : isReviewPublisher(deploymentGitHub)
        ? deploymentGitHub
        : null;
    if (!publisher) {
      throw new ReviewPublicationError('GitHub review publisher credential is unavailable', true);
    }
    const existingCommentId = publication?.commentId ? Number(publication.commentId) : null;
    let result;
    try {
      result = await publisher.upsertPullRequestComment(context, {
        pullNumber: context.pullNumber,
        expectedHeadSha: context.headSha,
        marker,
        body,
        existingCommentId,
        beforeWrite: async () => {
          // The remote lookup or marker recovery may take time. Recheck the exact
          // job target and credential selection without holding an SQL transaction over HTTP.
          const current = await loadPublicationContext(connection, analysisId, pullRequestId);
          const target = await connection.query(
            'select 1 from github_review_publications where pull_request_id=$1 and target_analysis_run_id=$2',
            [pullRequestId, analysisId],
          );
          if (
            !current ||
            !target.rowCount ||
            current.credentialId !== context.credentialId ||
            current.installationId !== context.installationId ||
            current.apiBaseUrl !== context.apiBaseUrl ||
            current.owner !== context.owner ||
            current.name !== context.name ||
            current.pullNumber !== context.pullNumber
          )
            throw new GitHubPublicationSupersededError('target-changed');
          if (
            (current.reviewCommentMinPriority ?? 'P2') !==
            (context.reviewCommentMinPriority ?? 'P2')
          )
            throw new ReviewPublicationError(
              'PR comment notification priority changed; retry with current settings',
              true,
            );
        },
      });
    } catch (error) {
      if (!(error instanceof GitHubPublicationSupersededError)) throw error;
      const skipped = await connection.query(
        `update github_review_publications set state='disabled', last_error_code=$3,
         last_error_message='Publication no longer matches the current pull request or selected target.',
         updated_at=clock_timestamp() where pull_request_id=$1 and target_analysis_run_id=$2`,
        [
          pullRequestId,
          analysisId,
          `GITHUB_REVIEW_${error.reason.replaceAll('-', '_').toUpperCase()}`,
        ],
      );
      if (skipped.rowCount)
        await appendEvent(connection, 'pull_request', pullRequestId, 'github.review.skipped', {
          analysisId,
          reason: error.reason,
        });
      return;
    }

    await connection.query(
      `update github_review_publications set
         published_analysis_run_id = $2, head_sha = $3, comment_id = $4,
         comment_url = $5, body_hash = $6,
         state = case
           when not exists (
             select 1 from pull_requests pull_request
             join repositories repository on repository.id = pull_request.repository_id
             join github_instances instance on instance.id = repository.instance_id
             where pull_request.id = $1 and repository.enabled
               and repository.review_publishing_enabled and instance.enabled
           ) then 'disabled'
           when target_analysis_run_id = $2 then 'published'
           else 'pending'
         end,
         published_at = clock_timestamp(), updated_at = clock_timestamp()
       where pull_request_id = $1`,
      [pullRequestId, analysisId, context.headSha, result.commentId, result.commentUrl, bodyHash],
    );
    await appendEvent(connection, 'pull_request', pullRequestId, 'github.review.published', {
      analysisId,
      headSha: context.headSha,
      reviewCommentMinPriority: context.reviewCommentMinPriority ?? 'P2',
      commentId: result.commentId,
      commentUrl: result.commentUrl,
      outcome: result.outcome,
    });
  } finally {
    await connection
      .query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
      .catch(() => undefined);
    connection.release();
  }
}

async function loadPublicationContext(
  database: Pick<DatabaseClient, 'query'>,
  analysisId: string,
  pullRequestId: string,
): Promise<PublicationContext | null> {
  const result = await database.query<{
    analysisId: string;
    analysisCreatedAt: string;
    pullRequestId: string;
    pullNumber: number;
    repositoryId: string;
    credentialId: string | null;
    installationId: string;
    apiBaseUrl: string;
    owner: string;
    name: string;
    headSha: string;
    reportId: string;
    skillHash: string | null;
    reportLocator: string | null;
    grade: ReviewReport['grade'];
    summary: string;
    hasCriticalFindings: boolean;
    coverage: ReviewReport['coverage'];
    reviewCommentMinPriority: 'P2' | 'P3';
  }>(
    `select analysis.id as "analysisId", analysis.created_at as "analysisCreatedAt",
            pull_request.id as "pullRequestId", pull_request.number as "pullNumber",
            repository.id as "repositoryId", repository.credential_id as "credentialId",
            repository.installation_id as "installationId", instance.api_base_url as "apiBaseUrl",
            repository.owner, repository.name, request.head_sha as "headSha",
            report.id as "reportId", report.grade, report.summary,
            report.has_critical_findings as "hasCriticalFindings", report.coverage,
            repository.review_comment_min_priority as "reviewCommentMinPriority",
            analysis.skill_hash as "skillHash", artifact.locator as "reportLocator"
     from analysis_runs analysis
     join reports report on report.analysis_run_id = analysis.id
     left join artifacts artifact on artifact.id = report.artifact_id and artifact.state = 'available'
     join snapshots snapshot on snapshot.id = analysis.snapshot_id
     join snapshot_requests request on request.id = snapshot.request_id
     join pull_requests pull_request on pull_request.id = request.pull_request_id
     join repositories repository on repository.id = pull_request.repository_id
     join github_instances instance on instance.id = repository.instance_id
     where analysis.id = $1 and pull_request.id = $2
       and analysis.memory_owner_user_id is null and request.head_sha = pull_request.head_sha
       and analysis.state in ('completed', 'partial')
       and pull_request.state = 'open' and repository.deleted_at is null
       and repository.enabled and repository.review_publishing_enabled and instance.enabled`,
    [analysisId, pullRequestId],
  );
  const row = result.rows[0];
  return row ? { ...row, report: row } : null;
}

async function loadPublication(
  database: Pick<DatabaseClient, 'query'>,
  pullRequestId: string,
  analysisId: string,
): Promise<PublicationRow | null> {
  const result = await database.query<PublicationRow>(
    `select publication.comment_id as "commentId", publication.body_hash as "bodyHash",
            (published_analysis.created_at,published_analysis.id) >= (select created_at,id from analysis_runs where id=$2) as "publishedIsCurrentOrNewer"
     from github_review_publications publication
     left join analysis_runs published_analysis
       on published_analysis.id = publication.published_analysis_run_id
     where publication.pull_request_id = $1`,
    [pullRequestId, analysisId],
  );
  return result.rows[0] ?? null;
}

async function loadFindings(
  database: Pick<DatabaseClient, 'query'>,
  reportId: string,
): Promise<Array<Pick<ReviewFinding, 'priority' | 'title' | 'problem' | 'recommendation'>>> {
  const result = await database.query<
    Pick<ReviewFinding, 'priority' | 'title' | 'problem' | 'recommendation'>
  >(
    `select priority, title, problem, recommendation from findings where report_id = $1
     order by case priority when 'P3' then 3 when 'P2' then 2 when 'P1' then 1 else 0 end desc,
              created_at, id`,
    [reportId],
  );
  return result.rows;
}

export function renderReviewComment(input: {
  context: Pick<
    PublicationContext,
    | 'analysisId'
    | 'owner'
    | 'name'
    | 'pullNumber'
    | 'headSha'
    | 'report'
    | 'reviewCommentMinPriority'
  >;
  findings: Array<Pick<ReviewFinding, 'priority' | 'title' | 'problem' | 'recommendation'>>;
  marker: string;
  publicBaseUrl?: string;
  canonicalReport?: ReviewReport;
}): string {
  const { context, marker } = input;
  const minimumPriority = context.reviewCommentMinPriority ?? 'P2';
  const findings = input.findings.filter((finding) => finding.priority >= minimumPriority);
  if (input.canonicalReport) {
    const heading = `${marker}\n## Git Code Reviewer 결과\n\n`;
    const tail = '\n\n_이 댓글은 새 분석이 완료되면 같은 위치에서 갱신됩니다._';
    const reportUrl = input.publicBaseUrl
      ? new URL(`/reviews/${context.analysisId}`, input.publicBaseUrl).toString()
      : undefined;
    return (
      heading +
      formatReviewMarkdown(input.canonicalReport, [], {
        includeTitle: false,
        audience: 'pull-request',
        minimumPriority,
        ...(reportUrl ? { reportUrl } : {}),
        maxLength: 60000 - heading.length - tail.length,
      }) +
      tail
    );
  }
  const counts = Object.fromEntries(
    ['P3', 'P2', 'P1', 'P0'].map((priority) => [
      priority,
      findings.filter((finding) => finding.priority === priority).length,
    ]),
  );
  const issues = findings.filter((finding) => finding.priority !== 'P0').slice(0, 5);
  const lines = [
    marker,
    '## Git Code Reviewer 결과',
    '',
    `\`${escapeInline(context.owner)}/${escapeInline(context.name)} #${context.pullNumber}\` · head \`${escapeInline(context.headSha.slice(0, 12))}\``,
    '',
    `**코드 품질:** ${formatReviewGrade(context.report.grade)}${context.report.hasCriticalFindings ? ' · 조치가 필요한 P3 finding이 있습니다.' : ''}`,
    '',
    `PR 댓글 알림: ${minimumPriority === 'P2' ? 'P2 Warning 이상' : 'P3 Critical만'} · 전체 분석 결과는 보고서에서 확인할 수 있습니다.`,
    ...(findings.length === input.findings.length ? [escapeMarkdown(context.report.summary)] : []),
    '',
    '| Priority | P3 | P2 | P1 | P0 |',
    '|---|---:|---:|---:|---:|',
    `| Findings | ${counts.P3} | ${counts.P2} | ${counts.P1} | ${counts.P0} |`,
    '',
  ];
  if (context.report.coverage.truncated || context.report.coverage.limitations.length > 0) {
    lines.push(
      `> 분석 범위에 제한이 있습니다. ${context.report.coverage.filesExamined}/${context.report.coverage.filesChanged} files를 검사했습니다.`,
      '',
    );
  }
  if (issues.length > 0) {
    lines.push('### 우선 확인할 findings', '');
    for (const [index, finding] of issues.entries()) {
      lines.push(
        `${index + 1}. **[${finding.priority}] ${escapeMarkdown(finding.title)}**`,
        `   - 문제: ${escapeMarkdown(finding.problem)}`,
        `   - 권고: ${escapeMarkdown(finding.recommendation)}`,
      );
    }
    lines.push('');
  } else {
    lines.push('PR 알림 기준에 해당하는 검토 의견이 없습니다.', '');
  }
  if (input.publicBaseUrl) {
    lines.push(
      `[전체 review와 evidence 보기](${new URL(`/reviews/${context.analysisId}`, input.publicBaseUrl).toString()})`,
      '',
    );
  }
  lines.push('_이 댓글은 새 분석이 완료되면 같은 위치에서 갱신됩니다._');
  return lines.join('\n').slice(0, 60_000);
}

export function managedCommentMarker(config: AppConfig, pullRequestId: string): string {
  const key = config.CREDENTIAL_ENCRYPTION_KEY ?? config.SESSION_SECRET;
  const signature = createHmac('sha256', key)
    .update(`github-review:${pullRequestId}`)
    .digest('hex')
    .slice(0, 24);
  return `<!-- git-code-reviewer:${pullRequestId}:${signature} -->`;
}

function escapeMarkdown(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('@', '＠')
    .replace(/[<>`*_{}[\]()#+.!|>-]/g, '\\$&')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function escapeInline(value: string): string {
  return value
    .replaceAll('`', '')
    .replace(/[\r\n]/g, '')
    .slice(0, 200);
}

function isReviewPublisher(
  value: GitHubReader | null,
): value is GitHubReader & GitHubReviewPublisher {
  return Boolean(value && 'upsertPullRequestComment' in value);
}

function requiredPayload(job: PublicationJob, key: 'analysisId' | 'pullRequestId'): string {
  const value = job.payload[key];
  if (!value) throw new ReviewPublicationError(`Publication job payload is missing ${key}`, false);
  return value;
}
