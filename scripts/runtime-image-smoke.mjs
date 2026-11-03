// Feed this file to the built image's `node --input-type=module` over stdin.
// It checks the actual filesystem and module resolution with no network access.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

assert.equal(process.getuid(), 1000);
const require = createRequire('/app/apps/runtime/package.json');
const versions = {
  static: require('@fastify/static/package.json').version,
  vitest: JSON.parse(await readFile('/app/node_modules/vitest/package.json', 'utf8')).version,
};
assert.equal(versions.static, '10.1.3');
assert.equal(versions.vitest, '4.1.11');
const folders = (await readdir('/app/node_modules/.pnpm')).filter((name) =>
  /^(vitest@|@vitest\+mocker@|@fastify\+static@)/.test(name),
);
assert.equal(folders.length, 3, 'Obsolete dependencies remain from the reused runtime image');
assert(
  folders.every(
    (name) =>
      name.startsWith('@fastify+static@10.1.3') ||
      name.startsWith('@vitest+mocker@4.1.11_') ||
      name.startsWith('vitest@4.1.11_'),
  ),
);
await assert.rejects(access('/run/secrets/build_ca'));
await assert.rejects(access('/app/.env'));
await assert.rejects(access('/app/.documents'));
const files = (await readdir('/app/apps/web/dist/assets')).filter((name) =>
  /\.(js|css)$/.test(name),
);
assert.equal(
  files.filter((name) => name.endsWith('.js')).length,
  1,
  'Obsolete browser bundles remain',
);
assert.equal(
  files.filter((name) => name.endsWith('.css')).length,
  1,
  'Obsolete browser styles remain',
);
const assets = Object.fromEntries(
  await Promise.all(
    files.map(async (name) => [
      name,
      createHash('sha256')
        .update(await readFile(path.join('/app/apps/web/dist/assets', name)))
        .digest('hex'),
    ]),
  ),
);
const Fastify = require('fastify');
const app = Fastify();
try {
  await app.register(require('@fastify/static'), {
    root: '/app/apps/web/dist',
    wildcard: false,
    index: false,
    immutable: true,
    maxAge: '1y',
  });
  for (const file of files) {
    const result = await app.inject(`/assets/${file}`);
    assert.equal(result.statusCode, 200);
    assert.equal(createHash('sha256').update(result.rawPayload).digest('hex'), assets[file]);
    assert(result.headers['cache-control'].includes('immutable'));
  }
  for (const url of ['/assets/../../package.json', '/assets/%2e%2e/%2e%2e/package.json', '/.env']) {
    assert.notEqual((await app.inject(url)).statusCode, 200);
  }
} finally {
  await app.close();
}
console.log(
  JSON.stringify(
    {
      status: 'passed',
      node: process.version,
      user: process.getuid(),
      versions,
      packageFolders: folders,
      assets,
      artifactChecks: [
        'no-obsolete-runtime-packages',
        'no-obsolete-browser-bundles',
        'public-asset-content-and-cache',
        'traversal-denied',
        'no-build-secret',
      ],
      network: 'none',
      rootFilesystem: 'read-only',
    },
    null,
    2,
  ),
);
