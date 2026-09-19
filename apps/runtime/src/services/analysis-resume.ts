import type { Database } from '@gcr/db';
import { appendEvent } from '../events/index.js';
import { analysisModelLimit, AnalysisModelCooldownError } from './analysis-model-limit.js';

/** Explicit continuation creates a new immutable report revision and a new bounded call budget. */
export async function resumeAnalysis(database: Database, analysisId: string, requestedBy: string) {
  const c = await database.connect();
  try {
    await c.query('begin');
    const source = (
      await c.query<{
        snapshot_id: string;
        pull_id: string;
        memory_owner_user_id: string | null;
        skip_publication: boolean;
      }>(
        `select a.snapshot_id,p.id as pull_id,a.memory_owner_user_id,exists(select 1 from jobs j where j.payload->>'analysisId'=a.id::text and j.payload->>'skipPublication'='true') as skip_publication from analysis_runs a join snapshots s on s.id=a.snapshot_id join snapshot_requests r on r.id=s.request_id join pull_requests p on p.id=r.pull_request_id join repositories repo on repo.id=p.repository_id where a.id=$1 and a.state in ('partial','failed') and (a.memory_owner_user_id is null or a.memory_owner_user_id=$2) and repo.enabled and repo.deleted_at is null and p.state='open' and p.head_sha=r.head_sha and p.base_sha=r.base_sha and exists(select 1 from analysis_review_plans where analysis_id=a.id) for update of a,p,repo`,
        [analysisId, requestedBy],
      )
    ).rows[0];
    if (!source) {
      await c.query('rollback');
      return null;
    }
    const previous = (
      await c.query<{ id: string }>(
        `select id from analysis_runs where resume_from_analysis_id=$1`,
        [analysisId],
      )
    ).rows[0];
    if (previous) {
      await c.query('commit');
      return { analysisId: previous.id, deduplicated: true };
    }
    const limit = await analysisModelLimit(c, analysisId);
    if (limit?.active) throw new AnalysisModelCooldownError(limit.retryAt);
    // Share the existing refresh limit; reader-only users cannot reach this service's route.
    if (
      Number(
        (
          await c.query(
            `select count(*) from operations where requested_by=$1 and state in ('queued','polling','materializing','analyzing')`,
            [requestedBy],
          )
        ).rows[0].count,
      ) >= 5
    )
      throw Error('REFRESH_LIMIT_EXCEEDED');
    const operation = (
      await c.query<{ id: string }>(
        `insert into operations(type,scope_type,scope_id,state,dedupe_key,requested_by) values('pr_refresh','pull_request',$1,'queued',$2,$3) returning id`,
        [source.pull_id, `analysis-resume:${analysisId}`, requestedBy],
      )
    ).rows[0]!;
    const next = (
      await c.query<{ id: string }>(
        `insert into analysis_runs(snapshot_id,analysis_key,revision,state,stage,progress,profile,model_profile,prompt_version_id,prompt_hash,provider_version_id,provider_hash,policy_hash,skill_version_id,skill_bundle,skill_hash,severity_level,memory_hash,memory_context,memory_owner_user_id,shared_knowledge,shared_knowledge_hash,resume_from_analysis_id)
  select snapshot_id,analysis_key||':resume',revision+1,'queued','planning',0,profile,model_profile,prompt_version_id,prompt_hash,provider_version_id,provider_hash,policy_hash,skill_version_id,skill_bundle,skill_hash,severity_level,memory_hash,memory_context,memory_owner_user_id,shared_knowledge,shared_knowledge_hash,id from analysis_runs where id=$1 returning id`,
        [analysisId],
      )
    ).rows[0]!;
    // Keep the exact selection; normal worker expiry/revocation checks still apply.
    await c.query(
      `insert into analysis_shared_selections(analysis_id,context,context_hash) select $2,context,context_hash from analysis_shared_selections where analysis_id=$1`,
      [analysisId, next.id],
    );
    await c.query(
      `insert into jobs(type,payload,priority,dedupe_key) values('analysis.run',$1::jsonb,10,$2)`,
      [
        JSON.stringify({
          analysisId: next.id,
          snapshotId: source.snapshot_id,
          operationId: operation.id,
          pullRequestId: source.pull_id,
          skipPublication: source.skip_publication,
          ...(source.memory_owner_user_id
            ? { memoryOwnerUserId: source.memory_owner_user_id }
            : {}),
        }),
        `analysis.run:${next.id}`,
      ],
    );
    await appendEvent(c, 'analysis', next.id, 'analysis.resumed', {
      analysisId: next.id,
      previousAnalysisId: analysisId,
      requestedBy,
    });
    await c.query('commit');
    return { analysisId: next.id, deduplicated: false };
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}
