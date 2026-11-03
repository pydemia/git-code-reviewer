import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Database, DatabaseClient } from '@gcr/db';
import type { FilesystemArtifactStore } from '@gcr/artifact-store';
import {
  canonicalKnowledgeJson,
  centralKnowledgeBundle,
  knowledgeManifestPayload,
  signedKnowledgeManifest,
  KNOWLEDGE_SIGNATURE_CONTEXT,
  type KnowledgeManifestPayload,
  type SignedKnowledgeManifest,
} from '@gcr/client-contract';
import { knowledgeUserAllowed } from './knowledge-projection.js';
import { CriterionError } from './review-criteria.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const unavailable = (code = 'KNOWLEDGE_PENDING') =>
  new CriterionError(503, code, '리뷰 지식 배포가 준비되지 않았습니다.');
export class KnowledgeSigner {
  readonly #key: KeyObject;
  readonly publicKeyHash: string;
  readonly publicKeyPem: string;
  constructor(
    readonly serverId: string,
    readonly keyId: string,
    privateKey: string | KeyObject,
    readonly offlineLeaseSeconds: number,
  ) {
    this.#key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
    if (
      this.#key.type !== 'private' ||
      this.#key.asymmetricKeyType !== 'ed25519' ||
      !Number.isInteger(offlineLeaseSeconds) ||
      offlineLeaseSeconds < 0 ||
      offlineLeaseSeconds > 86400
    )
      throw Error('Invalid knowledge signing configuration');
    this.publicKeyPem = createPublicKey(this.#key)
      .export({ type: 'spki', format: 'pem' })
      .toString();
    this.publicKeyHash = digest(this.publicKeyPem);
  }
  sign(payload: KnowledgeManifestPayload): SignedKnowledgeManifest {
    const parsed = knowledgeManifestPayload(payload);
    const bytes = canonicalKnowledgeJson(parsed);
    return signedKnowledgeManifest({
      payload: parsed,
      manifestHash: digest(bytes),
      signature: sign(null, Buffer.from(KNOWLEDGE_SIGNATURE_CONTEXT + bytes), this.#key).toString(
        'base64url',
      ),
    });
  }
}
export async function loadKnowledgeSigner(
  database: Database,
  settings: { serverId: string; keyId: string; keyFile: string; offlineLeaseSeconds: number },
) {
  const signer = new KnowledgeSigner(
    settings.serverId,
    settings.keyId,
    await readFile(settings.keyFile, 'utf8'),
    settings.offlineLeaseSeconds,
  );
  await bindKnowledgeSigner(database, signer);
  return signer;
}
export async function bindKnowledgeSigner(database: Database, signer: KnowledgeSigner) {
  const c = await database.connect();
  try {
    await c.query('begin');
    const state = (
      await c.query<{ server_id: string | null }>(
        'select server_id from review_knowledge_security_state where singleton for update',
      )
    ).rows[0]!;
    if (state.server_id && state.server_id !== signer.serverId)
      throw Error('Knowledge server identity mismatch');
    if (!state.server_id)
      await c.query('update review_knowledge_security_state set server_id=$1 where singleton', [
        signer.serverId,
      ]);
    await c.query(
      'insert into review_knowledge_signing_keys(key_id,public_key_hash) values($1,$2) on conflict(key_id) do nothing',
      [signer.keyId, signer.publicKeyHash],
    );
    const registered = (
      await c.query<{ public_key_hash: string }>(
        'select public_key_hash from review_knowledge_signing_keys where key_id=$1',
        [signer.keyId],
      )
    ).rows[0]!;
    if (registered.public_key_hash !== signer.publicKeyHash)
      throw Error('Knowledge key ID already belongs to another key');
    await c.query('commit');
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}
export async function ensureKnowledgeScopes(
  database: Database,
  repositoryId: string,
  userId: string,
) {
  if (!(await knowledgeUserAllowed(database, repositoryId, userId, 'reader')))
    throw new CriterionError(403, 'KNOWLEDGE_ACCESS_REVOKED', '저장소 접근 권한이 없습니다.');
  const c = await database.connect();
  try {
    await c.query('begin');
    for (const part of ['policy', 'collective', 'personal']) {
      const owner = part === 'personal' ? userId : null;
      const created = await c.query<{ id: string }>(
        `insert into review_knowledge_scopes(repository_id,component,owner_user_id,requested_revision) values($1,$2,$3,1)
     on conflict(repository_id,component,owner_key) do nothing returning id`,
        [repositoryId, part, owner],
      );
      if (created.rows[0])
        await c.query(
          "insert into review_knowledge_outbox(scope_id,revision,reason) values($1,1,'client-first-use')",
          [created.rows[0].id],
        );
    }
    await c.query('commit');
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}
type PublishedComponent = {
  component: 'policy' | 'collective' | 'personal';
  current_release_id: string;
  release_sequence: number;
  content_hash: string;
  byte_size: number;
  locator: string;
  requested_revision: string;
  published_revision: string;
  artifact_state: string;
  artifact_version: number;
  tenant_id: string;
  owner_user_id: string | null;
};
async function coherentComponents(
  c: Pick<DatabaseClient, 'query'>,
  repositoryId: string,
  userId: string,
) {
  const rows = (
    await c.query<PublishedComponent>(
      `select s.component,s.current_release_id,s.release_sequence,s.requested_revision,s.published_revision,s.owner_user_id,r.content_hash,r.byte_size,a.locator,a.state as artifact_state,a.version as artifact_version,repo.tenant_id
 from review_knowledge_scopes s join repositories repo on repo.id=s.repository_id
 left join review_knowledge_releases r on r.id=s.current_release_id left join artifacts a on a.id=r.artifact_id
 where s.repository_id=$1 and (s.component in ('policy','collective') or (s.component='personal' and s.owner_user_id=$2)) order by s.component`,
      [repositoryId, userId],
    )
  ).rows;
  if (
    rows.length !== 3 ||
    new Set(rows.map((x) => x.component)).size !== 3 ||
    rows.some(
      (x) =>
        !x.current_release_id ||
        x.requested_revision !== x.published_revision ||
        x.artifact_state !== 'available' ||
        x.artifact_version !== 2,
    )
  )
    throw unavailable();
  return rows;
}
async function authorizationRevision(
  c: Pick<DatabaseClient, 'query'>,
  repositoryId: string,
  userId: string,
) {
  // The same snapshot supplies authorization and the complete release combination.
  const state = (
    await c.query<{ authorization_revision: string }>(
      'select authorization_revision from review_knowledge_security_state where singleton for share',
    )
  ).rows[0]!;
  if (!(await knowledgeUserAllowed(c, repositoryId, userId, 'reader')))
    throw new CriterionError(403, 'KNOWLEDGE_ACCESS_REVOKED', '저장소 접근 권한이 없습니다.');
  const revision = Number(state.authorization_revision);
  if (!Number.isSafeInteger(revision)) throw unavailable('KNOWLEDGE_AUTHORIZATION_OVERFLOW');
  return revision;
}
export async function issueKnowledgeManifest(
  database: Database,
  store: FilesystemArtifactStore,
  signer: KnowledgeSigner,
  repositoryId: string,
  userId: string,
  clientContractVersion = 2,
) {
  await ensureKnowledgeScopes(database, repositoryId, userId);
  const c = await database.connect();
  try {
    await c.query('begin isolation level repeatable read');
    const revision = await authorizationRevision(c, repositoryId, userId);
    await c.query('select pg_advisory_xact_lock_shared(746278433)');
    const rows = await coherentComponents(c, repositoryId, userId);
    let minimumClientContract = 2;
    for (const row of rows) {
      const info = await store.inspect(row.locator);
      if (!info.exists || info.checksum !== row.content_hash || info.byteSize !== row.byte_size)
        throw unavailable('KNOWLEDGE_ARTIFACT_UNAVAILABLE');
      const bytes = await store.readText(row.locator);
      if (digest(bytes) !== row.content_hash || Buffer.byteLength(bytes) !== row.byte_size)
        throw unavailable('KNOWLEDGE_ARTIFACT_UNAVAILABLE');
      const bundle = centralKnowledgeBundle(JSON.parse(bytes));
      const sources =
        bundle.component === 'policy'
          ? bundle.criteria.flatMap((criterion) => criterion.decision.sources)
          : bundle.memories.flatMap((memory) => memory.sources);
      if (sources.some((source) => source.kind === 'snapshot-change')) minimumClientContract = 3;
    }
    if (![2, 3].includes(clientContractVersion) || clientContractVersion < minimumClientContract)
      throw new CriterionError(
        426,
        'KNOWLEDGE_CLIENT_UPGRADE_REQUIRED',
        '코드 변경 출처를 지원하는 클라이언트로 업데이트해 주세요.',
      );
    const components = Object.fromEntries(
      rows.map((row) => [
        row.component,
        {
          bundleId: row.current_release_id,
          releaseSequence: row.release_sequence,
          contentHash: row.content_hash,
          sizeBytes: row.byte_size,
        },
      ]),
    ) as KnowledgeManifestPayload['components'];
    const audience = {
      serverId: signer.serverId,
      tenantId: rows[0]!.tenant_id,
      repositoryId,
      userId,
    };
    const recipe = digest(
      canonicalKnowledgeJson({
        audience,
        components,
        authorizationRevision: revision,
        keyId: signer.keyId,
        keyHash: signer.publicKeyHash,
        leaseSeconds: signer.offlineLeaseSeconds,
        compatibleClientContracts: { minimum: minimumClientContract, maximum: 3 },
      }),
    );
    const cached = (
      await c.query<{ manifest: unknown }>(
        'select manifest from review_knowledge_manifests where repository_id=$1 and owner_user_id=$2 and recipe_hash=$3 and refresh_after>clock_timestamp() order by refresh_after desc limit 1',
        [repositoryId, userId, recipe],
      )
    ).rows[0];
    if (cached) {
      await c.query('commit');
      return signedKnowledgeManifest(cached.manifest);
    }
    const now = (await c.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]!.now;
    const manifest = signer.sign({
      schemaVersion: 1,
      audience,
      snapshotId: randomUUID(),
      authorizationRevision: revision,
      components,
      revocations: {
        policyMinimumSequence: components.policy.releaseSequence,
        collectiveMinimumSequence: components.collective.releaseSequence,
        personalMinimumSequence: components.personal.releaseSequence,
      },
      compatibleClientContracts: { minimum: minimumClientContract, maximum: 3 },
      issuedAt: now.toISOString(),
      refreshAfter: new Date(now.getTime() + 300000).toISOString(),
      offlineValidUntil: new Date(now.getTime() + signer.offlineLeaseSeconds * 1000).toISOString(),
      signingKeyId: signer.keyId,
    });
    await c.query(
      `insert into review_knowledge_manifests(id,repository_id,owner_user_id,recipe_hash,manifest,manifest_hash,refresh_after,expires_at)
    values($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
      [
        manifest.payload.snapshotId,
        repositoryId,
        userId,
        recipe,
        JSON.stringify(manifest),
        manifest.manifestHash,
        manifest.payload.refreshAfter,
        new Date(
          Math.max(
            Date.parse(manifest.payload.refreshAfter),
            Date.parse(manifest.payload.offlineValidUntil),
          ),
        ),
      ],
    );
    await c.query('commit');
    return manifest;
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}
export async function downloadKnowledgeBundle(
  database: Database,
  store: FilesystemArtifactStore,
  repositoryId: string,
  userId: string,
  snapshotId: string,
  bundleId: string,
) {
  const c = await database.connect();
  try {
    await c.query('begin isolation level repeatable read');
    const revision = await authorizationRevision(c, repositoryId, userId);
    await c.query('select pg_advisory_xact_lock_shared(746278433)');
    const stored = (
      await c.query<{ manifest: unknown }>(
        'select manifest from review_knowledge_manifests where id=$1 and repository_id=$2 and owner_user_id=$3 and expires_at>clock_timestamp()',
        [snapshotId, repositoryId, userId],
      )
    ).rows[0];
    if (!stored)
      throw new CriterionError(
        404,
        'KNOWLEDGE_SNAPSHOT_NOT_FOUND',
        '사용 가능한 배포 snapshot이 없습니다.',
      );
    const manifest = signedKnowledgeManifest(stored.manifest).payload;
    if (manifest.authorizationRevision !== revision)
      throw new CriterionError(
        409,
        'KNOWLEDGE_SNAPSHOT_STALE',
        '권한이 변경됐습니다. Manifest를 다시 확인해 주세요.',
      );
    const rows = await coherentComponents(c, repositoryId, userId);
    for (const row of rows)
      if (manifest.components[row.component].bundleId !== row.current_release_id)
        throw new CriterionError(
          409,
          'KNOWLEDGE_SNAPSHOT_STALE',
          '배포 버전이 변경됐습니다. Manifest를 다시 확인해 주세요.',
        );
    const row = rows.find((x) => x.current_release_id === bundleId);
    if (!row)
      throw new CriterionError(
        404,
        'KNOWLEDGE_BUNDLE_NOT_FOUND',
        '이 snapshot의 bundle이 아닙니다.',
      );
    let bytes: string;
    try {
      bytes = await store.readText(row.locator);
    } catch {
      throw unavailable('KNOWLEDGE_ARTIFACT_UNAVAILABLE');
    }
    if (Buffer.byteLength(bytes) !== row.byte_size || digest(bytes) !== row.content_hash)
      throw unavailable('KNOWLEDGE_ARTIFACT_UNAVAILABLE');
    let bundle: ReturnType<typeof centralKnowledgeBundle>;
    try {
      bundle = centralKnowledgeBundle(JSON.parse(bytes));
    } catch {
      throw unavailable('KNOWLEDGE_ARTIFACT_INVALID');
    }
    if (
      bundle.repositoryId !== repositoryId ||
      bundle.tenantId !== manifest.audience.tenantId ||
      bundle.component !== row.component ||
      bundle.ownerUserId !== (row.component === 'personal' ? userId : null)
    )
      throw unavailable('KNOWLEDGE_ARTIFACT_SCOPE_MISMATCH');
    await c.query('commit');
    return { bytes, contentHash: row.content_hash };
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}

/** Bounded cache cleanup; live manifests remain immutable and cannot be removed. */
export async function removeExpiredKnowledgeManifests(database: Database) {
  const result = await database.query(`delete from review_knowledge_manifests where id in
 (select id from review_knowledge_manifests where expires_at<=clock_timestamp() order by expires_at,id limit 1000 for update skip locked)`);
  return result.rowCount ?? 0;
}
