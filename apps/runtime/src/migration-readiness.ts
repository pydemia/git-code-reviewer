import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import path from 'node:path';
import type { Database } from '@gcr/db';

const transient = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  '57P03',
  '3D000',
  '28P01',
  '28000',
  '42P01',
]);

export async function waitForDatabaseState(
  timeoutMs: number,
  check: () => Promise<boolean>,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  do {
    try {
      if (await check()) return;
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      if (!transient.has(code)) throw error;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await setTimeout(Math.min(1000, remaining));
  } while (performance.now() < deadline);
  throw Error('Database readiness deadline exceeded');
}

export async function migrationReadiness(
  database: Database,
  directory: string,
): Promise<() => Promise<boolean>> {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  if (!files.length) throw Error('Migration directory is empty');
  const expected = await Promise.all(
    files.map(async (version) => ({
      version,
      checksum: createHash('sha256')
        .update(await readFile(path.join(directory, version)))
        .digest('hex'),
    })),
  );
  return async () => {
    const query = {
      text: 'select version,checksum from public.schema_migrations',
      query_timeout: 5000,
    };
    const applied = (await database.query<{ version: string; checksum: string }>(query)).rows;
    const byVersion = new Map(applied.map((row) => [row.version, row.checksum]));
    for (const row of expected) {
      const checksum = byVersion.get(row.version);
      if (checksum !== undefined && checksum !== row.checksum)
        throw Error(`Migration checksum changed after apply: ${row.version}`);
    }
    // Extra versions permit the older replica to restart during a compatible rolling upgrade.
    return expected.every((row) => byVersion.has(row.version));
  };
}
