import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import {
  reviewChatQuestionInput,
  type ReviewChatQuestionPort,
  type FixedSourceToolName,
  type FixedSourceToolPort,
} from '@gcr/client-contract';

export { fixedSourceTools } from '@gcr/client-contract';
import { fixedSourceTools } from '@gcr/client-contract';

export const reviewQuestionTool = {
  name: 'ask_user',
  description:
    'Persist one question requiring user intent and pause this conversation. Stop after calling. The host resumes with the saved answer in a new isolated step; no execution permission can be granted by an answer.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['question', 'options'],
    properties: {
      question: { type: 'string', minLength: 1, maxLength: 2000 },
      options: {
        type: 'array',
        maxItems: 6,
        items: { type: 'string', minLength: 1, maxLength: 300 },
      },
    },
  },
} as const;

/** A process-owned loopback MCP transport. No files, credentials, external URLs or
 * arbitrary MCP servers are accepted. The random bearer is passed to Codex by env. */
export async function startSourceBridge(
  port: FixedSourceToolPort,
  questions?: ReviewChatQuestionPort,
) {
  const token = randomBytes(32).toString('hex');
  const authorization = Buffer.from(`Bearer ${token}`);
  const tools = questions ? [...fixedSourceTools, reviewQuestionTool] : fixedSourceTools;
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
          result = { tools };
          break;
        case 'resources/list':
          result = { resources: [] };
          break;
        case 'resources/templates/list':
          result = { resourceTemplates: [] };
          break;
        case 'tools/call': {
          const name = params?.name;
          if (!tools.some((tool) => tool.name === name)) {
            error = { code: -32602, message: 'Unknown source tool.' };
            break;
          }
          try {
            const text =
              name === 'ask_user' && questions
                ? await questions.askUser(
                    createHash('sha256')
                      .update(JSON.stringify([token, id]))
                      .digest('hex'),
                    reviewChatQuestionInput(params?.arguments),
                  )
                : await port.execute(name as FixedSourceToolName, params?.arguments ?? {});
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
