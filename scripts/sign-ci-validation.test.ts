import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { keys, input, policy, payload } from '../apps/runtime/test/trusted-ci-fixtures.js';
import { verifyCiEvidence } from '../apps/runtime/src/services/trusted-ci-verifier.js';
const execute = promisify(execFile);
it('signs a bounded payload with the standalone CI utility and refuses output overwrite', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gcr-ci-sign-'));
  try {
    const file = path.join(dir, 'payload.json'),
      key = path.join(dir, 'key.pem'),
      out = path.join(dir, 'envelope.json');
    await writeFile(file, JSON.stringify(payload()));
    await writeFile(key, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const args = [path.resolve('scripts/sign-ci-validation.mjs'), file, key, out];
    const result = await execute(process.execPath, args);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    expect(verifyCiEvidence(JSON.parse(await readFile(out, 'utf8')), input, policy).status).toBe(
      'verified',
    );
    await expect(execute(process.execPath, args)).rejects.toThrow('EEXIST');
    await writeFile(file, ' '.repeat(60001));
    await expect(
      execute(process.execPath, [...args.slice(0, -1), path.join(dir, 'second.json')]),
    ).rejects.toThrow('limit');
    await expect(stat(path.join(dir, 'second.json'))).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
