import type { Database } from '@gcr/db';
import { knowledgePublicationStatus } from '@gcr/client-contract';
import { knowledgeUserAllowed } from './knowledge-projection.js';
import { criteriaNotFound } from './review-criteria.js';
export async function readKnowledgeStatus(
  database: Database,
  repositoryId: string,
  userId: string,
  enabled: boolean,
) {
  const c = await database.connect();
  try {
    await c.query('begin isolation level repeatable read read only');
    if (!(await knowledgeUserAllowed(c, repositoryId, userId, 'reader'))) throw criteriaNotFound();
    const rows = (
      await c.query<{
        component: string;
        requested_revision: string;
        published_revision: string;
        release_sequence: number;
        current_release_id: string | null;
        last_error: string | null;
        updated_at: Date;
        excluded_count: number;
        content_hash: string | null;
        byte_size: number | null;
        artifact_state: string | null;
      }>(
        `select s.component,s.requested_revision,s.published_revision,s.release_sequence,s.current_release_id,s.last_error,s.updated_at,jsonb_array_length(s.last_excluded_items) as excluded_count,r.content_hash,r.byte_size,a.state as artifact_state
   from review_knowledge_scopes s left join review_knowledge_releases r on r.id=s.current_release_id left join artifacts a on a.id=r.artifact_id
   where s.repository_id=$1 and (s.component in ('policy','collective') or (s.component='personal' and s.owner_user_id=$2))`,
        [repositoryId, userId],
      )
    ).rows;
    const components = ['policy', 'collective', 'personal'].map((component) => {
      const row = rows.find((item) => item.component === component);
      const state = !enabled
        ? 'disabled'
        : !row
          ? 'unpublished'
          : row.last_error
            ? 'failed'
            : row.requested_revision !== row.published_revision
              ? 'pending'
              : !row.current_release_id
                ? 'unpublished'
                : row.artifact_state !== 'available'
                  ? 'unavailable'
                  : 'published';
      return {
        component,
        state,
        requestedRevision: row?.requested_revision ?? null,
        publishedRevision: row?.published_revision ?? null,
        releaseSequence: row?.release_sequence ?? 0,
        bundleId: row?.current_release_id ?? null,
        contentHash: row?.content_hash ?? null,
        sizeBytes: row?.byte_size ?? null,
        updatedAt: row?.updated_at.toISOString() ?? null,
        lastError: row?.last_error ?? null,
        excludedCount: row?.excluded_count ?? 0,
      };
    });
    const result = knowledgePublicationStatus({
      schemaVersion: 1,
      enabled,
      compatibleClientContracts: { minimum: 1, maximum: 1 },
      syncObservation: 'unknown',
      components,
    });
    await c.query('commit');
    return result;
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}
