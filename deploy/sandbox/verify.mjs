import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = process.cwd();
const binary = process.argv[2];
if (!binary) throw Error('Pass the compiled Linux sandbox launcher path');
const image = process.argv[3] ?? 'pydemia/git-code-reviewer:0.8.0-alpha.17';
const temporary = await mkdtemp(path.join(os.tmpdir(), 'gcr-sandbox-verification-'));
const id = randomBytes(32).toString('hex');
const container = `gcr-sandbox-check-${id.slice(0, 10)}`;
const volume = `${container}-workspace`;
const workspace = path.join(temporary, 'workspaces', id);
async function command(program, args, options = {}) {
  return (await execute(program, args, { maxBuffer: 2097152, timeout: 120000, ...options })).stdout;
}
try {
  const initial = path.join(temporary, 'initial');
  await mkdir(initial, { recursive: true });
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Sandbox fixture'],
    ['config', 'user.email', 'fixture@example.invalid'],
  ])
    await command('git', args, { cwd: initial });
  await writeFile(path.join(initial, 'unchanged.ts'), 'export const retryCount = 3;\n');
  await command('git', ['add', '.'], { cwd: initial });
  await command('git', ['commit', '-qm', 'fixture'], { cwd: initial });
  const sha = (await command('git', ['rev-parse', 'HEAD'], { cwd: initial })).trim();
  await mkdir(workspace, { recursive: true });
  await command('git', ['clone', '--bare', '-q', initial, path.join(workspace, 'repository.git')]);
  for (const revision of ['head', 'base', 'mergeBase']) {
    await mkdir(path.join(workspace, 'views', revision), { recursive: true });
    await writeFile(
      path.join(workspace, 'views', revision, 'unchanged.ts'),
      'export const retryCount = 3;\n',
    );
  }
  await writeFile(
    path.join(workspace, 'manifest.json'),
    JSON.stringify({ base: sha, mergeBase: sha, head: sha }),
  );
  await command('docker', [
    'run',
    '-d',
    '--platform',
    'linux/amd64',
    '--name',
    container,
    '--user',
    '0:1000',
    '--cap-drop',
    'ALL',
    ...['SYS_CHROOT', 'SETUID', 'SETGID', 'CHOWN', 'DAC_OVERRIDE', 'KILL', 'MKNOD'].flatMap(
      (capability) => ['--cap-add', capability],
    ),
    '--security-opt',
    'no-new-privileges:true',
    '--read-only',
    '--network',
    'none',
    '--tmpfs',
    '/sandbox:size=1g',
    '-v',
    `${volume}:/tmp/git-code-reviewer/workspaces`,
    '-v',
    `${path.resolve(binary)}:/usr/local/bin/gcr-source-sandbox:ro`,
    '-v',
    `${root}/deploy/sandbox/broker.mjs:/app/sandbox/broker.mjs:ro`,
    '-v',
    `${root}/packages/git-engine/dist:/app/packages/git-engine/dist:ro`,
    '--entrypoint',
    'node',
    image,
    '/app/sandbox/broker.mjs',
  ]);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await command('docker', [
    'cp',
    workspace,
    `${container}:/tmp/git-code-reviewer/workspaces/${id}`,
  ]);
  const client = `const http=require('node:http');const req=http.request({socketPath:'/tmp/git-code-reviewer/workspaces/sandbox.sock',path:'/',method:'POST'},res=>{let body='';res.on('data',part=>body+=part);res.on('end',()=>{if(res.statusCode!==200)throw Error(body);const unit=JSON.parse(body);if(unit.content!=='export const retryCount = 3;\\n')throw Error('Source mismatch');console.log('Actual local Git/blob source verified');});});req.end(JSON.stringify({workspaceId:${JSON.stringify(id)},tool:{name:'read_file',revision:'base',path:'unchanged.ts'}}));`;
  process.stdout.write(
    await command('docker', ['exec', '--user', '1000:1000', container, 'node', '-e', client]),
  );
  const probe = `import fs from 'node:fs';import net from 'node:net';const results={uid:process.getuid(),secretAbsent:!process.env.DATABASE_URL};try{fs.writeFileSync('/source/unchanged.ts','changed');results.writeDenied=false;}catch{results.writeDenied=true;}try{fs.readFileSync('/sandbox/outside-sentinel');results.escapeDenied=false;}catch{results.escapeDenied=true;}try{fs.readFileSync('/proc/1/environ');results.processDenied=false;}catch{results.processDenied=true;}const socket=net.createConnection({host:'1.1.1.1',port:80});socket.on('error',error=>{results.networkDenied=error.code==='EPERM';console.log(JSON.stringify(results));});socket.on('connect',()=>{socket.destroy();throw Error('Network escaped');});`;
  const driver = `const fs=require('node:fs');const child=require('node:child_process');fs.writeFileSync('/sandbox/outside-sentinel','test-only');fs.writeFileSync('/sandbox/${id}/tool.mjs',${JSON.stringify(probe)});const result=child.execFileSync('/usr/local/bin/gcr-source-sandbox',['/sandbox/${id}'],{env:{DATABASE_URL:'synthetic-must-not-propagate'}}).toString();const checks=JSON.parse(result);if(checks.uid!==65534||!checks.secretAbsent||!checks.writeDenied||!checks.escapeDenied||!checks.processDenied||!checks.networkDenied)throw Error(result);console.log(result);`;
  process.stdout.write(await command('docker', ['exec', container, 'node', '-e', driver]));
} finally {
  const logs = await execute('docker', ['logs', container]).catch(() => ({
    stdout: '',
    stderr: '',
  }));
  process.stdout.write(logs.stdout);
  process.stderr.write(logs.stderr);
  await command('docker', ['rm', '-f', container]).catch(() => undefined);
  await command('docker', ['volume', 'rm', volume]).catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
}
