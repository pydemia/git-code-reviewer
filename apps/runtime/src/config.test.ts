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
});
