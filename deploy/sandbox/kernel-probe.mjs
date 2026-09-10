import { cp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const jail = '/sandbox/verify-jail';
const launcher = process.argv[2] ?? '/sandbox/launcher';
await rm(jail, { recursive: true, force: true });
await rm('/sandbox/fixture', { recursive: true, force: true });
await mkdir(jail, { recursive: true });
for (const location of ['/usr/local/bin/node', '/usr/lib', '/lib']) {
  const target = path.join(jail, location);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(location, target, { recursive: true, dereference: true });
}
await mkdir(path.join(jail, 'source'), { recursive: true });
await writeFile(path.join(jail, 'source', 'guard'), 'fixed', { mode: 0o444 });
await chmod(path.join(jail, 'source'), 0o555);
await writeFile('/sandbox/outside-sentinel', 'test-only');
await writeFile(
  path.join(jail, 'tool.mjs'),
  `import fs from 'node:fs';import net from 'node:net';const checks={uid:process.getuid(),secretAbsent:!process.env.DATABASE_URL};try{fs.writeFileSync('/source/guard','changed');checks.writeDenied=false;}catch{checks.writeDenied=true;}try{fs.readFileSync('/sandbox/outside-sentinel');checks.escapeDenied=false;}catch{checks.escapeDenied=true;}try{fs.readFileSync('/proc/1/environ');checks.processDenied=false;}catch{checks.processDenied=true;}const socket=net.createConnection({host:'1.1.1.1',port:80});socket.on('error',error=>{checks.networkDenied=error.code==='EPERM';console.log(JSON.stringify(checks));});socket.on('connect',()=>{socket.destroy();throw Error('Network escaped');});`,
  { mode: 0o444 },
);
const result = await promisify(execFile)(launcher, [jail], {
  env: { DATABASE_URL: 'synthetic-not-a-secret' },
  timeout: 30000,
});
const checks = JSON.parse(result.stdout);
if (
  checks.uid !== 65534 ||
  Object.entries(checks).some(([key, value]) => key !== 'uid' && value !== true)
)
  throw Error(result.stdout);
process.stdout.write(result.stdout);
if (process.argv[3]) {
  const execute = promisify(execFile);
  await mkdir('/sandbox/fixture', { recursive: true });
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Fixture'],
    ['config', 'user.email', 'fixture@example.invalid'],
  ])
    await execute('git', args, { cwd: '/sandbox/fixture' });
  await writeFile('/sandbox/fixture/unchanged.ts', 'export const retryCount = 3;\n');
  await execute('git', ['add', '.'], { cwd: '/sandbox/fixture' });
  await execute('git', ['commit', '-qm', 'fixture'], { cwd: '/sandbox/fixture' });
  const sha = (
    await execute('git', ['rev-parse', 'HEAD'], { cwd: '/sandbox/fixture' })
  ).stdout.trim();
  await execute('git', [
    'clone',
    '--bare',
    '/sandbox/fixture',
    path.join(jail, 'source/repository.git'),
  ]);
  for (const revision of ['head', 'base', 'mergeBase']) {
    await mkdir(path.join(jail, 'source/views', revision), { recursive: true });
    await writeFile(
      path.join(jail, 'source/views', revision, 'unchanged.ts'),
      'export const retryCount = 3;\n',
      { mode: 0o444 },
    );
  }
  await writeFile(
    path.join(jail, 'source/manifest.json'),
    JSON.stringify({ head: sha, base: sha, mergeBase: sha }),
  );
  await mkdir(path.join(jail, 'usr/bin'), { recursive: true });
  await cp('/usr/bin/git', path.join(jail, 'usr/bin/git'));
  await mkdir(path.join(jail, 'dev'), { recursive: true });
  await execute('/bin/mknod', ['-m', '666', path.join(jail, 'dev/null'), 'c', '1', '3']);
  await writeFile(path.join(jail, 'tool.mjs'), await readFile(process.argv[3]));
  await writeFile(
    path.join(jail, 'related-code.js'),
    await readFile(path.join(path.dirname(process.argv[3]), 'related-code.js')),
  );
  await writeFile(path.join(jail, 'package.json'), '{"type":"module"}');
  await mkdir(path.join(jail, 'node_modules/typescript/lib'), { recursive: true });
  for (const filename of ['package.json', 'lib/typescript.js'])
    await writeFile(
      path.join(jail, 'node_modules/typescript', filename),
      await readFile(
        path.join(path.dirname(process.argv[3]), '../node_modules/typescript', filename),
      ),
    );
  const child = execFile(launcher, [jail], { env: {}, timeout: 30000 });
  child.stdin.end(JSON.stringify({ name: 'read_file', revision: 'base', path: 'unchanged.ts' }));
  const source = await new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (errors += chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(JSON.parse(output)) : reject(Error(`${code}: ${output} ${errors}`)),
    );
  });
  if (source.sha !== sha || source.content !== 'export const retryCount = 3;\n')
    throw Error('Source mismatch');
  console.log(JSON.stringify({ sourceRead: true, revision: source.revision, blob: source.blob }));
  const relatedChild = execFile(launcher, [jail], { env: {}, timeout: 30000 });
  relatedChild.stdin.end(
    JSON.stringify({ name: 'find_related_code', revision: 'base', query: 'retryCount' }),
  );
  const related = await new Promise((resolve, reject) => {
    let output = '';
    relatedChild.stdout.on('data', (chunk) => (output += chunk));
    relatedChild.on('error', reject);
    relatedChild.on('close', (code) =>
      code === 0 ? resolve(JSON.parse(output)) : reject(Error(`related:${code}`)),
    );
  });
  if (
    !related.matches.some((item) => item.relation === 'definition' && item.symbol === 'retryCount')
  )
    throw Error('AST source match unavailable');
  console.log(JSON.stringify({ syntaxRead: true, coverage: related.coverage }));
}
