import { mkdir, readdir, rm } from 'node:fs/promises';
import Fastify from 'fastify';
import { createDatabase, runMigrations } from '@gcr/db';
import type { AppConfig } from './config.js';
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
  await mkdir(config.WORKSPACE_ROOT, { recursive: true });
  const health = Fastify({ logger: true });
  let loopHealthy = true;
  health.get('/health/live', async () => ({ status: 'ok' }));
  health.get('/health/ready', async (_request, reply) =>
    loopHealthy ? { status: 'ok' } : reply.code(503).send({ status: 'degraded' }),
  );
  await health.listen({ host: config.HOST, port: config.WORKER_HEALTH_PORT });

  const interval = setInterval(() => {
    loopHealthy = true;
  }, 5_000);
  await waitForSignal(async () => {
    loopHealthy = false;
    clearInterval(interval);
    await health.close();
  });
}

export async function retention(config: AppConfig, reconcile: boolean): Promise<void> {
  await mkdir(config.WORKSPACE_ROOT, { recursive: true });
  const entries = await readdir(config.WORKSPACE_ROOT, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('expired-'))
      .map((entry) =>
        rm(`${config.WORKSPACE_ROOT}/${entry.name}`, { recursive: true, force: true }),
      ),
  );
  process.stdout.write(reconcile ? 'Artifact reconciliation completed\n' : 'Retention completed\n');
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
