import { describe, expect, it } from 'vitest';
import { createChatRunSchema, isTerminalChatRun, sourceEvidenceSchema } from './chat-run.js';

describe('interactive review contracts', () => {
  it('requires a client idempotency key and bounds question length', () => {
    expect(createChatRunSchema.safeParse({ content: 'Review' }).success).toBe(false);
    expect(
      createChatRunSchema.safeParse({
        idempotencyKey: 'cfc2f91c-bf0e-4cf5-b453-d5b9b078354e',
        content: 'x'.repeat(4001),
      }).success,
    ).toBe(false);
  });
  it('distinguishes resumable states from terminal results', () => {
    for (const status of [
      'queued',
      'running',
      'awaiting_input',
      'waiting_capacity',
      'cancelling',
    ] as const)
      expect(isTerminalChatRun(status)).toBe(false);
    for (const status of ['completed', 'partial', 'failed', 'cancelled'] as const)
      expect(isTerminalChatRun(status)).toBe(true);
  });
  it('does not accept a floating revision as code evidence', () => {
    expect(
      sourceEvidenceSchema.safeParse({
        id: 'unit',
        revision: 'head',
        sha: 'main',
        path: 'src/main.ts',
        startLine: 1,
        endLine: 2,
        blob: 'blob',
        hash: 'hash',
        content: 'text',
        truncated: false,
      }).success,
    ).toBe(false);
  });
});
