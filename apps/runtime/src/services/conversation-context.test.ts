import { describe, expect, it } from 'vitest';
import { compactAgentMessages, compactConversation } from './conversation-context.js';

describe('source-addressable conversation compaction', () => {
  it('preserves every message identity and role while disclosing omitted text', () => {
    const entries = Array.from({ length: 400 }, (_, index) => ({
      id: String(index),
      role: index % 2 ? 'assistant' : 'user',
      runId: index % 2 ? `run-${index}` : null,
      content: '사용자 판단과 미해결 질문 '.repeat(400),
    }));
    const context = compactConversation(entries);
    expect(context.entries.length + context.recent.length).toBe(400);
    expect(context.entries[0]).toMatchObject({ messageId: '0', role: 'user' });
    expect(context.entries.every((item) => item.omittedCharacters > 0)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThan(150000);
  });
  it('keeps source provenance, paired calls, current question and recent results', () => {
    const messages: Record<string, unknown>[] = [
      { role: 'user', content: '집단 메모리 우선; 사용자 질문' },
      { type: 'function_call', call_id: 'call', name: 'read_file' },
      {
        type: 'function_call_output',
        call_id: 'call',
        output: JSON.stringify({
          id: 'source',
          sha: 'a'.repeat(40),
          path: 'src/a.ts',
          content: '가'.repeat(100000),
        }),
      },
      ...Array.from({ length: 4 }, () => ({ role: 'user', content: '최근 판단' })),
    ];
    expect(compactAgentMessages(messages)).toBe(1);
    expect(messages[0]?.content).toContain('집단 메모리');
    expect(JSON.parse(String(messages[2]?.output))).toMatchObject({
      id: 'source',
      sha: 'a'.repeat(40),
      compacted: true,
    });
    expect(messages[1]?.call_id).toBe(messages[2]?.call_id);
    expect(messages.at(-1)?.content).toBe('최근 판단');
  });
});
