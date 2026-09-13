import {
  clientAuthConfigSchema,
  clientCredentialListSchema,
  clientCredentialIssuedSchema,
  clientCredentialSchema,
  clientCredentialInputSchema,
  type ClientCredentialInput,
} from '@gcr/contracts';
import { centralConnectionInput } from '@gcr/client-contract';
import { fetchJson, mutateJson } from './api.ts';

const base = '/api/v1/me/client-credentials';
export async function loadClientAuthConfig(signal: AbortSignal) {
  return clientAuthConfigSchema.parse(await fetchJson('/api/v1/client-auth/config', signal));
}
export async function loadClientCredentials(signal: AbortSignal, cursor?: string) {
  return clientCredentialListSchema.parse(
    await fetchJson(base + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''), signal),
  );
}
export async function issueClientCredential(input: ClientCredentialInput) {
  const issued = clientCredentialIssuedSchema.parse(
    await mutateJson(base, 'POST', clientCredentialInputSchema.parse(input)),
  );
  return { credential: clientCredentialSchema.strip().parse(issued), token: issued.token };
}
export async function revokeClientCredential(id: string) {
  await mutateJson(`${base}/${encodeURIComponent(id)}`, 'DELETE');
}
export async function loadClientConnectionConfig(repositoryId: string, signal: AbortSignal) {
  return centralConnectionInput(
    await fetchJson(
      `/api/v1/me/client-connection-config?repositoryId=${encodeURIComponent(repositoryId)}`,
      signal,
    ),
  );
}
