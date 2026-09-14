import { expect, it, vi } from 'vitest';
import { startSourceBridge } from './source-bridge.js';

it('requires its ephemeral bearer and rejects browser origins before invoking any source port', async () => {
  const execute = vi.fn(async () => 'fixed');
  const bridge = await startSourceBridge({ execute });
  try {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'read_file', arguments: { path: 'api.py' } },
    });
    expect((await fetch(bridge.url, { method: 'POST', body })).status).toBe(403);
    expect(
      (
        await fetch(bridge.url, {
          method: 'POST',
          body,
          headers: { authorization: `Bearer ${bridge.token}`, origin: 'https://example.invalid' },
        })
      ).status,
    ).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await bridge.close();
  }
});
it('exposes fixed read tools, empty resources and no arbitrary tool or resource dispatch', async () => {
  const execute = vi.fn(async () => JSON.stringify({ text: 'fixed body' }));
  const bridge = await startSourceBridge({ execute });
  const call = async (method: string, params?: object) =>
    (
      await fetch(bridge.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
    ).json();
  try {
    expect(
      (await call('tools/list')).result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(['list_files', 'read_file', 'search_code']);
    expect((await call('resources/list')).result.resources).toEqual([]);
    expect((await call('resources/templates/list')).result.resourceTemplates).toEqual([]);
    expect((await call('resources/read', { uri: 'file:///private/secret' })).error.code).toBe(
      -32601,
    );
    expect(
      (await call('tools/call', { name: 'shell', arguments: { command: 'read secret' } })).error
        .code,
    ).toBe(-32602);
    const result = await call('tools/call', { name: 'read_file', arguments: { path: 'api.py' } });
    expect(result.result.isError).toBe(false);
    expect(execute).toHaveBeenCalledExactlyOnceWith('read_file', { path: 'api.py' });
    execute.mockRejectedValueOnce(Error('PRIVATE_CONTENT_FROM_DISK'));
    expect(
      JSON.stringify(
        await call('tools/call', { name: 'read_file', arguments: { path: 'denied.py' } }),
      ),
    ).not.toContain('PRIVATE_CONTENT_FROM_DISK');
  } finally {
    await bridge.close();
  }
});

it('advertises ask_user only with an explicit question port and validates arguments before dispatch', async () => {
  const askUser = vi.fn<(callId: string, argumentsValue: unknown) => Promise<string>>(
    async () => '{"status":"awaiting_input"}',
  );
  const bridge = await startSourceBridge(
    {
      async execute() {
        throw Error('not source');
      },
    },
    { askUser },
  );
  const call = async (method: string, params?: object) =>
    (
      await fetch(bridge.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'same-request', method, params }),
      })
    ).json();
  try {
    expect((await call('tools/list')).result.tools.map((t: { name: string }) => t.name)).toEqual([
      'list_files',
      'read_file',
      'search_code',
      'ask_user',
    ]);
    expect(
      (
        await call('tools/call', {
          name: 'ask_user',
          arguments: { question: 'Choose?', options: [], grant: 'all' },
        })
      ).result.isError,
    ).toBe(true);
    expect(askUser).not.toHaveBeenCalled();
    const params = { name: 'ask_user', arguments: { question: 'Choose?', options: ['Yes', 'No'] } };
    expect((await call('tools/call', params)).result.isError).toBe(false);
    await call('tools/call', params);
    expect(askUser.mock.calls[0]?.[0]).toBe(askUser.mock.calls[1]?.[0]);
  } finally {
    await bridge.close();
  }
});
