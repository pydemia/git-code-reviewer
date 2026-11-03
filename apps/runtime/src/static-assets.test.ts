import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('static asset dependency security and Fastify compatibility', () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'gcr-static-'));
    await mkdir(path.join(directory, 'assets'));
    await mkdir(path.join(directory, 'private'));
    await writeFile(path.join(directory, 'assets', 'app.js'), 'synthetic-public-asset');
    await writeFile(path.join(directory, 'private', 'secret.txt'), 'synthetic-protected-file');
    await writeFile(path.join(directory, '.hidden'), 'synthetic-hidden-file');
  });
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('keeps production explicit asset routes, caching, HEAD and range responses', async () => {
    const app = Fastify();
    try {
      await app.register(fastifyStatic, {
        root: directory,
        wildcard: false,
        index: false,
        immutable: true,
        maxAge: '1y',
      });
      const response = await app.inject('/assets/app.js');
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('synthetic-public-asset');
      expect(response.headers['cache-control']).toContain('immutable');
      expect((await app.inject({ url: '/assets/app.js', method: 'HEAD' })).body).toBe('');
      const range = await app.inject({ url: '/assets/app.js', headers: { range: 'bytes=0-8' } });
      expect(range.statusCode).toBe(206);
      expect(range.body).toBe('synthetic');
      const unchanged = await app.inject({
        url: '/assets/app.js',
        headers: { 'if-none-match': response.headers.etag! },
      });
      expect(unchanged.statusCode).toBe(304);
      expect((await app.inject('/.hidden')).statusCode).toBe(404);
      expect((await app.inject('/assets/%2e%2e/.hidden')).statusCode).not.toBe(200);
    } finally {
      await app.close();
    }
  });

  it('rejects the advisory route-guard bypass inputs before serving a protected file', async () => {
    const app = Fastify();
    try {
      app.get(
        '/private/*',
        { preHandler: async (_request, reply) => reply.code(403).send('Denied') },
        async (_request, reply) => reply.sendFile('private/secret.txt'),
      );
      await app.register(fastifyStatic, { root: directory, index: false });
      expect((await app.inject('/assets/app.js')).statusCode).toBe(200);
      for (const url of [
        '/private/secret.txt',
        '/assets/../private/secret.txt',
        '/assets/%2E%2E/private/secret.txt',
        '/private%2fsecret.txt',
      ]) {
        const response = await app.inject(url);
        expect(response.statusCode, url).toBeGreaterThanOrEqual(400);
        expect(response.body, url).not.toContain('synthetic-protected-file');
      }
    } finally {
      await app.close();
    }
  });

  it('normalizes paths before allowedPath checks including repeated slashes and dot segments', async () => {
    const app = Fastify();
    try {
      await app.register(fastifyStatic, {
        root: directory,
        index: false,
        allowedPath: (pathname) => !pathname.startsWith('/private/'),
      });
      expect((await app.inject('/assets/app.js')).statusCode).toBe(200);
      for (const url of [
        '/private/secret.txt',
        '//private/secret.txt',
        '/./private/secret.txt',
        '/assets/../private/secret.txt',
      ]) {
        const response = await app.inject(url);
        expect(response.statusCode, url).toBeGreaterThanOrEqual(400);
        expect(response.body, url).not.toContain('synthetic-protected-file');
      }
    } finally {
      await app.close();
    }
  });
});
