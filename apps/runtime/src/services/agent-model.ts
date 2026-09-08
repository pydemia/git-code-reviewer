export type AgentTool = {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
};
export type AgentCall = { call_id: string; name: string; arguments: string };
export type AgentTurnRequest = {
  cacheKey: string;
  instructions: string;
  input: Record<string, unknown>[];
  tools: AgentTool[];
  reasoningEffort: string;
  signal: AbortSignal;
  onDelta: (delta: string) => Promise<void>;
};
export type AgentTurnResult = {
  content: string;
  output: Record<string, unknown>[];
  calls: AgentCall[];
  usage: Record<string, unknown> | null;
};

export async function readAgentStream(
  response: Response,
  onDelta: AgentTurnRequest['onDelta'],
): Promise<AgentTurnResult> {
  if (!response.ok || !response.body) throw Error(`model_http_${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let completed = false;
  let output: Record<string, unknown>[] = [];
  let usage: Record<string, unknown> | null = null;
  let totalBytes = 0;
  async function consume(frame: string) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data) as {
      type: string;
      delta?: string;
      item?: Record<string, unknown>;
      response?: { output?: Record<string, unknown>[]; usage?: Record<string, unknown> };
    };
    if (event.type === 'response.output_text.delta' && event.delta) {
      content += event.delta;
      await onDelta(event.delta);
    }
    if (event.type === 'response.output_item.done' && event.item) output.push(event.item);
    if (event.type === 'response.completed') {
      completed = true;
      if (event.response?.output?.length) output = event.response.output;
      usage = event.response?.usage ?? null;
    }
    if (['response.failed', 'response.incomplete', 'error'].includes(event.type))
      throw Error('model_response_failed');
  }
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.length;
      if (totalBytes > 2097152) throw Error('model_output_limit');
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        await consume(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) await consume(buffer);
    if (!completed) throw Error('model_stream_interrupted');
    const calls = output
      .filter((item) => item.type === 'function_call')
      .map((item) => ({
        call_id: String(item.call_id),
        name: String(item.name),
        arguments: String(item.arguments),
      }));
    if (!content && !calls.length) throw Error('model_empty_response');
    return { content, output, calls, usage };
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
