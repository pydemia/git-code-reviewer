import { createHash } from 'node:crypto';
import { ZodError } from 'zod';
import type { Database } from '@gcr/db';
import type { FilesystemArtifactStore } from '@gcr/artifact-store';
import { ContractError } from '@gcr/client-contract';
import { CriterionError } from './review-criteria.js';
import { projectKnowledge, type KnowledgeScope } from './knowledge-projection.js';

type Store = Pick<FilesystemArtifactStore, 'commitText' | 'inspect'>;
export async function claimKnowledgePublication(
  database: Database,
): Promise<KnowledgeScope | null> {
  const found = await database.query<KnowledgeScope>(`with candidate as (
    select id from review_knowledge_scopes where requested_revision>published_revision and retry_after<=clock_timestamp()
    and (claim_token is null or claim_until<=clock_timestamp()) order by retry_after,id for update skip locked limit 1)
    update review_knowledge_scopes s set claim_token=gen_random_uuid(),claim_until=clock_timestamp()+interval '2 minutes'
    from candidate c where s.id=c.id returning s.*`);
  return found.rows[0] ?? null;
}
export async function publishKnowledge(database: Database, store: Store, claim: KnowledgeScope) {
  const connection = await database.connect();
  try {
    await connection.query('begin isolation level repeatable read read only');
    const owned = await connection.query(
      `select id from review_knowledge_scopes where id=$1 and claim_token=$2 and requested_revision=$3 and claim_until>clock_timestamp()`,
      [claim.id, claim.claim_token, claim.requested_revision],
    );
    if (!owned.rowCount) {
      await connection.query('rollback');
      await connection.query(
        'update review_knowledge_scopes set claim_token=null,claim_until=null where id=$1 and claim_token=$2',
        [claim.id, claim.claim_token],
      );
      return 'superseded';
    }
    const projection = await projectKnowledge(connection, claim);
    await connection.query('commit');
    const checksum = createHash('sha256').update(projection.bytes).digest('hex');
    const byteSize = Buffer.byteLength(projection.bytes);
    const locator = `review-knowledge/${claim.id}/${checksum}.json`;
    await connection.query('begin');
    // Retention takes this lock exclusively while selecting/removing orphan files.
    // Keep artifact verification and DB publication protected from that race.
    await connection.query('select pg_advisory_xact_lock_shared(746278433)');
    const latest = (
      await connection.query<{
        requested_revision: string;
        current_release_id: string | null;
        release_sequence: number;
        content_hash: string | null;
      }>(
        `select s.requested_revision,s.current_release_id,s.release_sequence,r.content_hash
      from review_knowledge_scopes s left join review_knowledge_releases r on r.id=s.current_release_id
      where s.id=$1 and s.claim_token=$2 and s.claim_until>clock_timestamp() for update of s`,
        [claim.id, claim.claim_token],
      )
    ).rows[0];
    if (!latest || latest.requested_revision !== claim.requested_revision) {
      await connection.query(
        'update review_knowledge_scopes set claim_token=null,claim_until=null where id=$1 and claim_token=$2',
        [claim.id, claim.claim_token],
      );
      await connection.query('commit');
      return 'superseded';
    }
    const written = await store.commitText(locator, projection.bytes);
    const readback = await store.inspect(locator);
    if (
      written.checksum !== checksum ||
      written.byteSize !== byteSize ||
      !readback.exists ||
      readback.checksum !== checksum ||
      readback.byteSize !== byteSize
    )
      throw Error('artifact verification failed');
    const artifact = (
      await connection.query<{ id: string; checksum: string; byte_size: string; scope_id: string }>(
        `insert into artifacts(scope_type,scope_id,artifact_type,version,checksum,byte_size,locator)
      values('review-knowledge',$1,$2,1,$2,$3,$4) on conflict(locator) do update set state='available',last_error=null,last_verified_at=clock_timestamp()
      returning id,checksum,byte_size,scope_id`,
        [claim.id, checksum, byteSize, locator],
      )
    ).rows[0]!;
    if (
      artifact.checksum !== checksum ||
      Number(artifact.byte_size) !== byteSize ||
      artifact.scope_id !== claim.id
    )
      throw Error('artifact registry mismatch');
    let releaseId = latest.current_release_id;
    let sequence = latest.release_sequence;
    if (latest.content_hash !== checksum) {
      sequence++;
      releaseId = (
        await connection.query<{ id: string }>(
          `insert into review_knowledge_releases(scope_id,sequence,source_revision,artifact_id,content_hash,byte_size,excluded_items)
      values($1,$2,$3,$4,$5,$6,$7::jsonb) returning id`,
          [
            claim.id,
            sequence,
            claim.requested_revision,
            artifact.id,
            checksum,
            byteSize,
            JSON.stringify(projection.excluded),
          ],
        )
      ).rows[0]!.id;
    }
    await connection.query(
      `update review_knowledge_scopes set current_release_id=$2,release_sequence=$3,published_revision=$4,
      claim_token=null,claim_until=null,last_error=null,last_excluded_items=$5::jsonb,updated_at=clock_timestamp() where id=$1`,
      [
        claim.id,
        releaseId,
        sequence,
        claim.requested_revision,
        JSON.stringify(projection.excluded),
      ],
    );
    await connection.query(
      'update review_knowledge_outbox set processed_at=clock_timestamp() where scope_id=$1 and revision<=$2 and processed_at is null',
      [claim.id, claim.requested_revision],
    );
    await connection.query('commit');
    return latest.content_hash === checksum ? 'reused' : 'published';
  } catch (error) {
    await connection.query('rollback');
    const code =
      error instanceof CriterionError
        ? error.code
        : error instanceof ContractError || error instanceof ZodError
          ? 'PUBLICATION_INVALID'
          : 'PUBLICATION_STORAGE_FAILED';
    await connection.query(
      `update review_knowledge_scopes set claim_token=null,claim_until=null,last_error=$3,retry_after=clock_timestamp()+interval '30 seconds'
      where id=$1 and claim_token=$2`,
      [claim.id, claim.claim_token, code],
    );
    return 'failed';
  } finally {
    connection.release();
  }
}
export async function publishNextKnowledge(database: Database, store: Store) {
  const claim = await claimKnowledgePublication(database);
  return claim ? publishKnowledge(database, store, claim) : 'idle';
}
