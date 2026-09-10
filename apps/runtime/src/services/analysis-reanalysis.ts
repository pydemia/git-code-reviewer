import { randomUUID } from 'node:crypto';
import type { Database } from '@gcr/db';
import { appendEvent } from '../events/index.js';

// HTTP에 노출하지 않는 운영용 함수. 사용자 승인 후 지정한 공동 미완료 분석만
// 동일 snapshot·Prompt·Provider·Skill·Memory로 재검토하며 GitHub 게시를 억제한다.
// requestId를 재사용하면 완료 후에도 같은 분석을 반환한다. 기존 ledger는 손대지 않는다.
export async function queueIncompleteAnalysisReanalysis(
  database: Database,
  sourceAnalysisId: string,
  requestId: string,
): Promise<{ analysisId: string; revision: number }> {
  if (!/^[0-9a-f-]{36}$/i.test(sourceAnalysisId) || !/^[0-9a-f-]{36}$/i.test(requestId))
    throw Error('invalid_reanalysis_identifier');
  const client = await database.connect();
  try {
    await client.query('begin');
    const source = (
      await client.query(
        `select ar.snapshot_id, ar.state, ar.memory_owner_user_id, sr.pull_request_id
       from analysis_runs ar join snapshots s on s.id=ar.snapshot_id
       join snapshot_requests sr on sr.id=s.request_id where ar.id=$1 for update of s`,
        [sourceAnalysisId],
      )
    ).rows[0];
    if (!source || source.memory_owner_user_id || !['partial', 'failed'].includes(source.state))
      throw Error('reanalysis_requires_incomplete_shared_analysis');
    const key = `approved-reanalysis:${sourceAnalysisId}:${requestId}`;
    const previous = (
      await client.query(
        'select id as "analysisId", revision from analysis_runs where analysis_key=$1',
        [key],
      )
    ).rows[0];
    if (previous) {
      await client.query('commit');
      return previous;
    }
    const revision = Number(
      (
        await client.query(
          'select coalesce(max(revision),0)+1 as next from analysis_runs where snapshot_id=$1',
          [source.snapshot_id],
        )
      ).rows[0].next,
    );
    const analysisId = randomUUID(),
      operationId = randomUUID();
    await client.query(
      `insert into analysis_runs(id, snapshot_id, analysis_key, revision, state, stage, profile,
         model_profile, prompt_version_id, prompt_hash, provider_version_id, provider_hash,
         policy_hash, skill_version_id, skill_bundle, skill_hash, severity_level, memory_hash,
         memory_context, memory_owner_user_id)
       select $2, snapshot_id, $3, $4, 'queued', 'planning', profile, model_profile,
         prompt_version_id, prompt_hash, provider_version_id, provider_hash, policy_hash,
         skill_version_id, skill_bundle, skill_hash, severity_level, memory_hash, memory_context,
         memory_owner_user_id from analysis_runs where id=$1`,
      [sourceAnalysisId, analysisId, key, revision],
    );
    const result = { analysisId, revision, sourceAnalysisId, skipPublication: true };
    await client.query(
      `insert into operations(id,type,scope_type,scope_id,state,dedupe_key,result)
       values($1,'analysis.reanalyze','pull_request',$2,'analyzing',$3,$4::jsonb)`,
      [operationId, source.pull_request_id, key, JSON.stringify(result)],
    );
    await client.query(
      `insert into jobs(type,payload,priority,dedupe_key) values('analysis.run',$1::jsonb,100,$2)`,
      [
        JSON.stringify({
          operationId,
          analysisId,
          snapshotId: source.snapshot_id,
          pullRequestId: source.pull_request_id,
          skipPublication: true,
        }),
        `analysis.run:${analysisId}`,
      ],
    );
    await appendEvent(client, 'analysis', analysisId, 'analysis.reanalysis_requested', result);
    await appendEvent(client, 'pull_request', source.pull_request_id, 'analysis.state', {
      ...result,
      state: 'queued',
      stage: 'planning',
      progress: 0,
    });
    await client.query('commit');
    return { analysisId, revision };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
