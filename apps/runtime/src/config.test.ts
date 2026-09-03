import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('constructs the database URL from a mounted password file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gcr-db-secret-'));
    const passwordFile = join(directory, 'password');
    writeFileSync(passwordFile, 'p@ss/word\n');
    try {
      const config = loadConfig({
        DATABASE_HOST: 'review-postgresql',
        DATABASE_PORT: '5432',
        DATABASE_NAME: 'git_code_reviewer',
        DATABASE_USER: 'git_code_reviewer',
        DATABASE_PASSWORD_FILE: passwordFile,
      });
      expect(config.DATABASE_URL).toBe(
        'postgresql://git_code_reviewer:p%40ss%2Fword@review-postgresql:5432/git_code_reviewer',
      );
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('does not expose a database password file path when it cannot be read', () => {
    const passwordFile = '/missing/private/database-password';
    expect(() =>
      loadConfig({
        DATABASE_HOST: 'review-postgresql',
        DATABASE_PORT: '5432',
        DATABASE_NAME: 'git_code_reviewer',
        DATABASE_USER: 'git_code_reviewer',
        DATABASE_PASSWORD_FILE: passwordFile,
      }),
    ).toThrow('Invalid configuration: DATABASE_PASSWORD_FILE');
    try {
      loadConfig({
        DATABASE_HOST: 'review-postgresql',
        DATABASE_PORT: '5432',
        DATABASE_NAME: 'git_code_reviewer',
        DATABASE_USER: 'git_code_reviewer',
        DATABASE_PASSWORD_FILE: passwordFile,
      });
    } catch (error) {
      expect(String(error)).not.toContain(passwordFile);
    }
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

  it('accepts ChatGPT account mode without an API key and requires its model', () => {
    expect(
      loadConfig({
        ...baseEnvironment,
        CHAT_MODEL_MODE: 'chatgpt-account',
        CHAT_MODEL_NAME: 'gpt-account-model',
      }).CHAT_MODEL_MODE,
    ).toBe('chatgpt-account');
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        CHAT_MODEL_MODE: 'chatgpt-account',
      }),
    ).toThrow('ChatGPT account model name is required');
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
