import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadClientConnectionCa } from './client-routes.js';

describe('public client connection trust configuration', () => {
  it('exports only explicit public CA certificates and never falls back to database CA', async () => {
    expect(await loadClientConnectionCa()).toBeNull();
    const pem = await readFile('deploy/environments/prism-dev/certs/development-ca.crt', 'utf8');
    const directory = await mkdtemp(path.join(tmpdir(), 'gcr-public-ca-'));
    const file = path.join(directory, 'ca.pem');
    try {
      await writeFile(file, pem);
      expect(await loadClientConnectionCa(file)).toBe(pem);
      for (const invalid of [pem + '\nPRIVATE KEY CANARY', 'not a certificate', pem.repeat(100)]) {
        await writeFile(file, invalid);
        await expect(loadClientConnectionCa(file)).rejects.toThrow(
          'must contain only public CA certificates',
        );
      }
      await expect(loadClientConnectionCa(path.join(directory, 'missing'))).rejects.toThrow(
        'CLIENT_CONNECTION_CA_FILE',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
