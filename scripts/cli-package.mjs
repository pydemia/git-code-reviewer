import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
assert(
  args.every((arg) => ['--verify', '--reuse-clients'].includes(arg)),
  'Usage: pnpm pack:cli [--verify] [--reuse-clients]',
);
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const pnpmCli = process.env.npm_execpath;
const npmCli =
  process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    : undefined;
const run = (command, argv, cwd = root) => {
  const cli = command === 'pnpm' ? pnpmCli : command === 'npm' ? npmCli : undefined;
  if (process.platform === 'win32' && ['pnpm', 'npm'].includes(command))
    assert(cli, 'Run through the pinned pnpm package script');
  execFileSync(cli ? process.execPath : command, cli ? [cli, ...argv] : argv, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
  });
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cli = await json(join(root, 'apps/cli/package.json'));
const client = await json(join(root, 'packages/client-core/package.json'));
assert.equal(cli.name, '@gcr/cli');
assert.equal(cli.engines.node, '>=22.0.0');
if (args.includes('--reuse-clients')) run('pnpm', ['build:clients']);
else run(process.execPath, ['scripts/client-packages.mjs', ...args]);
await rm(join(root, 'apps/cli/dist'), { recursive: true, force: true });
run('pnpm', ['--filter', '@gcr/cli', 'build']);
await chmod(join(root, 'apps/cli/dist/main.js'), 0o755);
const clients = join(root, 'artifacts/client-packages', client.version);
const clientManifest = await json(join(clients, 'manifest.json'));
assert.equal(clientManifest.version, client.version);
assert.deepEqual(clientManifest.packages.map((entry) => entry.name).sort(), [
  '@gcr/client-contract',
  '@gcr/client-core',
  '@gcr/client-executors',
]);
for (const entry of clientManifest.packages) {
  assert.equal(entry.file, `gcr-${entry.name.slice(5)}-${entry.version}.tgz`);
  assert.equal(digest(await readFile(join(clients, entry.file))), entry.sha256);
  const packed = JSON.parse(
    execFileSync('tar', ['-xOzf', join(clients, entry.file), 'package/package.json'], {
      encoding: 'utf8',
    }),
  );
  const workspace = await json(join(root, 'packages', entry.name.slice(5), 'package.json'));
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ])
    if (workspace[field])
      for (const [name, version] of Object.entries(workspace[field]))
        if (version === 'workspace:*') {
          const dependency = clientManifest.packages.find((entry) => entry.name === name);
          assert(dependency, 'Unknown workspace dependency');
          workspace[field][name] = dependency.version;
        }
  assert.deepEqual(packed, workspace, 'Pinned client package metadata differs from the workspace');
}
const build = await json(join(root, 'apps/cli/dist/build-inputs.json'));
for (const output of Object.values(build.outputs))
  assert(
    output.imports.every((entry) => entry.external && entry.path.startsWith('node:')),
    'CLI bundle has a non-Node runtime import',
  );
for (const input of Object.keys(build.inputs)) {
  const absolute = resolve(root, 'apps/cli', input);
  if (absolute.startsWith(join(root, 'apps/cli/src') + sep)) {
    assert(!absolute.endsWith('.test.ts'));
    continue;
  }
  const entry = clientManifest.packages.find((entry) =>
    absolute.startsWith(join(root, 'packages', entry.name.slice(5), 'dist') + sep),
  );
  assert(entry, 'CLI bundle includes code outside its three client libraries');
  const relative = absolute
    .slice(join(root, 'packages', entry.name.slice(5)).length + 1)
    .split(sep)
    .join('/');
  assert.equal(
    digest(await readFile(absolute)),
    digest(execFileSync('tar', ['-xOzf', join(clients, entry.file), `package/${relative}`])),
    'Bundled library input differs from its pinned tarball',
  );
}
await rm(join(root, 'apps/cli/dist/build-inputs.json'));
await writeFile(
  join(root, 'apps/cli/dist/client-packages.json'),
  JSON.stringify(clientManifest, null, 2) + '\n',
);
if (process.platform === 'win32') {
  const core = clientManifest.packages.find((entry) => entry.name === '@gcr/client-core');
  for (const [source, target] of [
    ['dist/windows-native.exe', 'windows-native.exe'],
    ['dist/windows-native.json', 'windows-native.json'],
    ['native/windows/Native.cs', 'windows-native.cs'],
  ]) {
    const bytes = execFileSync('tar', ['-xOzf', join(clients, core.file), `package/${source}`]);
    await writeFile(join(root, 'apps/cli/dist', target), bytes);
  }
}
const skillFiles = ['SKILL.md', 'references/client-workflows.md'];
for (const file of skillFiles) {
  const target = join(root, 'apps/cli/dist/skills/gcr-prevention', file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(root, 'skills/gcr-prevention', file), target);
}
const output = join(root, 'artifacts/cli', cli.version);
await mkdir(dirname(output), { recursive: true });
const stage = await mkdtemp(join(dirname(output), '.pack-'));
try {
  for (const entry of clientManifest.packages) {
    assert.equal(digest(await readFile(join(clients, entry.file))), entry.sha256);
    await copyFile(join(clients, entry.file), join(stage, entry.file));
  }
  run('pnpm', ['pack', '--pack-destination', stage], join(root, 'apps/cli'));
  const file = `gcr-cli-${cli.version}.tgz`;
  const listing = execFileSync('tar', ['-tzf', join(stage, file)], { encoding: 'utf8' })
    .trim()
    .split('\n');
  assert(
    listing.every((entry) =>
      /^package\/(?:dist\/main\.js|dist\/windows-native\.(?:exe|json|cs)|dist\/client-packages\.json|dist\/skills\/gcr-prevention\/(?:SKILL\.md|references\/client-workflows\.md)|package\.json|LICENSE|NOTICE|README\.md)$/.test(
        entry.trim(),
      ),
    ),
    'Unexpected packed CLI file',
  );
  for (const skillFile of skillFiles)
    assert.equal(
      digest(
        execFileSync('tar', [
          '-xOzf',
          join(stage, file),
          `package/dist/skills/gcr-prevention/${skillFile}`,
        ]),
      ),
      digest(await readFile(join(root, 'skills/gcr-prevention', skillFile))),
      'Packed Skill differs from its source',
    );
  const packed = JSON.parse(
    execFileSync('tar', ['-xOzf', join(stage, file), 'package/package.json'], { encoding: 'utf8' }),
  );
  assert(!packed.dependencies && !packed.optionalDependencies && !packed.peerDependencies);
  for (const entry of clientManifest.packages)
    assert.equal(packed.devDependencies[entry.name], entry.version);
  assert.deepEqual(packed.bin, { gcr: 'dist/main.js' });
  const entries = [
    ...clientManifest.packages,
    {
      name: cli.name,
      version: cli.version,
      file,
      sha256: digest(await readFile(join(stage, file))),
    },
  ];
  const manifest = {
    schemaVersion: 1,
    sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    cliVersion: cli.version,
    clientVersion: client.version,
    packages: entries,
  };
  await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  if (args.includes('--verify')) {
    const consumer = join(stage, 'consumer');
    await mkdir(consumer);
    await writeFile(
      join(consumer, 'package.json'),
      '{"name":"gcr-cli-consumer","private":true,"type":"module"}\n',
    );
    run(
      'npm',
      ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(stage, file)],
      consumer,
    );
    const installed = join(consumer, 'node_modules/@gcr/cli/dist/main.js');
    const help = execFileSync(process.execPath, [installed, '--help'], {
      cwd: consumer,
      encoding: 'utf8',
    });
    assert(help.includes('Usage: gcr'));
    for (const file of skillFiles)
      assert.equal(
        digest(
          await readFile(join(consumer, 'node_modules/@gcr/cli/dist/skills/gcr-prevention', file)),
        ),
        digest(await readFile(join(root, 'skills/gcr-prevention', file))),
        'Installed Skill differs from its source',
      );
    const rejected = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { spawnSync } from 'node:child_process'; const r=spawnSync(process.execPath,[${JSON.stringify(installed)},'review','--mode','centralized'],{encoding:'utf8',windowsHide:true}); if(r.status!==2)process.exit(1); const v=JSON.parse(r.stdout); if(v.status!=='unavailable'||v.centralRequests!=='forbidden')process.exit(1); console.log('Installed CLI help and unavailable mode passed on '+process.version);`,
      ],
      { cwd: consumer, encoding: 'utf8' },
    );
    process.stdout.write(rejected);
    await rm(consumer, { recursive: true, force: true });
  }
  try {
    await rename(stage, output);
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    assert.deepEqual(
      await json(join(output, 'manifest.json')),
      manifest,
      'CLI artifact version exists with different content; increment its version',
    );
    for (const entry of entries)
      assert.equal(digest(await readFile(join(output, entry.file))), entry.sha256);
  }
  console.log(`CLI bundle: ${output}`);
  for (const entry of entries) console.log(`${entry.sha256}  ${entry.file}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
