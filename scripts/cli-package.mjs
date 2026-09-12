import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
assert(
  args.every((arg) => arg === '--verify'),
  'Usage: pnpm pack:cli [--verify]',
);
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const run = (command, argv, cwd = root) => execFileSync(command, argv, { cwd, stdio: 'inherit' });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cli = await json(join(root, 'apps/cli/package.json'));
const client = await json(join(root, 'packages/client-contract/package.json'));
assert.equal(cli.name, '@gcr/cli');
assert.equal(cli.engines.node, '>=22.0.0');
run(process.execPath, ['scripts/client-packages.mjs', ...args]);
await rm(join(root, 'apps/cli/dist'), { recursive: true, force: true });
run('pnpm', ['--filter', '@gcr/cli', 'build']);
await chmod(join(root, 'apps/cli/dist/main.js'), 0o755);
const clients = join(root, 'artifacts/client-packages', client.version);
const clientManifest = await json(join(clients, 'manifest.json'));
assert.equal(clientManifest.version, client.version);
const build = await json(join(root, 'apps/cli/dist/build-inputs.json'));
for (const output of Object.values(build.outputs))
  assert(
    output.imports.every((entry) => entry.external && entry.path.startsWith('node:')),
    'CLI bundle has a non-Node runtime import',
  );
for (const input of Object.keys(build.inputs)) {
  const absolute = resolve(root, 'apps/cli', input);
  if (absolute.startsWith(join(root, 'apps/cli/src') + '/')) {
    assert(!absolute.endsWith('.test.ts'));
    continue;
  }
  const entry = clientManifest.packages.find((entry) =>
    absolute.startsWith(join(root, 'packages', entry.name.slice(5), 'dist') + '/'),
  );
  assert(entry, 'CLI bundle includes code outside its three client libraries');
  const relative = absolute.slice(join(root, 'packages', entry.name.slice(5)).length + 1);
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
      /^package\/(?:dist\/main\.js|dist\/client-packages\.json|package\.json|LICENSE|NOTICE|README\.md)$/.test(
        entry,
      ),
    ),
    'Unexpected packed CLI file',
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
    const help = execFileSync(join(consumer, 'node_modules/.bin/gcr'), ['--help'], {
      cwd: consumer,
      encoding: 'utf8',
    });
    assert(help.includes('Usage: gcr'));
    const rejected = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { spawnSync } from 'node:child_process'; const r=spawnSync('./node_modules/.bin/gcr',['review','--mode','centralized'],{encoding:'utf8'}); if(r.status!==2)process.exit(1); const v=JSON.parse(r.stdout); if(v.status!=='unavailable'||v.centralRequests!=='forbidden')process.exit(1); console.log('Installed CLI help and unavailable mode passed on '+process.version);`,
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
