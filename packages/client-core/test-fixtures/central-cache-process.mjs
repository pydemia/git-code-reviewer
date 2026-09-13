// Synthetic process fixture. Only test-generated keys enter this injected port;
// production clients use their host's OS credential store.
import { CentralKnowledgeCache, TrustedCentralBinding } from '../dist/index.js';
let release;
let now;
const released = new Promise((resolve) => {
  release = resolve;
});
process.on('message', async (message) => {
  if (message.action === 'release') {
    now = message.now;
    release();
    return;
  }
  if (message.action !== 'start') return;
  now = message.now;
  let cache;
  try {
    const keys = new Map(message.keys);
    cache = await CentralKnowledgeCache.open({
      dataDirectory: message.root,
      scope: message.scope,
      binding: new TrustedCentralBinding({
        serverUrl: message.serverUrl,
        audience: message.manifest.payload.audience,
        trustedKeys: new Map([['key', message.publicKey]]),
      }),
      now: () => now,
      keys: {
        async read(id) {
          const value = keys.get(id);
          return value && Buffer.from(value, 'base64');
        },
        async write() {
          throw Error('Fixture must use an existing key reference');
        },
        async remove() {
          throw Error('Fixture must preserve key reference');
        },
      },
    });
    const result = await cache.synchronize({
      async manifest() {
        process.send({ event: 'manifest' });
        if (message.pause) await released;
        return { status: 200, manifest: message.manifest };
      },
      async bundle({ component }) {
        return {
          status: 200,
          body: (async function* () {
            yield Buffer.from(message.bytes[component], 'base64');
          })(),
        };
      },
    });
    process.send({ event: 'result', snapshotId: result.manifest.payload.snapshotId });
  } catch (error) {
    process.send({ event: 'result', code: error.code ?? 'unexpected' });
  } finally {
    cache?.close();
  }
});
