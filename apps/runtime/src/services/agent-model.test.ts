import { describe, expect, it } from 'vitest';
import { readAgentStream } from './agent-model.js';

const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
describe('agent provider stream', () => {
  it('delivers actual deltas before stream completion and preserves tool call identity', async () => {
    const deltas: string[] = [];
    const result = await readAgentStream(
      new Response(
        frame({ type: 'response.output_text.delta', delta: '조회합니다.' }) +
          frame({
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              call_id: 'call-1',
              name: 'read_file',
              arguments: '{"path":"a.ts"}',
            },
          }) +
          frame({ type: 'response.completed' }),
      ),
      async (delta) => {
        deltas.push(delta);
      },
    );
    expect(deltas).toEqual(['조회합니다.']);
    expect(result.calls).toEqual([
      { call_id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' },
    ]);
  });
  it('rejects truncated output rather than fabricating completion', async () => {
    await expect(
      readAgentStream(
        new Response(frame({ type: 'response.output_text.delta', delta: 'partial' })),
        async () => undefined,
      ),
    ).rejects.toThrow('model_stream_interrupted');
  });
  it('does not expose reasoning as assistant text', async () => {
    const deltas: string[] = [];
    await readAgentStream(
      new Response(
        frame({ type: 'response.reasoning_summary_text.delta', delta: 'hidden' }) +
          frame({ type: 'response.output_text.delta', delta: '답변' }) +
          frame({ type: 'response.completed' }),
      ),
      async (delta) => {
        deltas.push(delta);
      },
    );
    expect(deltas).toEqual(['답변']);
  });
});
