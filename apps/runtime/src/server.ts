import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import { FilesystemArtifactStore } from '@gcr/artifact-store';
import Fastify from 'fastify';
import { errorEnvelope, schemaVersion } from '@gcr/contracts';
import { createDatabase, pingDatabase, type Database } from '@gcr/db';
import { registerAuthentication } from './auth/index.js';
import type { AppConfig } from './config.js';
import { EventHub } from './events/index.js';
import { registerSnapshotRoutes } from './routes/snapshots.js';
import { registerAnalysisRoutes } from './routes/analyses.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerWorklistRoutes } from './routes/worklist.js';
import {
  createGitHubReader,
  ensureFixtureRepository,
  pollRepository,
  startPollScheduler,
} from './services/repositories.js';

const securityHeaders = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

export async function buildServer(config: AppConfig) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers.set-cookie',
          '*.token',
          '*.privateKey',
        ],
        censor: '[REDACTED]',
      },
    },
    requestIdHeader: 'x-request-id',
    trustProxy: config.TRUST_PROXY,
  });
  const database = createDatabase(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  const github = await createGitHubReader(config);
  const artifacts = new FilesystemArtifactStore(config.ARTIFACT_ROOT);
  const eventHub = new EventHub(database);
  await eventHub.start();

  app.addHook('onRequest', async (_request, reply) => {
    for (const [name, value] of Object.entries(securityHeaders)) {
      void reply.header(name, value);
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    if (
      config.NODE_ENV === 'production' &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      !sameOrigin(request)
    ) {
      return reply
        .code(403)
        .send(errorEnvelope('INVALID_ORIGIN', '허용되지 않은 요청입니다.', request.id));
    }
  });

  await registerAuthentication(app, config, database);
  await registerWorklistRoutes(app, database);
  await registerSnapshotRoutes(app, database, eventHub, artifacts);
  await registerAnalysisRoutes(app, database, eventHub, artifacts, config);
  await registerChatRoutes(app, database, eventHub, artifacts, config);

  app.get('/health/startup', async () => ({ status: 'ok', schemaVersion }));
  app.get('/health/live', async () => ({ status: 'ok', schemaVersion }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      const latencyMs = await pingDatabase(database);
      return { status: 'ok', schemaVersion, database: { status: 'ok', latencyMs } };
    } catch {
      return reply.code(503).send({ status: 'degraded', schemaVersion });
    }
  });
  app.get('/health/dependencies', async () => dependencyHealth(database, config));
  app.get('/api/v1/system', async () => ({
    schemaVersion,
    service: 'git-code-reviewer',
    version: process.env.APP_VERSION ?? 'development',
    authMode: config.AUTH_MODE,
  }));

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'request failed');
    const statusCode =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400
        ? error.statusCode
        : 500;
    void reply
      .code(statusCode)
      .send(errorEnvelope('INTERNAL_ERROR', '요청을 처리하지 못했습니다.', request.id, false));
  });

  const hasWebAssets = await access(path.join(config.WEB_DIST, 'index.html'))
    .then(() => true)
    .catch(() => false);

  if (hasWebAssets) {
    const indexHtml = await readFile(path.join(config.WEB_DIST, 'index.html'), 'utf8');
    await app.register(fastifyStatic, {
      root: config.WEB_DIST,
      wildcard: false,
      index: false,
      immutable: true,
      maxAge: '1y',
    });
    app.get('/', async (_request, reply) =>
      reply.header('cache-control', 'no-cache').type('text/html').send(indexHtml),
    );
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/health/')) {
        return reply
          .code(404)
          .send(errorEnvelope('RESOURCE_NOT_FOUND', '리소스를 찾을 수 없습니다.', request.id));
      }
      return reply.header('cache-control', 'no-cache').type('text/html').send(indexHtml);
    });
  } else {
    app.get('/', async (_request, reply) =>
      reply
        .type('text/plain')
        .send('Git Code Reviewer server is running. Start the Vite client on :5173.'),
    );
  }

  if (config.GITHUB_MODE === 'fixture' && github) {
    await ensureFixtureRepository(database);
    const fixtureRepository = await database.query<{ id: string }>(
      `select r.id from repositories r join github_instances i on i.id = r.instance_id
       where i.api_base_url = 'https://github.example.internal/api/v3/' and r.github_id = 101`,
    );
    if (fixtureRepository.rows[0])
      await pollRepository(database, github, fixtureRepository.rows[0].id);
  }
  const stopScheduler = await startPollScheduler(database, github, app.log);

  app.addHook('onClose', async () => {
    await stopScheduler();
    await eventHub.close();
    await database.end();
  });
  return app;
}

async function dependencyHealth(database: Database, config: AppConfig) {
  try {
    const latencyMs = await pingDatabase(database);
    return {
      schemaVersion,
      status: 'ok',
      dependencies: {
        database: { status: 'ok', latencyMs },
        github: {
          status: config.GITHUB_MODE === 'disabled' ? 'disabled' : 'ok',
          latencyMs: null,
        },
        model: {
          status: config.MODEL_MODE === 'disabled' ? 'disabled' : 'ok',
          latencyMs: null,
        },
      },
    };
  } catch {
    return {
      schemaVersion,
      status: 'degraded',
      dependencies: {
        database: { status: 'degraded', latencyMs: null, message: 'Database unavailable' },
        github: { status: 'disabled', latencyMs: null },
        model: { status: 'disabled', latencyMs: null },
      },
    };
  }
}

function sameOrigin(request: import('fastify').FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    const forwardedHost = request.headers['x-forwarded-host'];
    const expectedHost = typeof forwardedHost === 'string' ? forwardedHost : request.headers.host;
    return parsed.host === expectedHost && ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}
