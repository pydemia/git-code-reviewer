import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import {
  AnalysisProviderConfigurationError,
  prepareAnalysisProvider,
  reusableProviderCredential,
  testAnalysisProvider,
  type AnalysisProviderRow,
} from './analysis-provider.js';

describe('analysis provider administration', () => {
  it('encrypts credentials and reuses them without returning plaintext', () => {
    const config = providerConfig();
    const prepared = prepareAnalysisProvider(
      {
        mode: 'openai-compatible',
        endpoint: 'https://models.example.test/v1',
        modelName: 'review-model',
        timeoutMs: 30_000,
        apiKey: 'provider-secret',
      },
      config,
    );

    expect(prepared.endpoint).toBe('https://models.example.test/v1/');
    expect(prepared.credentialCiphertext?.toString('utf8')).not.toContain('provider-secret');
    expect(reusableProviderCredential(providerRow(prepared), config)).toBe('provider-secret');
  });

  it('rejects endpoints outside the deployment allowlist', () => {
    expect(() =>
      prepareAnalysisProvider(
        {
          mode: 'openai-compatible',
          endpoint: 'https://metadata.example.invalid/v1/',
          modelName: 'review-model',
          timeoutMs: 30_000,
          apiKey: 'provider-secret',
        },
        providerConfig(),
      ),
    ).toThrow('허용되지 않은 Provider origin');
  });

  it('fails closed when the credential encryption key changes', () => {
    const config = providerConfig();
    const prepared = prepareAnalysisProvider(
      {
        mode: 'openai-compatible',
        endpoint: 'https://models.example.test/v1/',
        modelName: 'review-model',
        timeoutMs: 30_000,
        apiKey: 'provider-secret',
      },
      config,
    );
    const wrongKeyConfig = providerConfig(Buffer.alloc(32, 9).toString('base64'));

    expect(() => reusableProviderCredential(providerRow(prepared), wrongKeyConfig)).toThrow();
  });

  it('tests a provider without sending repository source or tenant prompts', async () => {
    let requestBody: Record<string, unknown> = {};
    let authorization = '';
    const latencyMs = await testAnalysisProvider(
      {
        source: 'administration',
        versionId: null,
        version: null,
        mode: 'openai-compatible',
        endpoint: 'https://models.example.test/v1/',
        modelName: 'review-model',
        timeoutMs: 30_000,
        apiKey: 'provider-secret',
        configurationHash: 'a'.repeat(64),
        profile: 'openai-compatible:review-model',
      },
      (async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        authorization = new Headers(init?.headers).get('authorization') ?? '';
        return Response.json({ choices: [{ message: { content: 'OK' } }] });
      }) as typeof fetch,
    );

    expect(latencyMs).toBeGreaterThanOrEqual(0);
    expect(authorization).toBe('Bearer provider-secret');
    expect(requestBody).toEqual({
      model: 'review-model',
      temperature: 0,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
    });
    expect(JSON.stringify(requestBody)).not.toContain('diff');
  });

  it('returns a safe error for provider HTTP failures', async () => {
    await expect(
      testAnalysisProvider(
        {
          source: 'administration',
          versionId: null,
          version: null,
          mode: 'openai-compatible',
          endpoint: 'https://models.example.test/v1/',
          modelName: 'review-model',
          timeoutMs: 30_000,
          apiKey: 'provider-secret',
          configurationHash: 'a'.repeat(64),
          profile: 'openai-compatible:review-model',
        },
        (async () => new Response('sensitive upstream body', { status: 404 })) as typeof fetch,
      ),
    ).rejects.toMatchObject<Partial<AnalysisProviderConfigurationError>>({
      message: 'Provider 연결 테스트가 HTTP 404로 실패했습니다.',
    });
  });
});

function providerConfig(encryptionKey = Buffer.alloc(32, 7).toString('base64')) {
  return loadConfig({
    DATABASE_URL: 'postgresql://example.invalid/reviewer',
    MODEL_ADMIN_ENABLED: 'true',
    MODEL_CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
    MODEL_PROVIDER_ALLOWED_ORIGINS: 'https://models.example.test',
  });
}

function providerRow(prepared: ReturnType<typeof prepareAnalysisProvider>): AnalysisProviderRow {
  return {
    id: 'd04309f7-2069-4927-8867-63793d76c04e',
    version: 1,
    ...prepared,
    active: true,
    createdBySubject: 'admin',
    createdByName: 'Administrator',
    activatedBySubject: 'admin',
    activatedByName: 'Administrator',
    activatedAt: '2026-09-03T00:00:00.000Z',
    createdAt: '2026-09-03T00:00:00.000Z',
  };
}
