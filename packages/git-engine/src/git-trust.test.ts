import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { rootCertificates } from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { gitTrustEnvironment } from './git-trust.js';

it('retains public roots when adding an administrator configured corporate CA', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gcr-trust-'));
  try {
    const certificate = path.join(directory, 'corporate.pem');
    await writeFile(certificate, 'CORPORATE_CA_FIXTURE');
    const environment = await gitTrustEnvironment(directory, certificate);
    const bundle = await readFile(environment.GIT_SSL_CAINFO!, 'utf8');
    expect(bundle).toContain(rootCertificates[0]);
    expect(bundle).toContain('CORPORATE_CA_FIXTURE');
    expect((await stat(environment.GIT_SSL_CAINFO!)).mode & 0o777).toBe(0o400);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it('keeps Git defaults when no extra CA is configured', async () => {
  expect(await gitTrustEnvironment('/not-used', '')).toEqual({});
});
