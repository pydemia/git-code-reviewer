import type { Database } from '@gcr/db';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { registerAccountRegistryRoutes } from './account-registry.js';

afterEach(() => vi.unstubAllGlobals());

describe('model discovery route', () => {
  it.each(['administrator', 'reviewer'] as const)(
    'allows only administrators (%s)',
    async (role) => {
      const query = vi.fn();
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          models: [
            {
              slug: 'model-from-api',
              supported_reasoning_levels: [{ effort: 'high' }],
              default_reasoning_level: 'high',
            },
          ],
        }),
      );
      vi.stubGlobal('fetch', fetcher);
      const app = Fastify();
      app.addHook('onRequest', async (request) => {
        request.user = {
          id: '8aff9bde-4c15-45b0-9fb2-65b70d2f98c2',
          subject: 'test',
          displayName: 'Test',
          role,
          enabled: true,
          groups: [],
          tenants: [],
        };
      });
      const config = loadConfig(
        {
          DATABASE_URL: 'postgresql://localhost/test',
          CREDENTIAL_REGISTRY_ENABLED: 'true',
          CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
        },
        'serve',
      );
      await registerAccountRegistryRoutes(app, { query } as unknown as Database, config);
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/chat-accounts/discover-models',
          payload: {
            authJson: JSON.stringify({
              auth_mode: 'chatgpt',
              tokens: { access_token: 'synthetic-secret' },
            }),
          },
        });
        expect(response.statusCode).toBe(role === 'administrator' ? 200 : 404);
        expect(response.body).not.toContain('synthetic-secret');
        expect(query).not.toHaveBeenCalled();
        if (role === 'administrator') {
          expect(response.headers['cache-control']).toBe('no-store');
          expect(response.json().items[0].id).toBe('model-from-api');
          const invalid = await app.inject({
            method: 'POST',
            url: '/api/v1/admin/chat-accounts/discover-models',
            payload: { authJson: '{}' },
          });
          expect(invalid.statusCode).toBe(400);
          expect(invalid.body).toContain('ChatGPT 로그인');
        } else expect(fetcher).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
});
