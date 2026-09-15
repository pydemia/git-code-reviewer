import { readFileSync } from 'node:fs';
import { createDatabase, type Database, type DatabaseConnectionOptions } from '@gcr/db';
import type { AppConfig } from './config.js';

export function runtimeDatabase(
  config: AppConfig,
  role: 'gcr_app' | 'gcr_migrator',
  max: number,
): Database {
  const options: DatabaseConnectionOptions = {};
  if (config.DATABASE_TLS_MODE === 'verify-full') {
    try {
      options.tlsCa = readFileSync(config.DATABASE_TLS_CA_FILE!, 'utf8').trim();
      if (!options.tlsCa) throw Error();
    } catch {
      throw Error('Invalid configuration: DATABASE_TLS_CA_FILE');
    }
  }
  if (config.DATABASE_ISOLATED_ROLES) options.expectedRole = role;
  const database = createDatabase(config.DATABASE_URL, max, options);
  // pg removes broken idle clients itself. Handle the pool event without dumping
  // the attached client, which can contain connection credentials.
  database.on('error', () => {
    process.stderr.write('{"level":"error","code":"DATABASE_IDLE_CONNECTION_LOST"}\n');
  });
  return database;
}

export async function openRuntimeDatabase(config: AppConfig, max: number): Promise<Database> {
  const database = runtimeDatabase(config, 'gcr_app', max);
  if (config.DATABASE_ISOLATED_ROLES) {
    try {
      await database.query('select 1');
    } catch (error) {
      await database.end();
      throw error;
    }
  }
  return database;
}
