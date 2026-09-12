import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import type { FixedSourceToolName, FixedSourceToolPort } from '@gcr/client-contract';

export const fixedSourceTools = [
  {
    name: 'list_files',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'List up to 100 authorized files from the immutable source/base snapshot. Follow nextOffset for more files. This is not the live repository.',
    inputSchema: {
      type: 'object',
      properties: {
        offset: { type: 'integer', minimum: 0, maximum: 10000 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Read numbered lines from an authorized fixed source or base file, with its SHA-256. Maximum 200 lines per read. Check truncation; a location is not defect evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        side: { type: 'string', enum: ['source', 'base'] },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_code',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Search literal text only within authorized fixed files. Returns at most 100 matches, not a semantic call graph or proof of absence outside this scope.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 300 },
        side: { type: 'string', enum: ['source', 'base'] },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
] as const;

/** A process-owned loopback MCP transport. No files, credentials, external URLs or
 * arbitrary MCP servers are accepted. The random bearer is passed to Codex by env. */
export async function startSourceBridge(port: FixedSourceToolPort) {
  const token = randomBytes(32).toString('hex');
  const authorization = Buffer.from(`Bearer ${token}`);
  const sockets = new Set<Socket>();
  let host = '';
  let requestCount = 0;
  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (
      req.headers.host !== host ||
      req.headers.origin !== undefined ||
      supplied.length !== authorization.length ||
      !timingSafeEqual(supplied, authorization)
    ) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(405).end();
      return;
    }
    if (++requestCount > 5000) {
      res.writeHead(429).end();
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 65_536) {
          res.writeHead(413).end();
          req.destroy();
          return;
        }
        chunks.push(buffer);
      }
      const call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (!call || Array.isArray(call) || call.jsonrpc !== '2.0' || typeof call.method !== 'string')
        throw Error('invalid');
      const id = call.id;
      if (id === undefined && call.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }
      if (
        !(typeof id === 'number' && Number.isSafeInteger(id)) &&
        !(typeof id === 'string' && id.length <= 128)
      )
        throw Error('invalid');
      let result: unknown;
      let error: { code: number; message: string } | undefined;
      const params = call.params as Record<string, unknown> | undefined;
      switch (call.method) {
        case 'initialize':
          result = {
            protocolVersion:
              typeof params?.protocolVersion === 'string' &&
              ['2024-11-05', '2025-03-26', '2025-06-18', '2026-07-28'].includes(
                params.protocolVersion,
              )
                ? params.protocolVersion
                : '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'gcr-fixed-source', version: '1' },
          };
          break;
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = { tools: fixedSourceTools };
          break;
        case 'resources/list':
          result = { resources: [] };
          break;
        case 'resources/templates/list':
          result = { resourceTemplates: [] };
          break;
        case 'tools/call': {
          const name = params?.name;
          if (!fixedSourceTools.some((tool) => tool.name === name)) {
            error = { code: -32602, message: 'Unknown source tool.' };
            break;
          }
          try {
            const text = await port.execute(name as FixedSourceToolName, params?.arguments ?? {});
            if (typeof text !== 'string' || Buffer.byteLength(text) > 1_048_576)
              throw Error('output');
            result = { content: [{ type: 'text', text }], isError: false };
          } catch {
            result = {
              content: [
                {
                  type: 'text',
                  text: 'Source request unavailable or outside the approved scope/budget.',
                },
              ],
              isError: true,
            };
          }
          break;
        }
        default:
          error = { code: -32601, message: 'Method unavailable.' };
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }));
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5000;
  server.maxConnections = 16;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('bridge-unavailable');
  host = `127.0.0.1:${address.port}`;
  return {
    url: `http://${host}/mcp`,
    token,
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
