import { createPrivateKey, sign } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { ciValidationPayloadSchema } from '../packages/contracts/dist/index.js';
import { canonicalKnowledgeJson } from '../packages/client-contract/dist/index.js';

// Run only in an isolated, operator-controlled CI signer after validating its producer inputs.
// The private key must never be present in a job that executes pull request source.
const [payloadPath, keyPath, outputPath, ...extra] = process.argv.slice(2);
if (!payloadPath || !keyPath || !outputPath || extra.length) {
  throw Error(
    'Usage: node scripts/sign-ci-validation.mjs payload.json private-key.pem envelope.json',
  );
}
async function boundedFile(path, max) {
  const info = await stat(path);
  if (!info.isFile() || info.size > max) throw Error('CI signing input exceeds file limit');
  const bytes = await readFile(path);
  if (bytes.length > max) throw Error('CI signing input exceeds file limit');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
const payload = ciValidationPayloadSchema.parse(JSON.parse(await boundedFile(payloadPath, 60000)));
const key = createPrivateKey(await boundedFile(keyPath, 4096));
if (key.asymmetricKeyType !== 'ed25519') throw Error('Expected an Ed25519 CI signing key');
const signature = sign(
  null,
  Buffer.from('git-code-reviewer:ci-validation:v1\n' + canonicalKnowledgeJson(payload)),
  key,
).toString('base64url');
const bytes = JSON.stringify({ payload, signature });
if (Buffer.byteLength(bytes) > 60000) throw Error('Signed CI evidence exceeds check output limit');
await writeFile(outputPath, bytes, { flag: 'wx', mode: 0o600 });
