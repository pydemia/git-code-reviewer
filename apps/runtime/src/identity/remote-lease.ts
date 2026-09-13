import type { Database } from '@gcr/db';
import { KeycloakAdminError } from './keycloak-admin.js';

const lockNamespace = 13372027;
const maximumWorkMs = 90_000;
export interface IdentityRemoteLease {
  readonly assertHeld: () => void;
}

// A dedicated session lock serializes realm writes with event observations.
// No SQL transaction/row lock spans network I/O. The connection is always
// destroyed on release, so a failed unlock cannot leak ownership into the pool.
// Request guards stop new IdP I/O after connection loss or the bounded deadline;
// an already-started request retains its own <=10-second transport timeout.
export async function withIdentityRemoteLease<T>(
  database: Database,
  issuer: string,
  action: (lease: IdentityRemoteLease) => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; result: T }> {
  const client = await database.connect().catch(() => {
    throw new KeycloakAdminError('IDENTITY_ADMIN_UNAVAILABLE', true);
  });
  let acquired = false,
    lost = false;
  const lostConnection = () => {
    lost = true;
  };
  client.on('error', lostConnection);
  try {
    try {
      acquired = (
        await client.query<{ acquired: boolean }>(
          'select pg_try_advisory_lock($1,hashtext($2)) as acquired',
          [lockNamespace, issuer],
        )
      ).rows[0]!.acquired;
    } catch {
      throw new KeycloakAdminError('IDENTITY_ADMIN_UNAVAILABLE', true);
    }
    if (!acquired) return { acquired: false };
    const deadline = Date.now() + maximumWorkMs;
    const assertHeld = () => {
      if (lost || Date.now() >= deadline)
        throw new KeycloakAdminError('IDENTITY_ADMIN_UNAVAILABLE', true);
    };
    assertHeld();
    return { acquired: true, result: await action({ assertHeld }) };
  } finally {
    if (acquired && !lost)
      await client
        .query('select pg_advisory_unlock($1,hashtext($2))', [lockNamespace, issuer])
        .catch(() => undefined);
    client.off('error', lostConnection);
    client.release(true);
  }
}
