import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = ['client-contract', 'client-core', 'client-executors'];
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--verify')) throw new Error('Usage: pnpm pack:clients [--verify]');
const run = (command, argv, cwd = root) =>
  execFileSync(command, argv, { cwd, stdio: 'inherit', env: process.env });
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const manifests = await Promise.all(
  packages.map((name) => json(join(root, 'packages', name, 'package.json'))),
);
const version = manifests[0].version;
const names = manifests.map((manifest) => manifest.name);
for (const [index, manifest] of manifests.entries()) {
  assert.equal(manifest.name, `@gcr/${packages[index]}`);
  assert.equal(manifest.version, version, 'Client packages must be released together');
  assert.equal(manifest.engines.node, '>=18.0.0');
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const dependency of Object.keys(manifest[field] ?? {})) {
      assert.equal(
        dependency,
        '@gcr/client-contract',
        `Unexpected client dependency: ${dependency}`,
      );
      assert.notEqual(manifest.name, '@gcr/client-contract', 'Contract must be dependency-free');
    }
  }
  await rm(join(root, 'packages', packages[index], 'dist'), { recursive: true, force: true });
}
run('pnpm', ['build:clients']);

const output = join(root, 'artifacts', 'client-packages', version);
await mkdir(dirname(output), { recursive: true });
const stage = await mkdtemp(join(dirname(output), '.pack-'));
try {
  const entries = [];
  for (const [index, name] of packages.entries()) {
    run('pnpm', ['pack', '--pack-destination', stage], join(root, 'packages', name));
    const file = `gcr-${name}-${version}.tgz`;
    const bytes = await readFile(join(stage, file));
    const listing = execFileSync('tar', ['-tzf', join(stage, file)], { encoding: 'utf8' })
      .trim()
      .split('\n');
    assert(
      listing.every((entry) =>
        /^package\/(?:dist\/[^/]+\.(?:js|d\.ts)(?:\.map)?|package\.json|LICENSE|README\.md)$/.test(
          entry,
        ),
      ),
      'Unexpected packed file',
    );
    const packed = JSON.parse(
      execFileSync('tar', ['-xOzf', join(stage, file), 'package/package.json'], {
        encoding: 'utf8',
      }),
    );
    for (const [dependency, requirement] of Object.entries(packed.dependencies ?? {})) {
      assert(names.includes(dependency));
      assert.equal(requirement, version, 'Packed dependencies must use exact versions');
    }
    entries.push({
      name: manifests[index].name,
      version,
      file,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const manifest = { schemaVersion: 1, version, packages: entries };
  await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  if (args.includes('--verify')) {
    const consumer = join(stage, 'consumer');
    await mkdir(consumer);
    await writeFile(
      join(consumer, 'package.json'),
      '{"name":"gcr-clean-consumer","private":true,"type":"module"}\n',
    );
    run(
      'npm',
      [
        'install',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        ...entries.map((entry) => join(stage, entry.file)),
      ],
      consumer,
    );
    const smoke = `import assert from 'node:assert/strict';
import { clientContractPackage } from '@gcr/client-contract';
import { clientCorePackage } from '@gcr/client-core';
import { clientExecutorsPackage } from '@gcr/client-executors';
for (const info of [clientContractPackage, clientCorePackage, clientExecutorsPackage]) {
  assert.equal(info.version, ${JSON.stringify(version)});
  assert.equal(info.contractVersion, 1);
}
console.log('Clean consumer imports passed on ' + process.version);
`;
    await writeFile(join(consumer, 'smoke.mjs'), smoke);
    run(process.execPath, ['smoke.mjs'], consumer);
    // Test an installed minimum-runtime binary without downloading or changing the host Node.
    if (process.env.GCR_CLIENT_MIN_NODE)
      run(process.env.GCR_CLIENT_MIN_NODE, ['smoke.mjs'], consumer);
    await rm(consumer, { recursive: true, force: true });
  }
  await mkdir(dirname(output), { recursive: true });
  try {
    await rename(stage, output);
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    assert.deepEqual(
      await json(join(output, 'manifest.json')),
      manifest,
      'Artifact version already exists with different content; increment package versions',
    );
    for (const entry of entries) {
      const existing = await readFile(join(output, entry.file));
      assert.equal(
        createHash('sha256').update(existing).digest('hex'),
        entry.sha256,
        'Existing artifact was modified',
      );
    }
  }
  console.log(`Client artifacts: ${output}`);
  for (const entry of entries) console.log(`${entry.sha256}  ${basename(entry.file)}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
