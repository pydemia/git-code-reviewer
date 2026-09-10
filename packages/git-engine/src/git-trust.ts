import { readFile, writeFile } from 'node:fs/promises';
import { rootCertificates } from 'node:tls';
import path from 'node:path';

export async function gitTrustEnvironment(
  directory: string,
  additionalCa = process.env.GIT_SSL_CAINFO,
): Promise<NodeJS.ProcessEnv> {
  if (!additionalCa) return {};
  const bundle = path.join(directory, 'git-ca-bundle.pem');
  const certificate = await readFile(additionalCa, 'utf8');
  await writeFile(bundle, [...rootCertificates, certificate].join('\n'), { mode: 0o400 });
  return { GIT_SSL_CAINFO: bundle };
}
