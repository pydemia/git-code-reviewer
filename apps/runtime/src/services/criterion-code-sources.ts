import { criterionCodeChangeSchema, criterionSourceSchema } from '@gcr/contracts';
import type { DatabaseClient } from '@gcr/db';
import { criteriaHash } from './review-criteria.js';

type Connection = Pick<DatabaseClient, 'query'>;
// Every field is derived from the selected immutable snapshot, never the PR's
// current head. mergeBaseSha is the old side of this diff; baseSha is the target tip.
const selection = `select f.id, p.number as "pullRequestNumber", f.path,
 f.previous_path as "previousPath", f.status, s.id as "snapshotId",
 r.base_sha as "baseSha", r.head_sha as "headSha", s.merge_base_sha as "mergeBaseSha"
 from snapshot_files f join snapshots s on s.id=f.snapshot_id
 join snapshot_requests r on r.id=s.request_id
 join pull_requests p on p.id=r.pull_request_id`;
const eligible = `s.resolution='exact' and s.merge_base_sha is not null and f.status<>'binary'`;

function metadata(row: unknown) {
  return criterionCodeChangeSchema.parse({
    ...(row as object),
    evidenceKind: 'diff-hunks',
    validation: 'not-observed',
  });
}
function source(row: Record<string, unknown>) {
  const { id, content, contentHash, ...fields } = row;
  const codeChange = metadata(fields);
  if (criteriaHash({ content, codeChange }) !== contentHash) return null;
  return criterionSourceSchema.parse({
    kind: 'snapshot-change',
    id,
    content,
    contentHash,
    codeChange,
    label: `PR #${codeChange.pullRequestNumber} · ${codeChange.path}`.slice(0, 500),
    baseSha: codeChange.baseSha,
    headSha: codeChange.headSha,
  });
}

export async function captureSnapshotChangeSource(
  connection: Connection,
  fileId: string,
  content: string,
) {
  // Do not truncate code into an apparently complete source. Binary, large, empty
  // and unresolved diffs stay available through their original snapshot artifacts.
  if (!content.trim() || content.length > 12000 || Buffer.byteLength(content) > 48000) return;
  const found = await connection.query<Record<string, unknown>>(
    `${selection} where f.id=$1 and ${eligible}`,
    [fileId],
  );
  if (!found.rows[0]) return;
  const fields = { ...found.rows[0] };
  delete fields.id;
  const codeChange = metadata(fields);
  await connection.query(
    'insert into snapshot_change_sources(file_id,content,content_hash) values($1,$2,$3)',
    [fileId, content, criteriaHash({ content, codeChange })],
  );
}

export async function listSnapshotChangeSources(
  connection: Connection,
  repositoryId: string,
  fileId?: string,
  lock = false,
) {
  const found = await connection.query<Record<string, unknown>>(
    `${selection.replace('select f.id,', 'select c.content, c.content_hash as "contentHash", f.id,')}
     join snapshot_change_sources c on c.file_id=f.id
     where p.repository_id=$1 and ${eligible} ${fileId ? 'and f.id=$2' : ''}
     order by s.created_at desc, f.id limit 100 ${lock ? 'for share of c,f,s,r,p' : ''}`,
    fileId ? [repositoryId, fileId] : [repositoryId],
  );
  return found.rows.flatMap((row) => {
    const value = source(row);
    return value ? [value] : [];
  });
}
