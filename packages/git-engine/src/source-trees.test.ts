import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { materializeGitSnapshot, materializeFixtureSnapshot } from './index.js';

it('records actual Git trees fetched over verified HTTPS and leaves fixture trees unknown', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gcr-ci-trees-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
  let server: ReturnType<typeof createServer> | undefined;
  try {
    git('init', '--quiet');
    await writeFile(path.join(dir, 'a.ts'), 'export const n = 1;\n');
    git('add', 'a.ts');
    git(
      '-c',
      'user.name=Owned',
      '-c',
      'user.email=owned@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--quiet',
      '-m',
      'owned base',
    );
    const base = git('rev-parse', 'HEAD'),
      baseTree = git('rev-parse', 'HEAD^{tree}');
    await writeFile(path.join(dir, 'a.ts'), 'export const n = 2;\n');
    git('add', 'a.ts');
    git(
      '-c',
      'user.name=Owned',
      '-c',
      'user.email=owned@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--quiet',
      '-m',
      'owned head',
    );
    const head = git('rev-parse', 'HEAD'),
      headTree = git('rev-parse', 'HEAD^{tree}');
    await mkdir(path.join(dir, 'repos'));
    git('clone', '--quiet', '--bare', dir, path.join(dir, 'repos/owned.git'));
    await writeFile(
      path.join(dir, 'cert.cnf'),
      '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature,keyEncipherment\n',
    );
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        path.join(dir, 'key.pem'),
        '-out',
        path.join(dir, 'cert.pem'),
        '-config',
        path.join(dir, 'cert.cnf'),
      ],
      { stdio: 'pipe' },
    );
    server = createServer(
      {
        key: await readFile(path.join(dir, 'key.pem')),
        cert: await readFile(path.join(dir, 'cert.pem')),
      },
      (req, res) => {
        const url = new URL(req.url!, 'https://127.0.0.1');
        const child = spawn('git', ['http-backend'], {
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: dir,
            GIT_HTTP_EXPORT_ALL: '1',
            REQUEST_METHOD: req.method!,
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            CONTENT_TYPE: req.headers['content-type'] ?? '',
            HTTP_GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
          },
        });
        const parts: Buffer[] = [];
        child.stdout.on('data', (part) => parts.push(part));
        child.stderr.resume();
        req.pipe(child.stdin);
        child.on('close', (code) => {
          if (code) {
            res.writeHead(500);
            res.end();
            return;
          }
          const bytes = Buffer.concat(parts),
            end = bytes.indexOf('\r\n\r\n');
          if (end < 0) {
            res.writeHead(502);
            res.end();
            return;
          }
          for (const line of bytes.subarray(0, end).toString().split('\r\n')) {
            const colon = line.indexOf(':');
            const name = line.slice(0, colon),
              value = line.slice(colon + 1).trim();
            if (name.toLowerCase() === 'status') res.statusCode = Number(value.split(' ')[0]);
            else res.setHeader(name, value);
          }
          res.end(bytes.subarray(end + 4));
        });
      },
    );
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('loopback required');
    vi.stubEnv('GIT_SSL_CAINFO', path.join(dir, 'cert.pem'));
    const snapshot = await materializeGitSnapshot({
      workspace: path.join(dir, 'captured'),
      webBaseUrl: `https://127.0.0.1:${address.port}`,
      owner: 'repos',
      repository: 'owned',
      pullNumber: 1,
      baseSha: base,
      headSha: head,
      credential: { username: 'owned', password: 'synthetic' },
    });
    expect(snapshot.resolution).toBe('exact');
    expect(snapshot.trees).toEqual({ base: baseTree, head: headTree, mergeBase: baseTree });
    expect(snapshot.patch).toContain('+export const n = 2;');
    expect(materializeFixtureSnapshot(base, head).trees).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
