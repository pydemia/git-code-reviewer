import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createMcpSession, serveMcpStdio } from './mcp.js';
let root: string, repo: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcr-mcp-test-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
type Message = {
  id?: number;
  result?: {
    tools?: Array<{ name: string }>;
    protocolVersion?: string;
    isError?: boolean;
    structuredContent?: unknown;
  };
  error?: { code: number };
};
async function initialize(
  session: ReturnType<typeof createMcpSession>,
  send: (v: unknown) => Promise<void>,
  version = '2025-11-25',
) {
  await session.receive(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: version,
        clientInfo: { name: 'fixture', version: '1' },
        capabilities: {},
      },
    },
    send,
  );
  await session.receive({ jsonrpc: '2.0', method: 'notifications/initialized' }, send);
}
it('negotiates versions, advertises startup capabilities and rejects mutable roots and unapproved tools', async () => {
  const calls: string[][] = [],
    messages: Message[] = [];
  const session = createMcpSession(['--cwd', repo], {}, async (args) => {
    calls.push(args);
    return { value: { status: 'ready' }, exitCode: 0 };
  });
  const send = async (v: unknown) => {
    messages.push(v as Message);
  };
  await session.receive({ jsonrpc: '2.0', id: 0, method: 'tools/list' }, send);
  expect(messages.at(-1)?.error?.code).toBe(-32600);
  await initialize(session, send, '2024-11-05');
  expect(messages.at(-1)?.result?.protocolVersion).toBe('2024-11-05');
  await session.receive({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, send);
  const names = messages.at(-1)?.result?.tools?.map((t) => t.name);
  expect(names).toContain('gcr_prepare_review');
  expect(names).not.toContain('gcr_review_changes');
  expect(names).toContain('gcr_get_review_conversation');
  expect(names).toContain('gcr_read_conversation_source');
  expect(names).toContain('gcr_cancel_review_turn');
  expect(names).not.toContain('gcr_continue_review');
  expect(names).not.toContain('gcr_submit_feedback');
  for (const args of [
    { name: 'gcr_status', arguments: { cwd: '/tmp' } },
    { name: 'gcr_review_changes', arguments: { preparedId: 'x' } },
    { name: 'gcr_continue_review', arguments: { action: 'resume', runId: 'x', turnId: 't' } },
    { name: 'gcr_read_source', arguments: { preparedId: 'x', path: 'a', startLine: -1 } },
  ]) {
    await session.receive({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: args }, send);
    expect(messages.at(-1)?.error?.code).toBe(-32602);
  }
  expect(calls).toHaveLength(0);
  await session.receive(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'gcr_status', arguments: {} } },
    send,
  );
  await session.drain();
  expect(calls[0]).toEqual([
    'status',
    '--cwd',
    fs.realpathSync(repo),
    '--profile',
    'default',
    '--mode',
    'standalone',
  ]);
  session.close();
});
it('binds conversation actions to the startup model and validates each action before calling CLI', async () => {
  const messages: Message[] = [],
    calls: Array<{ args: string[]; body?: unknown }> = [];
  const session = createMcpSession(
    [
      '--cwd',
      repo,
      '--allow-review',
      '--executor-path',
      '/selected/codex',
      '--model',
      'gpt-6-astra',
      '--reasoning-effort',
      'xhigh',
      '--timeout-ms',
      '600000',
      '--source-bytes',
      '4096',
      '--tool-calls',
      '20',
    ],
    {},
    async (args, deps) => {
      calls.push({ args, body: deps?.readStdin ? JSON.parse(await deps.readStdin()) : undefined });
      return { value: { status: 'awaiting_input' }, exitCode: 1 };
    },
  );
  const send = async (value: unknown) => {
    messages.push(value as Message);
  };
  await initialize(session, send);
  for (const body of [
    { action: 'send', runId: 'r', turnId: 't', content: 'Explain.' },
    { action: 'answer', runId: 'r', turnId: 't', questionId: 'q', content: 'Yes' },
    { action: 'resume', runId: 'r', turnId: 't' },
  ]) {
    await session.receive(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'gcr_continue_review',
          arguments: body,
        },
      },
      send,
    );
    await session.drain();
    expect(messages.at(-1)?.result?.isError).toBe(false);
    const call = calls.at(-1)!;
    expect(call.args.slice(0, 5)).toEqual(['chat', body.action, 'r', '--input', '-']);
    expect(call.args).toContain('/selected/codex');
    expect(call.args).toContain('xhigh');
    expect(call.args).toContain('600000');
    expect(call.args).not.toContain('--source-bytes');
    expect(call.args).not.toContain('--tool-calls');
    const expected = Object.fromEntries(
      Object.entries(body).filter(([key]) => !['action', 'runId'].includes(key)),
    );
    expect(call.body).toEqual(expected);
  }
  for (const body of [
    { action: 'send', runId: 'r', turnId: 't' },
    { action: 'answer', runId: 'r', turnId: 't', content: 'Yes' },
    { action: 'resume', runId: 'r', turnId: 't', content: 'No implicit new message' },
    { action: 'send', runId: 'r', turnId: 't', content: 'Explain', model: 'other' },
  ]) {
    await session.receive(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'gcr_continue_review',
          arguments: body,
        },
      },
      send,
    );
    await session.drain();
    expect(messages.at(-1)?.error?.code).toBe(-32602);
  }
  expect(calls).toHaveLength(3);
  session.close();
});
it('handles a ping and cancellation while a model request runs, without restarting it', async () => {
  let calls = 0,
    started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  const messages: Message[] = [];
  const session = createMcpSession(['--cwd', repo, '--allow-review'], {}, async (_args, deps) => {
    calls++;
    started();
    await new Promise<void>((resolve) =>
      deps?.signal?.addEventListener('abort', () => resolve(), { once: true }),
    );
    return { value: { status: 'cancelled' }, exitCode: 2 };
  });
  const send = async (v: unknown) => {
    messages.push(v as Message);
  };
  await initialize(session, send);
  await session.receive(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'gcr_review_changes', arguments: { preparedId: 'prepared-id' } },
    },
    send,
  );
  await running;
  await session.receive({ jsonrpc: '2.0', id: 3, method: 'ping' }, send);
  expect(messages.at(-1)?.id).toBe(3);
  await session.receive({ jsonrpc: '2.0', id: 2, method: 'ping' }, send);
  expect(messages.at(-1)?.error?.code).toBe(-32600);
  await session.receive(
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } },
    send,
  );
  await session.drain();
  expect(messages.at(-1)).toMatchObject({
    id: 2,
    result: { isError: true, structuredContent: { value: { status: 'cancelled' }, exitCode: 2 } },
  });
  expect(calls).toBe(1);
  session.close();
});
it('does not expose submission tools or accept the old enable-submissions flag', async () => {
  expect(() => createMcpSession(['--cwd', repo, '--allow-submissions'])).toThrow();
  const messages: Message[] = [];
  let calls = 0;
  const session = createMcpSession(['--cwd', repo], {}, async () => {
    calls++;
    return { value: {}, exitCode: 0 };
  });
  const send = async (v: unknown) => {
    messages.push(v as Message);
  };
  await initialize(session, send);
  for (const name of ['gcr_submit_review', 'gcr_submit_feedback']) {
    await session.receive(
      { jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: {} } },
      send,
    );
    expect(messages.at(-1)?.error).toBeDefined();
  }
  expect(calls).toBe(0);
  session.close();
});
it('frames fragmented UTF-8 JSON, rejects malformed and unterminated messages and emits only JSON-RPC', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let text = '';
  output.on('data', (c) => (text += c.toString()));
  const serving = serveMcpStdio(['--cwd', repo], {}, input, output);
  input.write('{"jsonrpc":"2.0",');
  input.write('"id":1,"method":"ping"}\n');
  input.write('{bad}\n');
  input.end('{');
  await serving;
  const messages = text
    .trim()
    .split('\n')
    .map((x) => JSON.parse(x));
  expect(messages).toEqual([
    { jsonrpc: '2.0', id: 1, result: {} },
    { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid UTF-8 JSON.' } },
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'MCP messages must end with a newline.' },
    },
  ]);
});
