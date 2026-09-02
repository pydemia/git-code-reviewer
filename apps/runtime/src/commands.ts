import { mkdir, readdir, rm } from 'node:fs/promises';
import { FilesystemArtifactStore } from '@gcr/artifact-store';
import { createDatabase, runMigrations, type DatabaseClient } from '@gcr/db';
import type { AppConfig } from './config.js';
import { runWorker } from './jobs/worker.js';
import { buildServer } from './server.js';

export async function serve(config: AppConfig): Promise<void> {
  const app = await buildServer(config);
  await app.listen({ host: config.HOST, port: config.PORT });
  await waitForSignal(async () => app.close());
}

export async function migrate(config: AppConfig): Promise<void> {
  const database = createDatabase(config.DATABASE_URL, 1);
  try {
    await runMigrations(database, config.MIGRATIONS_DIR);
    process.stdout.write('Migrations applied\n');
  } finally {
    await database.end();
  }
}

export async function worker(config: AppConfig): Promise<void> {
  await runWorker(config);
}

export async function retention(config: AppConfig, reconcile: boolean): Promise<void> {
  const database = createDatabase(config.DATABASE_URL, 2);
  const connection = await database.connect();
  const artifacts = new FilesystemArtifactStore(config.ARTIFACT_ROOT);
  const lockId = 746_278_433;
  try {
    const lock = await connection.query<{ acquired: boolean }>(
      'select pg_try_advisory_lock($1) as acquired',
      [lockId],
    );
    if (!lock.rows[0]?.acquired) {
      process.stdout.write('{"status":"skipped","reason":"retention-lock-held"}\n');
      return;
    }

    const workspacesDeleted = await cleanupExpiredWorkspaces(config.WORKSPACE_ROOT);
    const result = reconcile
      ? await reconcileArtifacts(connection, artifacts, config)
      : await applyRetention(connection, artifacts, config);
    process.stdout.write(
      `${JSON.stringify({ status: 'completed', mode: reconcile ? 'reconcile' : 'retention', workspacesDeleted, ...result })}\n`,
    );
  } finally {
    await connection.query('select pg_advisory_unlock($1)', [lockId]).catch(() => undefined);
    connection.release();
    await database.end();
  }
}

type ArtifactRow = {
  id: string;
  scope_id: string;
  locator: string;
  checksum: string;
  state: 'available' | 'deleting' | 'unavailable';
  delete_after: Date | null;
};

async function applyRetention(
  database: DatabaseClient,
  artifacts: FilesystemArtifactStore,
  config: AppConfig,
) {
  const chats = await database.query<{ id: string }>(
    `with candidates as (
       select cs.id from chat_sessions cs
       where cs.updated_at < clock_timestamp() - make_interval(days => $1)
         and not exists (
           select 1 from chat_messages cm
           where cm.session_id = cs.id and cm.status = 'pending'
         )
       order by cs.updated_at limit $2
     )
     delete from chat_sessions cs using candidates candidate
     where cs.id = candidate.id returning cs.id`,
    [config.RETENTION_CHAT_DAYS, config.RETENTION_BATCH_SIZE],
  );

  const analyses = await database.query<{ id: string }>(
    `select ar.id from analysis_runs ar
     where ar.state in ('completed', 'partial', 'failed', 'cancelled')
       and coalesce(ar.finished_at, ar.created_at) <
         clock_timestamp() - make_interval(days => $1)
       and not exists (select 1 from chat_sessions cs where cs.analysis_run_id = ar.id)
     order by coalesce(ar.finished_at, ar.created_at), ar.id limit $2`,
    [config.RETENTION_REPORT_DAYS, config.RETENTION_BATCH_SIZE],
  );
  const analysisCleanup = await cleanupScopes(
    database,
    artifacts,
    'analysis',
    analyses.rows.map((row) => row.id),
    config.RETENTION_DELETE_GRACE_HOURS,
    async (scopeId) => {
      const deleted = await database.query<{ id: string }>(
        `delete from analysis_runs where id = $1
         and not exists (select 1 from chat_sessions where analysis_run_id = $1)
         returning id`,
        [scopeId],
      );
      return (deleted.rowCount ?? 0) > 0;
    },
  );

  const snapshots = await database.query<{ id: string }>(
    `select snapshot.id from snapshots snapshot
     where snapshot.created_at < clock_timestamp() - make_interval(days => $1)
       and not exists (select 1 from analysis_runs ar where ar.snapshot_id = snapshot.id)
     order by snapshot.created_at, snapshot.id limit $2`,
    [config.RETENTION_REPORT_DAYS, config.RETENTION_BATCH_SIZE],
  );
  const snapshotCleanup = await cleanupScopes(
    database,
    artifacts,
    'snapshot',
    snapshots.rows.map((row) => row.id),
    config.RETENTION_DELETE_GRACE_HOURS,
    async (scopeId) => {
      const deleted = await database.query<{ id: string }>(
        `delete from snapshots where id = $1
         and not exists (select 1 from analysis_runs where snapshot_id = $1)
         returning id`,
        [scopeId],
      );
      if ((deleted.rowCount ?? 0) === 0) return false;
      await database.query(
        `delete from snapshot_requests request
         where not exists (select 1 from snapshots where request_id = request.id)
           and request.created_at < clock_timestamp() - make_interval(days => $1)`,
        [config.RETENTION_REPORT_DAYS],
      );
      return true;
    },
  );

  const events = await database.query<{ id: string }>(
    `with candidates as (
       select id from event_log
       where created_at < clock_timestamp() - make_interval(hours => $1)
       order by id limit $2
     )
     delete from event_log event using candidates candidate
     where event.id = candidate.id returning event.id::text`,
    [config.RETENTION_EVENT_LOG_HOURS, config.RETENTION_BATCH_SIZE],
  );

  return {
    chatsDeleted: chats.rowCount ?? 0,
    analyses: analysisCleanup,
    snapshots: snapshotCleanup,
    eventsDeleted: events.rowCount ?? 0,
  };
}

async function cleanupScopes(
  database: DatabaseClient,
  store: FilesystemArtifactStore,
  scopeType: 'analysis' | 'snapshot',
  scopeIds: string[],
  graceHours: number,
  deleteScope: (scopeId: string) => Promise<boolean>,
) {
  const counts = { claimed: 0, deferred: 0, deleted: 0, failed: 0 };
  for (const scopeId of scopeIds) {
    const artifacts = await database.query<ArtifactRow>(
      `select id, scope_id, locator, checksum, state, delete_after
       from artifacts where scope_type = $1 and scope_id = $2 order by id`,
      [scopeType, scopeId],
    );
    const unclaimed = artifacts.rows.filter((artifact) => artifact.state === 'available');
    if (unclaimed.length > 0 && graceHours > 0) {
      await database.query(
        `update artifacts set state = 'deleting',
           delete_after = clock_timestamp() + make_interval(hours => $2), last_error = null
         where scope_type = $1 and scope_id = $3 and state = 'available'`,
        [scopeType, graceHours, scopeId],
      );
      counts.claimed += 1;
      continue;
    }
    if (
      artifacts.rows.some(
        (artifact) =>
          artifact.state === 'deleting' &&
          artifact.delete_after &&
          artifact.delete_after.getTime() > Date.now(),
      )
    ) {
      counts.deferred += 1;
      continue;
    }

    const deletedArtifacts: string[] = [];
    let physicalDeleteStarted = false;
    try {
      await database.query('begin');
      if (!(await deleteScope(scopeId))) {
        await database.query('rollback');
        counts.deferred += 1;
        continue;
      }
      for (const artifact of artifacts.rows) {
        physicalDeleteStarted = true;
        await store.delete(artifact.locator);
        deletedArtifacts.push(artifact.id);
      }
      if (deletedArtifacts.length > 0) {
        await database.query('delete from artifacts where id = any($1::uuid[])', [
          deletedArtifacts,
        ]);
      }
      await database.query('commit');
      counts.deleted += 1;
    } catch (error) {
      await database.query('rollback').catch(() => undefined);
      if (physicalDeleteStarted) {
        await database.query(
          `update artifacts set state = 'unavailable', last_error = $2
           where scope_type = $1 and scope_id = $3`,
          [
            scopeType,
            error instanceof Error ? error.message.slice(0, 500) : 'Artifact deletion failed',
            scopeId,
          ],
        );
      }
      counts.failed += 1;
    }
  }
  return counts;
}

async function reconcileArtifacts(
  database: DatabaseClient,
  store: FilesystemArtifactStore,
  config: AppConfig,
) {
  const rows = await database.query<ArtifactRow>(
    `select id, scope_id, locator, checksum, state, delete_after
     from artifacts where state <> 'deleting' order by committed_at, id limit $1`,
    [config.RETENTION_BATCH_SIZE],
  );
  let verified = 0;
  let unavailable = 0;
  for (const artifact of rows.rows) {
    const inspection = await store.inspect(artifact.locator);
    const valid = inspection.exists && inspection.checksum === artifact.checksum;
    await database.query(
      `update artifacts set state = $2, last_verified_at = clock_timestamp(),
       last_error = $3 where id = $1`,
      [
        artifact.id,
        valid ? 'available' : 'unavailable',
        valid ? null : inspection.exists ? 'Artifact checksum mismatch' : 'Artifact file missing',
      ],
    );
    if (valid) verified += 1;
    else unavailable += 1;
  }

  const databaseLocators = await database.query<{ locator: string }>(
    'select locator from artifacts',
  );
  const referenced = new Set(databaseLocators.rows.map((row) => row.locator));
  const cutoff = Date.now() - config.RETENTION_ORPHAN_GRACE_HOURS * 60 * 60 * 1_000;
  const orphanCandidates = (await store.list())
    .filter(
      (artifact) => !referenced.has(artifact.locator) && artifact.modifiedAt.getTime() < cutoff,
    )
    .slice(0, config.RETENTION_BATCH_SIZE);
  for (const artifact of orphanCandidates) await store.delete(artifact.locator);

  return {
    artifactsVerified: verified,
    artifactsUnavailable: unavailable,
    orphanFilesDeleted: orphanCandidates.length,
  };
}

async function cleanupExpiredWorkspaces(root: string): Promise<number> {
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  const expired = entries.filter(
    (entry) => entry.isDirectory() && entry.name.startsWith('expired-'),
  );
  await Promise.all(
    expired.map((entry) => rm(`${root}/${entry.name}`, { recursive: true, force: true })),
  );
  return expired.length;
}

function waitForSignal(close: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const shutdown = () => {
      void close().then(resolve, reject);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });
}
