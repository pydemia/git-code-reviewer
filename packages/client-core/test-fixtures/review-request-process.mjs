// Synthetic process fixture: injected test keys, no account or model calls.
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { ReviewRequests } from '../dist/index.js';
process.once('message', async (input) => {
  let queue;
  try {
    const values = new Map(input.keys);
    queue = await ReviewRequests.open({
      scope: input.scope,
      dataDirectory: input.root,
      now: () => input.now,
      keys: {
        read: async (id) => (values.has(id) ? Buffer.from(values.get(id), 'base64') : undefined),
        write: async () => {
          throw Error('Fixture requires a preseeded key');
        },
        remove: async () => {
          throw Error('Fixture must preserve its key');
        },
      },
    });
    const row = await queue.enqueue(input.identity, input.reason);
    const claim = await queue.claim(row.key, { leaseMs: 1000 });
    if (claim.kind === 'acquired' && input.begin) await queue.begin(claim.lease, input.reason);
    process.send({
      kind: claim.kind,
      ...(claim.kind === 'acquired' ? { lease: claim.lease } : {}),
    });
  } catch (error) {
    process.send({ error: error.code ?? 'unexpected' });
  } finally {
    queue?.close();
  }
  // Keep the process alive until the parent deliberately terminates it.
  process.on('message', () => {});
});
