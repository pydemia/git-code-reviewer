import { spawn, execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const sourceRoot = process.env.WORKSPACE_ROOT ?? '/tmp/git-code-reviewer/workspaces';
const socket = path.join(sourceRoot, 'sandbox.sock');
const jailRoot = '/sandbox';
const active = new Set();
const prepared = new Map();
const sourceLimit = Number(process.env.GIT_WORKSPACE_MAX_BYTES ?? 2147483648);
async function copyTree(source, target, follow, account) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    if (follow) await copyTree(await realpath(source), target, true, account);
    return;
  }
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(source))
      await copyTree(path.join(source, entry), path.join(target, entry), follow, account);
  } else if (info.isFile()) {
    account.bytes += info.size;
    if (account.bytes > account.limit) throw Error('workspace_size_limit');
    await mkdir(path.dirname(target), { recursive: true });
    await pipeline(
      createReadStream(source),
      createWriteStream(target, { mode: follow ? 0o555 : 0o444, flags: 'wx' }),
    );
  }
}
await mkdir(jailRoot, { recursive: true, mode: 0o700 });
await mkdir(sourceRoot, { recursive: true });
await rm(socket, { force: true });

async function protect(directory, jail) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await protect(target, jail);
    else if (entry.isFile())
      await chmod(target, target.startsWith(path.join(jail, 'source') + '/') ? 0o444 : 0o555);
  }
  await chmod(directory, 0o555);
}
async function prepare(id) {
  const source = path.join(sourceRoot, id);
  if ((await realpath(source)) !== source || !(await lstat(source)).isDirectory())
    throw Error('invalid_workspace');
  const jail = path.join(jailRoot, id);
  if (prepared.has(id)) return jail;
  for (const [cached] of [...prepared.entries()].sort((left, right) => left[1] - right[1])) {
    if (prepared.size < 3) break;
    if (!active.has(cached)) {
      prepared.delete(cached);
      await rm(path.join(jailRoot, cached), { recursive: true, force: true });
    }
  }
  await rm(jail, { recursive: true, force: true });
  let size = 0;
  await mkdir(jail, { recursive: true });
  for (const location of ['/usr/local/bin/node', '/usr/bin/git', '/usr/lib', '/lib']) {
    const target = path.join(jail, location);
    await mkdir(path.dirname(target), { recursive: true });
    await copyTree(location, target, true, { bytes: 0, limit: 536870912 });
  }
  await copyTree(
    '/app/packages/git-engine/dist/local-tools.js',
    path.join(jail, 'tool.mjs'),
    true,
    { bytes: 0, limit: 1048576 },
  );
  await copyTree(
    '/app/packages/git-engine/dist/related-code.js',
    path.join(jail, 'related-code.js'),
    true,
    { bytes: 0, limit: 1048576 },
  );
  await writeFile(path.join(jail, 'package.json'), '{"type":"module"}');
  const parserRoot = '/app/packages/git-engine/node_modules/typescript';
  for (const filename of ['package.json', 'lib/typescript.js'])
    await copyTree(
      path.join(parserRoot, filename),
      path.join(jail, 'node_modules/typescript', filename),
      true,
      { bytes: 0, limit: 16777216 },
    );
  await copyTree(source, path.join(jail, 'source'), false, { bytes: size, limit: sourceLimit });
  await mkdir(path.join(jail, 'dev'), { recursive: true });
  await new Promise((resolve, reject) =>
    execFile(
      '/bin/mknod',
      ['-m', '666', path.join(jail, 'dev/null'), 'c', '1', '3'],
      { env: {} },
      (error) => (error ? reject(error) : resolve()),
    ),
  );
  await protect(jail, jail);
  prepared.set(id, Date.now());
  return jail;
}
function execute(jail, input, response) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/local/bin/gcr-source-sandbox', [jail], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {},
      detached: true,
    });
    const stop = () => {
      if (child.pid)
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          return;
        }
    };
    const timeout = setTimeout(stop, 30000);
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 131072) stop();
    });
    child.stderr.resume();
    child.on('error', reject);
    response.once('close', () => {
      if (!response.writableEnded) stop();
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        console.error(JSON.stringify({ event: 'sandbox_tool_failed', exitCode: code }));
        reject(Error('sandbox_tool_failed'));
      } else resolve(output);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(input));
  });
}
const server = http.createServer(async (request, response) => {
  let id;
  let acquired = false;
  try {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 8192) throw Error('input_limit');
    }
    const input = JSON.parse(body);
    id = input.workspaceId;
    if (!/^[a-f0-9]{64}$/.test(id) || active.has(id) || active.size >= 2)
      throw Error('workspace_busy_or_invalid');
    active.add(id);
    acquired = true;
    const jail = await prepare(id);
    prepared.set(id, Date.now());
    const output = await execute(jail, input.tool, response);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(output);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'sandbox_request_failed',
        code: typeof error.code === 'string' ? error.code : 'sandbox_unavailable',
        operation: error.syscall ?? null,
        runtimePath:
          typeof error.path === 'string' && /^\/(usr|lib)\//.test(error.path)
            ? error.path
            : undefined,
      }),
    );
    response.writeHead(422, { 'content-type': 'application/json' });
    response.end('{"error":"sandbox_tool_unavailable"}');
  } finally {
    if (acquired) active.delete(id);
  }
});
server.listen(socket, async () => {
  await chmod(socket, 0o600);
  await chown(socket, 1000, 1000);
});
process.once('SIGTERM', () => {
  setTimeout(() => process.exit(0), 650000);
});
setInterval(async () => {
  for (const entry of await readdir(jailRoot)) {
    if (active.has(entry)) continue;
    const target = path.join(jailRoot, entry);
    const lastUsed = prepared.get(entry) ?? (await stat(target)).mtimeMs;
    if (Date.now() - lastUsed > 1800000) {
      prepared.delete(entry);
      await rm(target, { recursive: true, force: true });
    }
  }
}, 60000).unref();
