import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import { codexReviewArgs, CODEX_REVIEW_EFFORT, CODEX_REVIEW_MODEL } from './codex-config.js';
import { ExecutorError } from './process.js';
import { runIsolatedCodex } from './codex-isolation.js';
import { startSourceBridge } from './source-bridge.js';

export const expectedReviewTools = [
  'functions.list_mcp_resource_templates',
  'functions.list_mcp_resources',
  'functions.read_mcp_resource',
  'mcp__gcr_source.list_files',
  'mcp__gcr_source.read_file',
  'mcp__gcr_source.search_code',
].sort();

function catalogNames(request: Record<string, unknown>): string[] {
  const input = Array.isArray(request.input) ? request.input : [];
  const tools = [
    ...(Array.isArray(request.tools) ? request.tools : []),
    ...input.flatMap((item) => (Array.isArray(item?.tools) ? item.tools : [])),
  ];
  return tools
    .flatMap((tool) =>
      tool.type === 'namespace' && Array.isArray(tool.tools)
        ? tool.tools.map(
            (child: Record<string, unknown>) => `${String(tool.name)}.${String(child.name)}`,
          )
        : [`${String(tool.type)}.${String(tool.name)}`],
    )
    .sort();
}

/** Real executable, synthetic provider and empty auth home. No account request or
 * production source is sent. The probe observes the actual outbound tool catalog. */
export async function probeCodexCatalog(
  command: string,
  root: string,
  observe?: (result: {
    code: number;
    stderr: string;
    stdout: string;
    requestCount: number;
    invalidRequest: boolean;
    canaryLoaded: boolean;
    canarySources: string[];
    tools: string[];
  }) => void,
): Promise<string[]> {
  const canary = `DO_NOT_LOAD_${randomBytes(16).toString('hex')}`;
  for (const name of ['auth', 'cwd']) await mkdir(path.join(root, name), { mode: 0o700 });
  await writeFile(path.join(root, 'auth', 'AGENTS.md'), `${canary}_home`, { mode: 0o600 });
  await writeFile(path.join(root, 'cwd', 'AGENTS.md'), `${canary}_cwd`, { mode: 0o600 });
  const bridge = await startSourceBridge({
    async execute() {
      throw Error('Probe never provides source.');
    },
  });
  const requests: Array<Record<string, unknown>> = [];
  let invalidRequest = false;
  const sockets = new Set<Socket>();
  const server = createServer(async (req, res) => {
    try {
      const buffers: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 2_097_152) throw Error('probe-limit');
        buffers.push(buffer);
      }
      if (req.method !== 'POST' || req.url !== '/v1/responses' || requests.length)
        throw Error('probe-request');
      requests.push(JSON.parse(Buffer.concat(buffers).toString('utf8')));
    } catch {
      invalidRequest = true;
    }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { type: 'invalid_request_error', message: 'Synthetic catalog probe complete.' },
      }),
    );
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new ExecutorError('executor-unavailable');
    await writeFile(
      path.join(root, 'auth', 'config.toml'),
      `developer_instructions = ${JSON.stringify(`${canary}_config`)}\n[mcp_servers.unexpected]\nurl = "http://127.0.0.1:${address.port}/unexpected"\n`,
      { mode: 0o600 },
    );
    const args = codexReviewArgs(root, bridge.url);
    for (const [name, value] of Object.entries({
      model_provider: 'gcr_fixture',
      'model_providers.gcr_fixture.name': 'GCR synthetic catalog probe',
      'model_providers.gcr_fixture.base_url': `http://127.0.0.1:${address.port}/v1`,
      'model_providers.gcr_fixture.wire_api': 'responses',
      'model_providers.gcr_fixture.request_max_retries': 0,
      'model_providers.gcr_fixture.stream_max_retries': 0,
    }))
      args.push('-c', `${name}=${JSON.stringify(value)}`);
    args.push('-');
    const processResult = await runIsolatedCodex({
      command,
      args,
      cwd: path.join(root, 'cwd'),
      env: {
        PATH: '/usr/bin:/bin',
        HOME: path.join(root, 'auth'),
        CODEX_HOME: path.join(root, 'auth'),
        LANG: 'en_US.UTF-8',
        GCR_FIXED_SOURCE_TOKEN: bridge.token,
      },
      stdin: 'Synthetic tool catalog probe. No review or tools are requested.',
      timeoutMs: 30_000,
      outputBytes: 1_048_576,
    });
    const request = requests[0];
    observe?.({
      ...processResult,
      requestCount: requests.length,
      invalidRequest,
      canaryLoaded: !!request && JSON.stringify(request).includes(canary),
      canarySources: ['home', 'cwd', 'config'].filter((source) =>
        JSON.stringify(request).includes(`${canary}_${source}`),
      ),
      tools: request ? catalogNames(request) : [],
    });
    if (
      invalidRequest ||
      !request ||
      request.model !== CODEX_REVIEW_MODEL ||
      (request.reasoning as { effort?: unknown } | undefined)?.effort !== CODEX_REVIEW_EFFORT ||
      JSON.stringify(request).includes(canary)
    )
      throw new ExecutorError('executor-unavailable');
    const names = catalogNames(request);
    if (JSON.stringify(names) !== JSON.stringify(expectedReviewTools))
      throw new ExecutorError('executor-unavailable');
    return names;
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      bridge.close(),
      new Promise<void>((resolve) => server.close(() => resolve())),
    ]);
  }
}
