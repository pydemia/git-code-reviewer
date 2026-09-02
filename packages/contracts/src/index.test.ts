import { describe, expect, it } from 'vitest';
import { dependencyHealthSchema, errorEnvelope } from './index.js';

describe('API contracts', () => {
  it('builds the typed error envelope', () => {
    expect(errorEnvelope('NOT_READY', '아직 준비되지 않았습니다.', 'req_1', true)).toEqual({
      error: {
        code: 'NOT_READY',
        message: '아직 준비되지 않았습니다.',
        requestId: 'req_1',
        retryable: true,
      },
    });
  });

  it('accepts dependency health with disabled optional services', () => {
    expect(
      dependencyHealthSchema.parse({
        schemaVersion: 1,
        status: 'ok',
        dependencies: {
          database: { status: 'ok', latencyMs: 2 },
          github: { status: 'disabled', latencyMs: null },
        },
      }),
    ).toBeTruthy();
  });
});
