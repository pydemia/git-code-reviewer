import { describe, it, expect, vi } from 'vitest';
import type { Database } from '@gcr/db';
import type { FastifyRequest } from 'fastify';
import { knowledgeResponseObserver } from './knowledge-response-observation.js';
const request = () =>
  ({
    method: 'GET',
    routeOptions: { url: '/api/v1/repositories/:repoId/review-knowledge/manifest' },
    log: { warn: vi.fn() },
  }) as unknown as FastifyRequest;
describe('best-effort server response observation', () => {
  it('does not read or write a response without repository authorization', async () => {
    const connect = vi.fn();
    const observer = knowledgeResponseObserver({ connect } as unknown as Database);
    await observer.respond(request(), 401, 1);
    expect(connect).not.toHaveBeenCalled();
  });
  it('bounds concurrent writes and records a response at most once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const query = vi.fn(async () => ({})),
      free = vi.fn();
    const connect = vi.fn(async () => {
      await gate;
      return { query, release: free };
    });
    const observer = knowledgeResponseObserver({ connect } as unknown as Database),
      repo = '00000000-0000-4000-8000-000000000001';
    const promises = [];
    for (let i = 0; i < 16; i++) {
      const r = request();
      observer.authorize(r, repo);
      promises.push(observer.respond(r, 200, 10));
      await observer.respond(r, 200, 10);
    }
    const dropped = request();
    observer.authorize(dropped, repo);
    await observer.respond(dropped, 304, 1);
    expect(connect).toHaveBeenCalledTimes(16);
    expect(dropped.log.warn).toHaveBeenCalled();
    release();
    await Promise.all(promises);
    expect(free).toHaveBeenCalledTimes(16);
  });
  it('does not turn a telemetry storage failure into a failed client response', async () => {
    const query = vi.fn(async () => {
        throw Error('Synthetic DB failure');
      }),
      free = vi.fn();
    const observer = knowledgeResponseObserver({
        connect: async () => ({ query, release: free }),
      } as unknown as Database),
      r = request();
    observer.authorize(r, '00000000-0000-4000-8000-000000000001');
    await expect(observer.respond(r, 200, 0)).resolves.toBeUndefined();
    expect(r.log.warn).toHaveBeenCalled();
    expect(free).toHaveBeenCalledOnce();
  });
});
