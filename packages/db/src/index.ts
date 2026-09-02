import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const migrationLockId = 746_278_431;

export type Database = pg.Pool;

export function createDatabase(connectionString: string, max = 10): Database {
  return new Pool({
    connectionString,
    max,
    application_name: 'git-code-reviewer',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export async function pingDatabase(database: Database): Promise<number> {
  const startedAt = performance.now();
  await database.query('select 1');
  return Math.round(performance.now() - startedAt);
}

export async function runMigrations(
  database: Database,
  migrationsDirectory?: string,
): Promise<void> {
  const directory =
    migrationsDirectory ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  const client = await database.connect();

  try {
    await client.query('select pg_advisory_lock($1)', [migrationLockId]);
    await client.query(`
      create table if not exists schema_migrations (
        version text primary key,
        checksum text not null,
        applied_at timestamptz not null default clock_timestamp()
      )
    `);

    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(path.join(directory, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ checksum: string }>(
        'select checksum from schema_migrations where version = $1',
        [file],
      );

      if (existing.rowCount) {
        if (existing.rows[0]?.checksum !== checksum) {
          throw new Error(`Migration checksum changed after apply: ${file}`);
        }
        continue;
      }

      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations(version, checksum) values ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [migrationLockId]).catch(() => undefined);
    client.release();
  }
}
