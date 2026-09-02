import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const baseEnvironment = {
  DATABASE_URL: 'postgresql://example.invalid/reviewer',
};

describe('loadConfig', () => {
  it('loads secure production-neutral defaults', () => {
    const config = loadConfig(baseEnvironment);
    expect(config.PORT).toBe(4000);
    expect(config.AUTH_MODE).toBe('development');
    expect(config.TRUST_PROXY).toBe(false);
    expect(config.WORKER_CONCURRENCY).toBe(2);
    expect(config.CHAT_CONCURRENCY_LIMIT).toBe(2);
  });

  it('rejects chat retention beyond report retention', () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        RETENTION_REPORT_DAYS: '10',
        RETENTION_CHAT_DAYS: '11',
      }),
    ).toThrow('RETENTION_CHAT_DAYS must not exceed RETENTION_REPORT_DAYS');
  });

  it('does not expose invalid values in its error', () => {
    expect(() => loadConfig({ DATABASE_URL: '' })).toThrow('Invalid configuration: DATABASE_URL');
  });

  it('requires OIDC settings only for the server command', () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, AUTH_MODE: 'oidc', SESSION_SECRET: 'x'.repeat(32) }),
    ).toThrow('OIDC settings are required');
    expect(
      loadConfig({ ...baseEnvironment, AUTH_MODE: 'oidc', GITHUB_MODE: 'app' }, 'migrate')
        .AUTH_MODE,
    ).toBe('oidc');
  });

  it('requires an explicit interactive chat model selection', () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        CHAT_MODEL_MODE: 'openai-compatible',
        CHAT_MODEL_ENDPOINT: 'https://models.example.test/v1/',
        CHAT_MODEL_API_KEY: 'secret',
      }),
    ).toThrow('Chat model endpoint, API key, and name are required');
  });

  it('requires an explicit batch analysis model selection', () => {
    expect(() =>
      loadConfig(
        {
          ...baseEnvironment,
          MODEL_MODE: 'openai-compatible',
          MODEL_ENDPOINT: 'https://models.example.test/v1/',
          MODEL_API_KEY: 'secret',
        },
        'worker',
      ),
    ).toThrow('model endpoint, API key, and name are required');
  });
});
