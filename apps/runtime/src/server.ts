import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { errorEnvelope, schemaVersion } from '@gcr/contracts';
import { createDatabase, pingDatabase, type Database } from '@gcr/db';
import type { AppConfig } from './config.js';

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

  app.addHook('onRequest', async (_request, reply) => {
    for (const [name, value] of Object.entries(securityHeaders)) {
      void reply.header(name, value);
    }
  });

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
  app.get('/health/dependencies', async () => dependencyHealth(database));
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

  app.addHook('onClose', async () => database.end());
  return app;
}

async function dependencyHealth(database: Database) {
  try {
    const latencyMs = await pingDatabase(database);
    return {
      schemaVersion,
      status: 'ok',
      dependencies: {
        database: { status: 'ok', latencyMs },
        github: { status: 'disabled', latencyMs: null },
        model: { status: 'disabled', latencyMs: null },
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
